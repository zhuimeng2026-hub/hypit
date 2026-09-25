# MiniMax 文生图调用流程

来源：wangge-gpt-image-2-5（`server/minimax.go` + `server/handlers.go`）

## 入口

`POST /api/generate` —— JWT 鉴权（`AuthRequired`）。

### 请求体

```json
{
  "card_id": "EC01",
  "variables": {"{{主体}}": "杯子"},
  "variant": "变体名（可空）",
  "aspect_ratio": "1:1",
  "n": 1,
  "model": "image-01",
  "prompt_optimizer": true
}
```

## 服务端流程

1. `recordTaskStart` —— 写内存 ring buffer（任务追踪）
2. 选 prompt：默认 `card.DefaultPrompt`，或指定 `variant.Prompt`
3. `AdaptPrompt(src, variables)` —— 占位符替换
4. `ratio` 空 → 用 `card.AspectRatio`
5. `optimizer` 指针 nil → 默认 `true`
6. `n ≤ 0` → `1`，`n > 4` → `4`
7. 调 `GenerateImage(cfg, prompt, ratio, n, model, opt)`

## HTTP 出站

| 项 | 值 |
| --- | --- |
| URL | `{MINIMAX_BASE_URL}/v1/image_generation` |
| Method | `POST` |
| Auth | `Authorization: Bearer <MINIMAX_API_KEY>` |
| Content-Type | `application/json` |
| 连接超时 | 10s |
| 整体超时 | `MINIMAX_TIMEOUT_SECONDS`（默认 180s） |

### 出站 body

```json
{
  "model": "<model or MINIMAX_DEFAULT_MODEL>",
  "prompt": "...",
  "aspect_ratio": "1:1|16:9|9:16|3:2|2:3|4:3|3:4|21:9",
  "response_format": "url",
  "n": 1..4,
  "prompt_optimizer": true|false
}
```

### 响应解析

- 错误：`base_resp.status_code != 0` → `MiniMaxError`
- 取 `data.image_urls`；空 → 降级 `data.image_base64` → `data:image/png;base64,...`
- 仍空 → `MiniMax 未返回图片`

### 返回结构

```json
{
  "card_id": "EC01",
  "variant": "...",
  "adapted_prompt": "...",
  "aspect_ratio": "1:1",
  "image_urls": ["https://..."],
  "metadata": {
    "model": "image-01",
    "aspect_ratio": "1:1",
    "n": 1,
    "elapsed_seconds": 42.1,
    "raw_status": 200
  }
}
```

失败：HTTP 502，`detail: "MiniMax 调用失败：..."`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MINIMAX_BASE_URL` | `https://api.minimaxi.com` | API base |
| `MINIMAX_API_KEY` | （必填） | Bearer token |
| `MINIMAX_DEFAULT_MODEL` | `image-01` | 默认模型 |
| `MINIMAX_TIMEOUT_SECONDS` | `180` | 整体超时（image-01 CPU 重，30~150s 常见） |

## 支持比例

`1:1`, `16:9`, `9:16`, `3:2`, `2:3`, `4:3`, `3:4`, `21:9` —— 不在表中 → 强制回退 `1:1`。

## 任务追踪

`/api/admin/tasks?limit=50` —— 内存 ring buffer 读最近任务（无鉴权，仅运维内网）。
字段：`card_id / variant / aspect_ratio / status / elapsed / image_urls / prompt / error`。