# TODO — Studio 网络嵌入

状态：**Phase 1（只读预览）与 Phase 2（基于 Token 的写入鉴权 + SSE 桥）均已交付**。Phase 3（多租户 domain 池）已规划但未启动。

## 背景

`hypit studio` 已经在 `http://localhost:5179/__studio/*` 上提供了完整的只读预览 HTTP API：

| 路径 | 用途 |
|---|---|
| `GET /__studio/visual.html` | 物化的 HyperFrames HTML，含 Studio 帧驱动与音频 shim |
| `GET /__studio/session` | 完整 `StudioSnapshot`（revision、源文件、tracks、语义时间线、preview srcdoc、provenance） |
| `GET /__studio/document` | 编译后的 `HyperframesDocument` JSON |
| `GET /__studio/material/<id>` | 资源字节（支持 Range） |
| `GET /__studio/storyboard/<id>` | PNG 故事板图集（自定义头 `x-hypit-storyboard-*`） |
| `GET /__studio/library` | Runtime 活动 + Result repository 视图 |
| `GET /__studio/locales` | 语言包 |
| `GET /__studio/surface-preview` | 包声明的 surface 预览 |
| `GET /__studio/artifact` | 构建产物字节 |
| `GET /__studio/feedback` | 对 `FEEDBACK.json` 的只读访问 |

这个 API 一直可用，只是从 Studio UI 之外访问不到。唯一的阻碍是 Vite `server.listen()` 没有传 `host:`，并且响应里没有 CORS / `frame-ancestors` 头。写端点（`PUT /__studio/source`、`PUT /__studio/artifact-name`、`POST /__studio/mutation`、`POST /__studio/feedback`）由 `allowsStudioMutation`（`packages/studio/src/mutation-origin.ts:1-20`）保护，非 loopback 一律返回 403。Phase 1 不动这道闸。

`packages/video-cli/src/snapshot.ts:60-67, 109-152` 早就用纯 HTTP 消费 `GET /__studio/document` 和 `GET /__studio/material/<resource>`，证明这些端点本身就是稳定的外部契约。

## 阶段划分

| 阶段 | 范围 | 状态 |
|---|---|---|
| 1 | 绑定到可路由地址；加 CORS + `frame-ancestors`，让第三方页面能嵌入预览。只读。 | **已交付** |
| 2 | 用 Bearer Token 替换 loopback 写入闸；加 SSE 桥，把 snapshot/error/feedback 事件推给外部客户端（不必再轮询）。 | **已交付** |
| 3 | 把单例 `StudioDomain` / `StudioBuildLibrary` 换成按 session 索引的 Map，让一个 Studio 进程承载多个项目。 | **已交付** |

## Phase 1 — 改动清单

### 新增环境变量

```
HYPIT_STUDIO_HOST=0.0.0.0          # 绑定地址；默认未设置（仅 loopback）
HYPIT_STUDIO_PUBLIC_ORIGINS=...    # 逗号分隔的 origin 白名单或 "*"；
                                   # 默认未设置 = 无跨域访问
HYPIT_STUDIO_TOKEN=...             # 授权跨域写入的 Bearer Token；
                                   # 默认未设置 = 自动生成 + 启动时打印一次
```

`HYPIT_STUDIO_HOST` 与 `HYPIT_STUDIO_PUBLIC_ORIGINS` 是 Phase 1 的语义，未变：

- `HYPIT_STUDIO_HOST` 未设置 → Vite 绑 loopback（默认）。
- `HYPIT_STUDIO_PUBLIC_ORIGINS` 未设置 → 不下发 CORS、不下发 `frame-ancestors`。浏览器拦第三方嵌入与 XHR。
- `"*"` → 所有 `/__studio/*` GET 返回 `Access-Control-Allow-Origin: *`，`visual.html` 返回 `Content-Security-Policy: frame-ancestors *`。完全开放。
- `"https://a.com,https://b.com"` → CORS 仅回显匹配的 origin；`frame-ancestors` 用同样的列表。严格白名单。

`HYPIT_STUDIO_TOKEN` 是 Phase 2 新增：

- 未设置 → 启动时生成 32 字符 URL-safe 随机 token，在横幅打印一次。**不持久化**；Studio 重启会换新。
- 已设置 → 原样使用。需要跨重启稳定的 token 时由运维显式固定。

Token 用于授权跨域写（`PUT /__studio/source`、`PUT /__studio/artifact-name`、`POST /__studio/mutation`、`POST /__studio/feedback`），调用方须带 `Authorization: Bearer <token>`。本地 Studio UI 仍走 loopback 闸，**无需 token**——两路检查在 `allowsStudioMutationWithToken`（`packages/studio/src/mutation-origin.ts:31-49`）里是 OR 关系，互相独立。

启动横幅会打印当前生效的值，运维一眼能确认配置。

### 文件改动

| 文件 | 改动 |
|---|---|
| `packages/studio/src/cors.ts` *(新增)* | 纯模块：`parsePublicOrigins`、`corsHeaders`、`frameAncestors`、`studioCorsMiddleware` |
| `packages/studio/src/sse.ts` *(新增，Phase 2)* | `SseHub` pub/sub + `SSE_RESPONSE_HEADERS`；`'close'` 事件自动剔除订阅者；Phase 3 加可选 `workspaceId` 戳 |
| `packages/studio/src/workspace-registry.ts` *(新增，Phase 3)* | `WorkspaceSession`（按 workspace 的编译状态 + handler）+ `WorkspaceRegistry`（懒加载 Map + LRU 淘汰）+ `workspaceIdFor()` |
| `packages/studio/test/cors.test.ts` *(新增)* | 9 个用例：配置解析、Header 生成、中间件顺序、OPTIONS 预检 |
| `packages/studio/test/sse.test.ts` *(新增，Phase 2)* | 7 个用例：Header 形态、广播分发、关闭清理、取消订阅、Hub 关闭 |
| `packages/studio/test/workspace-registry.test.ts` *(新增，Phase 3)* | 8 个用例：id 派生、懒创建、同 id 去重、LRU 淘汰、并发获取去重、`close()` 拆解、`lastUsed` 续命 |
| `packages/studio/src/server.ts` | `StudioPluginOptions.corsConfig`（默认 `{ mode: "none" }`）—— Phase 1。Phase 2 加 `authToken` + `sseHub`。Phase 3 改成薄分发器；按 workspace 的状态挪到 `WorkspaceSession`。新增选项 `workspaces`、`defaultWorkspaceId`、`loader`。 |
| `packages/studio/src/feedback-server.ts` | `studioFeedbackPlugin` 接受可选 `corsConfig`（Phase 1）+ `authToken` + `sseHub`（Phase 2）。Phase 3 让 feedback 按 workspace 走：按 `workspaceId` 懒创建 `FeedbackStore` + `FEEDBACK.json` 监听器。 |
| `packages/studio/src/mutation-origin.ts` | 在 `allowsStudioMutation` 旁新增 `allowsStudioMutationWithToken`。loopback 检查是第一路，Bearer Token 常数时间比对是第二路，任一通过即放行。 |
| `packages/studio/start.ts` | 读 `HYPIT_STUDIO_HOST` + `HYPIT_STUDIO_PUBLIC_ORIGINS`（Phase 1）和 `HYPIT_STUDIO_TOKEN`（Phase 2）。Phase 3 加 `HYPIT_STUDIO_WORKSPACES` / `HYPIT_STUDIO_DEFAULT_WORKSPACE` / `HYPIT_STUDIO_MAX_WORKSPACES`。构造 `Map<workspaceId, WorkspaceSpec>`，逐个通过 `WorkspaceRegistry.acquire` 预热，把 workspace Map + loader 透传给两个 plugin。帮助文本同步每个变量。 |
| `packages/studio/test/mutation-origin.test.ts` | `allowsStudioMutationWithToken` 新增 3 个用例（loopback 路径、合法 Token、非法 Token）；既有 feedback 测试改用新的 plugin 签名 |

### 为什么安全

第三方页面用 `<iframe sandbox="allow-scripts allow-same-origin" src="https://studio.example.com/__studio/visual.html">` 加载的 HTML，跟 Studio UI 自己用 `<iframe srcdoc=...>` 加载的视觉文档完全一致。iframe 的实际 origin 就是 studio 主机，于是：

- iframe 可以 fetch `/__studio/material/<id>`（同源）。
- 父页面（第三方）读不到 iframe 的 DOM。
- iframe 读不到父页面的 DOM。
- iframe 无法导航父页面。
- 这些请求不发 cookie、不带凭证、不携带用户态。

Phase 1 只是放宽了网络可达性，没有放宽信任边界。对比 localhost Studio UI，没有任何新增的攻击面。

## 嵌入方参考代码

### 1. 嵌入 `<iframe>`（最简单）

Studio 在 `/__studio/visual.html` 输出完全自包含的 HTML 文档。把下面这段贴进任意第三方页面：

```html
<iframe
  src="https://studio.example.com/__studio/visual.html"
  sandbox="allow-scripts allow-same-origin"
  allow="autoplay"
  width="1280" height="720"
  style="border:0"
></iframe>
```

要点：
- `sandbox="allow-scripts allow-same-origin"` 必填：runtime shim（`packages/studio/src/preview/runtime-shim.ts`）需要同源 fetch `/__studio/material/<id>`。缺了 `allow-same-origin`，iframe origin 变成 `null`，跨域拦截资源加载。
- `allow="autoplay"` 让 `<audio class="hypit-studio-audio">` 能播放；少了它用户得先点一下。
- 无论如何，音频都得用户手势触发（浏览器自动播放策略）。

### 2. 轮询 `/__studio/session`（自定义 UI）

不想用 iframe，可以拉 JSON snapshot 自己渲染：

```js
async function pollStudio() {
  const r = await fetch("https://studio.example.com/__studio/session", {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Studio ${r.status}`);
  const snapshot = await r.json();
  // snapshot.preview 与 Studio 注入 iframe 的 srcdoc 一致。
  // 资源 URL 是 studio 主机上的 /__studio/material/<id>。
  return snapshot;
}
setInterval(pollStudio, 2000);
```

`preview` 字段就是 `<iframe>` 端点返回的同一份 HTML。资源相对 URL 在 studio 主机上解析。如果不要 Studio 的帧驱动，直接复用 `/__studio/material/<id>` 放到自己的 `<video>` / `<audio>` / `<img>` 即可。

### 3. 直接拉 `/__studio/material/<id>`

资源字节支持 `Accept-Ranges: bytes`，可直接用于自己的媒体标签。`snapshot.preview` 里的 `media` 数组告诉你哪个 `<video>` 属于哪个 `<div class="hypit-visual-present">`。

### 4. 订阅 `/__studio/events`（Phase 2）

所有 `studio:snapshot`、`studio:error`、`studio:feedback-changed` 事件都通过 Server-Sent Events 广播：

```js
const source = new EventSource("https://studio.example.com/__studio/events");
source.addEventListener("studio:snapshot", (e) => {
  const snapshot = JSON.parse(e.data);
  // 跟 GET /__studio/session 的 payload 一致。
  renderPreview(snapshot);
});
source.addEventListener("studio:error", (e) => {
  const failure = JSON.parse(e.data);
  showError(failure.error);
});
source.addEventListener("studio:feedback-changed", () => {
  // 评论变了，重新拉 GET /__studio/feedback。
});
```

要点：
- 流是常开的，服务端到页面关闭才结束。前面的反代**不要**缓存它（响应头已经带了 `X-Accel-Buffering: no`）。
- 事件名跟 Vite HMR WebSocket（`server.ts:192, 202, 459, 465`）一致，自定义 UI 和本地 Studio UI 始终同步。

### 5. 跨域写入（Phase 2）

`HYPIT_STUDIO_TOKEN` 配置好之后（显式设值或采用启动横幅里的自动生成值），第三方页面就能直接驱动 Studio 改动：

```js
async function studioFetch(path, body) {
  const r = await fetch(`https://studio.example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${STUDIO_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Studio ${r.status}: ${await r.text()}`);
  return r.json();
}

// 触发一次 timeline 手势：
const { revision } = await studioFetch("/__studio/mutation", {
  type: "timeline.adjust",
  revision: snapshot.revision,
  entityId: "clip-7",
  gesture: "move",
  target: { kind: "window", startFrame: 240, endFrameExclusive: 360 },
});
```

Token 必须经由安全通道下发到页面（后端 session、签名 cookie、mTLS 等），**不要**直接打进公开客户端 JS。

## 反向代理示例

Studio 只起明文 HTTP，TLS 终止交给代理。代理不要自己加 CORS 头——让 Studio 的中间件做这件事，但必须把 `Origin` 和（material 的）`Range` 原样转发。

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name studio.example.com;

  ssl_certificate     /etc/letsencrypt/live/studio.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/studio.example.com/privkey.pem;

  # Studio 明文跑在 :5179。
  location / {
    proxy_pass http://127.0.0.1:5179;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Origin 必须原样转发，Studio 的 CORS 中间件才能对照 HYPIT_STUDIO_PUBLIC_ORIGINS 匹配。
    proxy_pass_header Origin;
    # material/ 支持 Range，让 nginx 透传。
    proxy_set_header Range $http_range;
    proxy_no_cache 1;
    add_header Cache-Control "no-store";
  }
}
```

### Caddy

```caddyfile
studio.example.com {
  reverse_proxy 127.0.0.1:5179 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    # Caddy 默认透传 Origin，不要去掉它。
  }
}
```

## 运维手册

### 本地开发（不变）

```
pnpm studio --run runs/main.svrun
# → http://localhost:5179
```

### 单租户网络嵌入

```
HYPIT_STUDIO_HOST=0.0.0.0 \
HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test,https://staging.myapp.test \
pnpm studio --run runs/main.svrun --port 5179

# 冒烟测 CORS / frame-ancestors 策略：
curl -sI -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/visual.html | grep -iE 'access-control|content-security-policy'
# 期望：
#   access-control-allow-origin: https://myapp.test
#   access-control-max-age: 86400
#   vary: Origin
#   content-security-policy: frame-ancestors https://myapp.test https://staging.myapp.test

# 不在白名单的 origin 直接被静默忽略：
curl -sI -H "Origin: https://other.test" \
  http://localhost:5179/__studio/visual.html | grep -i access-control-allow-origin
# 期望：无输出。

# OPTIONS 预检：
curl -sI -X OPTIONS -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/visual.html
# 期望：HTTP/1.1 204 No Content，带同样的 CORS 头。

# 写端点仍然被拒（loopback 闸未动）：
curl -sI -X PUT -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/source
# 期望：HTTP/1.1 403 Forbidden。
```

### 验证

```
pnpm test                                          # 全量默认测试
pnpm test -- packages/studio/test/cors.test.ts
pnpm test -- packages/studio/test/sse.test.ts
pnpm test -- packages/studio/test/mutation-origin.test.ts
pnpm test -- packages/studio/test/workspace-registry.test.ts
```

### Phase 2 冒烟（手动）

```
HYPIT_STUDIO_HOST=0.0.0.0 \
HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test \
pnpm studio --run runs/main.svrun --port 5179

# 启动横幅会打印生效值，包含自动生成的 Write token（或 HYPIT_STUDIO_TOKEN 设的值）：
#
#   Bind host          0.0.0.0
#   Public origins     https://myapp.test
#   Write token        9b3X...yq  (auto-generated for this session)
#   Embed SSE          GET /__studio/events  (snapshot / error / feedback-changed)

# 带 Token 的跨域写被接受：
TOKEN=9b3X...yq
curl -s -X PUT -H "Origin: https://myapp.test" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:5179/__studio/source \
  --data '{"text":"<svml/>","revision":1}'
# 期望：HTTP/1.1 202 Accepted

# Token 错或缺失仍 403：
curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/source --data '{"text":"x","revision":1}'
# 期望：403

# SSE 桥可达，并以 keep-alive 注释开头：
curl -sN -H "Origin: https://myapp.test" http://localhost:5179/__studio/events | head -5
# 期望：
#   : ok
#   （有事件发布时再追加 event/data 帧）
```

## Phase 3 — 改动清单

### URL 约定（workspace 选择器）

按 workspace 寻址的端点都把 workspace id 放在路径前缀里；唯一的全局端点是 SSE 流。

| 之前（Phase 1/2） | 之后（Phase 3） |
|---|---|
| `GET /__studio/session` | `GET /__studio/<workspaceId>/session` |
| `POST /__studio/mutation` | `POST /__studio/<workspaceId>/mutation` |
| `GET /__studio/visual.html` | `GET /__studio/<workspaceId>/visual.html` |
| `GET /__studio/material/<id>` | `GET /__studio/<workspaceId>/material/<id>` |
| `GET /__studio/feedback` | `GET /__studio/<workspaceId>/feedback` |
| `GET /__studio/events` | `GET /__studio/events` *(不变)* |

`workspaceId` = `base64url(absoluteWorkspaceRootPath)`。同一 workspace 根路径 → 同一 id（确定性、URL-safe，不含 `:` `/` 填充符）。

### 新增环境变量

```
HYPIT_STUDIO_WORKSPACES=<rootA>::<runA>,<rootB>::<runB>  # 预注册 workspace 列表
HYPIT_STUDIO_DEFAULT_WORKSPACE=<root>                   # 裸 /__studio/<rest> 落点
HYPIT_STUDIO_MAX_WORKSPACES=8                          # LRU 上限（默认 8）
```

`HYPIT_STUDIO_WORKSPACES` 在多租户场景下取代 `--run`。逗号分隔；每条 `<workspaceRoot>::<runPath>`，两者都相对当前目录解析。未设置时，沿用 `--run` + `--workspace`，得到长度为 1 的列表（单租户兼容）。

`HYPIT_STUDIO_DEFAULT_WORKSPACE` 决定裸路径 `/__studio/<rest>` 落到哪个已注册 workspace。未设置时，默认是第一个注册的 workspace。

`HYPIT_STUDIO_MAX_WORKSPACES` 限制 LRU 池大小。新 workspace 进来会让池超限时，最久未用的 session 的 build library 和文件监听器会被关闭，从 Map 中移除。

### SSE 按 workspace 解多路

`/__studio/events` 是单一的全局 SSE 流；每条事件 payload 多一个 `workspaceId` 字段，嵌入方可以按 id 分流：

```js
source.addEventListener("studio:snapshot", (e) => {
  const { workspaceId, ...snapshot } = JSON.parse(e.data);
  if (workspaceId !== myWorkspace) return;
  renderPreview(snapshot);
});
```

Hub 本身仍是单个 `SseHub` 实例（`packages/studio/src/sse.ts`）。`broadcast(event, data, workspaceId)` 顺手把 id 戳到 payload 上，分发结构不动。

### 文件改动

| 文件 | 改动 |
|---|---|
| `packages/studio/src/workspace-registry.ts` *(新增)* | `WorkspaceSession`（按 workspace 的编译状态 + handler）+ `WorkspaceRegistry`（懒加载 Map + LRU 淘汰）。Phase 1/2 `studioPlugin` 函数体的主体搬到这里，`let foo` 改成 `this.#foo`。 |
| `packages/studio/test/workspace-registry.test.ts` *(新增)* | 8 个用例：id 派生、懒创建、同 id 去重、LRU 淘汰、并发获取去重、`close()` 拆解、`lastUsed` 续命 |
| `packages/studio/src/server.ts` | 现在是薄分发器。`StudioPluginOptions` 新增 `workspaces` / `defaultWorkspaceId` / `loader`。URL 解析识别 `/__studio/<id>/<rest>` 与裸路径回退。原来按请求的 handler 整体迁到 `WorkspaceSession.handleRequest`。 |
| `packages/studio/src/feedback-server.ts` | 按 workspace 各自维护 `FeedbackStore` + 监听器，首次请求时懒创建。URL 前缀按 `studioPlugin` 同款方式解析 workspaceId。监听器把 `studio:feedback-changed` 通过 SSE hub 广播（事件携带 `workspaceId`）。 |
| `packages/studio/src/sse.ts` | `SseHub.broadcast(event, data, workspaceId?)` 在传入 `workspaceId` 时把 payload 包成 `{ workspaceId, ...data }`。 |
| `packages/studio/start.ts` | 读 `HYPIT_STUDIO_WORKSPACES` / `HYPIT_STUDIO_DEFAULT_WORKSPACE` / `HYPIT_STUDIO_MAX_WORKSPACES`；构建 `Map<workspaceId, WorkspaceSpec>`；逐个通过 `WorkspaceRegistry.acquire` 预热，让首次请求不付冷启动代价；把 workspace Map + loader 透传给两个 plugin。帮助文本同步每个变量。 |

### 兼容性

| 嵌入方 | 之前 | 之后 |
|---|---|---|
| `pnpm studio --run runs/foo.svrun --workspace ./foo`（本地 Studio UI） | 可用 | **可用**（单租户兼容；该 run 变成默认 workspace） |
| Phase 2 嵌入方继续用裸 `/__studio/visual.html` | 可用 | **可用，前提是**设置了 `--run` 或 `HYPIT_STUDIO_DEFAULT_WORKSPACE` |
| 嵌入方用 `/__studio/<id>/<rest>` | n/a | **可用**（新的主路径） |
| 裸 `/__studio/<rest>` 但没设默认 | 404 | **404**（严格 —— 见 Phase 1 文档） |

### 嵌入方参考代码（Phase 3）

**两个 workspace 并排展示，各自一个 iframe：**

```html
<iframe src="https://studio.example.com/__studio/L0FwcHMvbWUvcHJvai9mb28/visual.html"
        sandbox="allow-scripts allow-same-origin"
        width="640" height="360"></iframe>
<iframe src="https://studio.example.com/__studio/L0FwcHMvbWUvcHJvai9iYXI/visual.html"
        sandbox="allow-scripts allow-same-origin"
        width="640" height="360"></iframe>
```

**SSE 按 workspace id 解多路：**

```js
const source = new EventSource("https://studio.example.com/__studio/events");
const snapshots = new Map();
source.addEventListener("studio:snapshot", (e) => {
  const { workspaceId, ...snapshot } = JSON.parse(e.data);
  snapshots.set(workspaceId, snapshot);
  render(); // 每个 iframe 用自己的 snapshot 重绘
});
source.addEventListener("studio:error", (e) => {
  const { workspaceId, error } = JSON.parse(e.data);
  showError(workspaceId, error);
});
source.addEventListener("studio:feedback-changed", (e) => {
  const { workspaceId } = JSON.parse(e.data);
  refetchFeedback(workspaceId);
});
```

**向特定 workspace 发跨域写：**

```js
const WS = "L0FwcHMvbWUvcHJvai9mb28";
await fetch(`https://studio.example.com/__studio/${WS}/mutation`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${STUDIO_TOKEN}`,
  },
  body: JSON.stringify({
    type: "parameter.adjust",
    revision: snapshots.get(WS).revision,
    entityId: "clip-3",
    parameterId: "caption-size",
    value: "large",
  }),
});
```

### 运维手册（多租户）

```bash
# 预注册两个 workspace。
export HYPIT_STUDIO_WORKSPACES="/Users/me/proj/foo::runs/foo.svrun,/Users/me/proj/bar::runs/bar.svrun"
export HYPIT_STUDIO_DEFAULT_WORKSPACE=/Users/me/proj/foo
export HYPIT_STUDIO_HOST=0.0.0.0
export HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test
export HYPIT_STUDIO_MAX_WORKSPACES=8
# HYPIT_STUDIO_TOKEN 启动时自动生成 + 横幅打印。

pnpm studio --port 5179

# 横幅会列出每个 workspace 及其 base64url id：
#
#   Project            /Users/me/proj/foo
#   Workspaces         2 registered (max 8, LRU evicted)
#     L0FwcHMvbWUvcHJvai9mb28  /Users/me/proj/foo
#     L0FwcHMvbWUvcHJvai9iYXI  /Users/me/proj/bar
#   Default workspace  L0FwcHMvbWUvcHJvai9mb28
#   Bind host          0.0.0.0
#   Public origins     https://myapp.test
#   Write token        9b3X...yq  (auto-generated for this session)
#   Embed SSE          GET /__studio/events  (snapshot / error / feedback-changed; events tagged with workspaceId)
```

```bash
# 验证多租户 session 隔离。
curl -sN http://localhost:5179/__studio/L0FwcHMvbWUvcHJvai9mb28/session | jq .revision
curl -sN http://localhost:5179/__studio/L0FwcHMvbWUvcHJvai9iYXI/session | jq .revision

# SSE 给每条事件贴上 workspaceId：
curl -sN http://localhost:5179/__studio/events | head -10
# 期望：
#   : ok
#   event: studio:snapshot
#   data: {"workspaceId":"L0FwcHMvbWUvcHJvai9mb28","revision":1,…}
#   event: studio:snapshot
#   data: {"workspaceId":"L0FwcHMvbWUvcHJvai9iYXI","revision":1,…}

# 未知的 workspaceId → 404。
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:5179/__studio/ws_unknown/session
# 期望：404
```