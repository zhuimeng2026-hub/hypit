# Hypit 内部镜像（LAN 自托管）

把 `hypit` 在 Win10 / macOS / Linux 客户端跑起来所需的全部第三方依赖都镜像到本机房，
让客户端永远只走 `http://192.168.20.173:<port>`，不再访问公网。

镜像栈：

| 用途 | 服务 | 镜像 | 端口（默认） | 客户端写入位置 |
|---|---|---|---|---|
| npm / pnpm | Verdaccio | verdaccio/verdaccio:6 | **4873** | `~/.npmrc` 的 `registry=` |
| PyPI（uv 拉包） | devpi | ghcr.io/hesch/devpi:6.13.0 | **4874** | `~/.config/uv/uv.toml` 的 `[index].url` |
| Chrome Headless Shell | nginx | nginx:1.27-alpine | **8088** | `hypit.runtime.json` 的 `browserDownloadBaseUrl` |
| ffmpeg / ffprobe | nginx | nginx:1.27-alpine | **8089** | `PATH` 或 `hypit.runtime.json` 的 `ffmpegPath`/`ffprobePath` |
| 本机 whisperx 暴露 | socat | alpine/socat | **18765** → 127.0.0.1:8765 | `provider-whisperx-local` 的 endpoint `baseUrl` |

`whisperx-lan-proxy` 是 `network_mode: host`，直接把宿主机的 `127.0.0.1:8765`
（即本机已运行的 `hypit-whisperx` 进程）通过 `0.0.0.0:18765` 暴露到 LAN。

## 服务端一次性搭建

```bash
cd /opt/hypit/utils

cp .env.example .env                 # 修改 HYPIT_LAN_HOST 与端口（如果冲突）
docker compose pull
docker compose up -d verdaccio devpi chrome-mirror ffmpeg-mirror whisperx-lan-proxy

# 一次性下载 chrome-for-testing 归档（~150MB）
docker compose --profile bootstrap run --rm chrome-mirror-bootstrap

# 一次性下载 ffmpeg 构建（~150MB）
docker compose --profile bootstrap run --rm ffmpeg-mirror-bootstrap

# 验证
curl -s http://127.0.0.1:4873/-/ping                   # → ok
curl -s http://127.0.0.1:4874/+api                    # → devpi JSON
curl -sI http://127.0.0.1:8088/win32/138.0.7204.157/chrome-headless-shell-win32.zip | head -1
curl -sI http://127.0.0.1:8089/win64/ffmpeg-7.1.1-win64-gpl.zip | head -1
curl -s http://127.0.0.1:18765/health                 # → {"ok":true,...}
```

### 已知的环境问题

1. **本机 docker daemon 当前配了 `HTTP_PROXY=http://127.0.0.1:7890`，
   但这个代理目前不可达（`connection refused`）。** `docker compose pull` 之前要么修好
   那个代理，要么临时在 `/etc/systemd/system/docker.service.d/*.conf` 里去掉
   `HTTP_PROXY`/`HTTPS_PROXY` 环境变量再 `systemctl restart docker`。
2. **端口冲突**：本机已经占用了 `8000`（Sequoia-X）、`8080`（vclaw）、
   `3000/8443`（dify nginx）、`6379/6380/6381`（redis）、`3307`（mysql）、
   `5003`（dify plugin-daemon）、`9010/9011`（minio）。本 compose 默认的 4873/4874/8088/8089/18765
   与上述均不冲突；如果你的机器不同，把 `.env` 里的端口改了再 `up`。
3. **`whisperx-lan-proxy` 走的是 `network_mode: host`**，因此占的是宿主机端口，不是容器端口；
   它和 `hypit-whisperx` 真实进程之间是 `127.0.0.1:8765`，不会有冲突。

## 客户端配置（Win10 举例）

> 把下面所有 `192.168.20.173` 换成你 `HYPIT_LAN_HOST` 设的值。

### 1) npm / pnpm → Verdaccio

```powershell
# C:\Users\<you>\.npmrc
registry=http://192.168.20.173:4873/
strict-ssl=false        # 镜像未签证书时
# 让 corepack / pnpm 看到同一个 registry
```

验证：

```powershell
pnpm config get registry
pnpm view @hypit/hypit version       # 任何请求都会经 verdaccio 走到上游并缓存
```

### 2) PyPI / uv → devpi

```powershell
# C:\Users\<you>\AppData\Roaming\uv\uv.toml
[index]
url = "http://192.168.20.173:4874/public/simple/"
```

验证：

```powershell
uv pip install --dry-run faster-whisper
```

### 3) Chrome Headless Shell → nginx（自动接管）

在 Win10 端 `hypit.runtime.json` 改 endpoints：

```jsonc
{
  "endpoints": {
    "hyperframes.local": {
      "use": "@hypit/provider-hyperframes-local",
      "config": {
        "browserDownloadBaseUrl": "http://192.168.20.173:8088/",
        "browserVersion": "138.0.7204.157"
      }
    }
  }
}
```

> `browserDownloadBaseUrl` 是 `packages/provider-hyperframes-local/src/browser.ts`
> 显式支持的钩子（仓库里有专门的 URL 校验函数：必须是 absolute HTTP(S)、无凭据、
> 无查询串、无 fragment）。Provider 仍然只认 win32/win64/linux64 等
> 标准目录结构，所以镜像端必须按官方 `chrome-for-testing-public/` 布局摆放。

### 4) ffmpeg / ffprobe → nginx 或直接复制

```powershell
# 方式 A：直接从镜像下载
Invoke-WebRequest http://192.168.20.173:8089/win64/ffmpeg-7.1.1-win64-gpl.zip -OutFile $env:TEMP\ffmpeg.zip
Expand-Archive $env:TEMP\ffmpeg.zip -DestinationPath C:\tools\
# 把 C:\tools\ffmpeg-7.1.1-win64-gpl\bin 加到 PATH（控制面板 → 系统 → 高级系统设置 → 环境变量）

# 方式 B：Provider 端指定绝对路径（推荐，少一次 PATH 解析）
# hypit.runtime.json -> endpoints.hyperframes.local.config:
#   "ffmpegPath":  "C:\\tools\\ffmpeg\\ffmpeg.exe",
#   "ffprobePath": "C:\\tools\\ffmpeg\\ffprobe.exe"

# 验证
ffmpeg -version
ffprobe -version
```

### 5) 本机 whisperx 暴露（如果 Win10 也要用 `provider-whisperx-local`）

在 Win10 端 `hypit.runtime.json`：

```jsonc
{
  "endpoints": {
    "whisperx.local": {
      "use": "@hypit/provider-whisperx-local",
      "config": {
        "baseUrl": "http://192.168.20.173:18765",
        "alignmentLanguages": ["en", "zh"]
      }
    }
  }
}
```

## 运维小贴士

- Verdaccio 缓存命中：第一次 `pnpm install` 慢，后续 `pnpm install --offline` 即可纯本地。
- devpi 第一次拉完大包后，建议 `devpi-server --serverdir /data/server` 加 `--offline-mode` 重启以拒绝任何公网回源（最严苛的隔离）。
- chrome-mirror 和 ffmpeg-mirror 都用 `autoindex on` 提供目录索引，方便手动找文件。
- 这套栈没有强依赖 Verdaccio / devpi 的鉴权；如果你公司 LAN 范围比较大、想加一层 basic-auth，
  在各服务的 nginx 上加 `auth_basic` 即可（verdaccio 自身也有 htpasswd 钩子）。
- `whisperx-host-bind.sh` 是给"不想跑 docker 的老机器"准备的 iptables 替代方案，
  跟 compose 里的 `whisperx-lan-proxy` 二选一即可，**不要同时用**，否则流量会被双向重写。