---
title: Win10 客户端走内网镜像
description: 一段 PowerShell 命令序列，把 Win10 客户端指到 LAN 自托管的 npm / PyPI / Chrome / ffmpeg 镜像，装好 Hypit，并跑通第一次本地渲染。
---

本指南面向**没有公网访问（或不应使用公网）的 Windows 10 客户端**：所有依赖都通过内网镜像
提供。镜像栈本身在仓库的 [`utils/`](../../utils/) 目录，详见 `utils/README.md`。本指南假定
服务端已经跑起来并且 LAN 内可达。

> **服务端不能跑 docker？** 如果 LAN 镜像主机没法跑 Linux + Docker，仓库的
> [`utils-windows/`](../../utils-windows/) 用 PowerShell 脚本在 Win10 上以原生 Windows
> 服务形式搭出同一组 6 个镜像 —— 端口、URL、`~/.npmrc` / `uv.toml` /
> `browserDownloadBaseUrl` / `git clone` 这套客户端配置全部不变。Windows 脚本用 nginx
> for Windows + nssm + netsh portproxy 代替 docker，假定镜像主机本身就是这台 Win10
> （不需要单独的 Linux 机器）。

下文统一使用 `192.168.20.173` 作为镜像主机 LAN IP，请替换为你服务端实际的
`HYPIT_LAN_HOST`。

## 0. 前置检查 — 确认服务端六个服务都活着

在 LAN 内任意机器上：

```bash
curl -s http://192.168.20.173:4873/-/ping                # verdaccio → "ok"
curl -s -o /dev/null -w '%{http_code}\n' \
     http://192.168.20.173:4874/simple/faster-whisper/   # pypi-mirror → 200
curl -sI http://192.168.20.173:8088/156.0.8073.0/win32/chrome-headless-shell-win32.zip | head -1
curl -sI http://192.168.20.173:8089/win64/ffmpeg-master-latest-win64-gpl.zip | head -1
curl -s http://192.168.20.173:18765/health                # whisperx 代理 → {"ok":true,...}
curl -s http://192.168.20.173:3030/healthz                # git-mirror → "ok"
```

六项都必须返回非错误响应。任一项失败，先修服务端，不要先动客户端。

## 1. 装工具链（一次性，约 5 分钟）

**以管理员身份打开 PowerShell**。Corepack 随 Node 22+ 自带，无需额外下载就能拿到 pnpm 10.33。

```powershell
# 从 https://nodejs.org 下载 Node 22.15+（LTS）；安装时勾选 "Add to PATH"。
node --version          # → v22.x 或 v24.x

corepack enable         # 启用 pnpm / yarn shim
corepack prepare pnpm@10.33.0 --activate

pnpm --version          # → 10.33.x
```

本指南用的是仓库 checkout，不需要 `pnpm install -g @hypit/hypit` 装全局 SDK — 这样你始终跑
在一个固定的 commit 上。

## 2. 拉代码 + 指向 LAN 镜像

```powershell
# 选个工作目录。路径深度别超过 ~30 字符：太长会撞 Win10 260 字符限制。
cd D:\work

# 从 LAN 上的 git-mirror 克隆，不要走 github.com — 这个镜像是 dumb-HTTP、只读，
# 后台每 1 小时从上游 git fetch 一次。客户端走 git push 在协议层就不可达。
git clone http://192.168.20.173:3030/hypit.git
cd hypit
```

接下来写四个 LAN 镜像配置文件。每个都很短，直接 `Set-Content` 就行。

### 2a. npm / pnpm registry

```powershell
# 写用户级 ~/.npmrc，不要写项目级 — 用户级对所有 workspace 包都生效。
$npmrc = "$env:USERPROFILE\.npmrc"
Set-Content -Path $npmrc -Encoding ascii -Value @"
registry=http://192.168.20.173:4873/
strict-ssl=false
"@
```

### 2b. uv / PyPI index

```powershell
# uv 在 Windows 上把用户配置存在 %APPDATA%\uv\uv.toml；目录可能还不存在。
New-Item -ItemType Directory -Force -Path "$env:APPDATA\uv" | Out-Null
Set-Content -Path "$env:APPDATA\uv\uv.toml" -Encoding utf8 -Value @"
[index]
url = "http://192.168.20.173:4874/simple/"
"@
```

### 2c. ffmpeg / ffprobe

```powershell
# 从 LAN 上的 BtbN 构建下载、解压、把 bin 加进 PATH。
$ffmpegZip = "$env:TEMP\ffmpeg.zip"
Invoke-WebRequest `
    -Uri "http://192.168.20.173:8089/win64/ffmpeg-master-latest-win64-gpl.zip" `
    -OutFile $ffmpegZip

$ffmpegRoot = "C:\tools\ffmpeg"
New-Item -ItemType Directory -Force -Path $ffmpegRoot | Out-Null
Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegRoot -Force

# 解压到一个带版本号的子目录里；统一挪到根目录，得到一个稳定 PATH。
Get-ChildItem $ffmpegRoot -Directory | ForEach-Object {
    Move-Item "$($_.FullName)\bin\*" $ffmpegRoot -Force
    Remove-Item $_.FullName -Recurse -Force
}

# 用户级 PATH，新 shell 立即生效，不需要管理员。
[Environment]::SetEnvironmentVariable(
    "Path",
    "$env:Path;$ffmpegRoot",
    "User"
)
$env:Path += ";$ffmpegRoot"

ffmpeg -version   # 必须打印 BtbN 出来的版本号
ffprobe -version
```

> 不加 PATH 也可以：直接给 Provider 写绝对路径（见步骤 3）。两种都行，PATH 更省事。

### 2d. Hypit runtime 配置 — 指向 chrome 镜像 + 本机 whisperx

```powershell
# 仓库里有个示例，先拷一份再改。
Copy-Item examples\semantic-composition\hypit.runtime.json hypit.runtime.json

# 把 chrome-mirror baseUrl 写进 hyperframes endpoint；再加一个指向服务端 socat 的 whisperx endpoint。
$cfg = Get-Content hypit.runtime.json -Raw | ConvertFrom-Json
$cfg.endpoints.'hyperframes.local'.config.browserDownloadBaseUrl =
    "http://192.168.20.173:8088/"
$cfg.endpoints.'hyperframes.local'.config.browserVersion = "156.0.8073.0"

$whisperx = [pscustomobject]@{
    use    = "@hypit/provider-whisperx-local"
    config = [pscustomobject]@{
        baseUrl             = "http://192.168.20.173:18765"
        alignmentLanguages  = @("en", "zh")
    }
}
if (-not $cfg.endpoints.'whisperx.local') {
    $cfg.endpoints | Add-Member -NotePropertyName 'whisperx.local' -NotePropertyValue $whisperx
}

$cfg | ConvertTo-Json -Depth 10 | Set-Content hypit.runtime.json -Encoding utf8
```

> Provider 对 `browserDownloadBaseUrl` 有严格校验：必须是 absolute HTTP(S)、无凭据、无查询串、
> 无 fragment（见 `packages/provider-hyperframes-local/src/browser.ts`）。上面这种写法就是它
> 唯一接受的格式。

### 2e. 装 Hypit Skill — 从 clone 的仓库拷出来

`npx skills add hypit-ai/hypit -g` 要走公网 GitHub，在内网 LAN 上不通。Skill 本身就在
你刚 clone 的仓库里 — 把它拷到 Agent 的 skills 目录，跟 `skills add` 效果一样：

```powershell
# Claude Code / Codex 用户级 skills 目录（其它 Agent 以自身文档为准）。
$skillsRoot = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

# 如果之前装过同名 skill，先删掉再覆盖 — 跟 repo 当前 commit 对齐。
if (Test-Path "$skillsRoot\hypit") {
    Remove-Item "$skillsRoot\hypit" -Recurse -Force
}
Copy-Item -Recurse -Force .\skills\hypit "$skillsRoot\hypit"

# Agent 实际读取的文件就在这里 — 用它确认安装到位。
Test-Path "$skillsRoot\hypit\SKILL.md"     # → True
```

重启 Agent 让它加载新的 skill 目录。上游 `skills/hypit/` 更新时，重新跑一遍 `Copy-Item`
覆盖即可 — 这就是内网版的 `npx skills add ...`。

## 3. 装依赖 + 验证

```powershell
# pnpm install 会把所有 workspace 包都从 Verdaccio 拉。
pnpm install --frozen-lockfile

# 用锁定的 SDK 跑一次全量类型检查。
pnpm check

# 跑默认测试套件（无 GPU、不需要网络）。
pnpm test
```

期望：`pnpm check` 退出码 0；`pnpm test` 报 `tests N pass M` 且 `N > 0`。

## 4. 第一次本地渲染

```powershell
# 让 Provider 从 LAN 镜像（而不是 Google）下载 Chrome Headless Shell。
pnpm hypit -- runtime up --runtime local

pnpm hypit -- doctor --runtime local    # 应该报所有 program 都 available
```

跑一次示例工程：

```powershell
cd examples\semantic-composition
pnpm exec --workspace=. -- hypit video build scene-1.svml --runtime local
cd ..\..

# 输出落在 .hypit/runtimes/local/build/<时间戳>/...
Get-ChildItem .hypit\runtimes\local -Recurse -Filter *.mp4 | Select-Object -First 3
```

如果 Provider 报找不到浏览器，重新跑 `pnpm hypit -- runtime up --runtime local --verbose`；
日志里应该看到 `Downloading Chrome Headless Shell 156.0.8073.0/win32/...`，URL 必须以
`http://192.168.20.173:8088/` 开头。如果不是开头 — 步骤 2d 的 patch 没生效，回去检查。

## 5. 日常使用

```powershell
cd D:\work\hypit
git pull                                    # 上游更新
pnpm install --frozen-lockfile              # Verdaccio 拉新依赖
pnpm check                                  # 类型检查
pnpm test                                   # 默认测试套件

# 渲染任务
pnpm hypit -- runtime up --runtime local              # 一次性准备浏览器
pnpm hypit -- video build path\to\scene.svml --runtime local
pnpm hypit -- studio                                   # 浏览器里启动 Studio
```

可选的环境变量门控套件：

```powershell
$env:HYPIT_RUNTIME_SCALE_TESTS = "1"
pnpm test:runtime-scale

$env:HYPIT_OPENCV_TESTS = "1"
pnpm test:image-opencv
```

## 故障排查

| 现象 | 可能原因 | 修复 |
|---|---|---|
| `pnpm install` 报 `ECONNREFUSED 127.0.0.1:7890` | 全局 npm/pnpm 还残留 proxy 配置 | `npm config delete proxy; npm config delete https-proxy`（pnpm 同样） |
| `pnpm install` 仍然走公网 | `~/.npmrc` 没在用户家目录 | `Get-Content $env:USERPROFILE\.npmrc` 应该返回你的 LAN 行 |
| `pnpm check` 报 `koffi` 加载失败 | 原生依赖对不上 | `pnpm install --frozen-lockfile --force`；koffi 在 Node 22/24 上有 win32-x64 预编译 |
| Provider 报 `chromePath ... not found` | 镜像空 / 版本不对 | 在服务端跑 `docker compose --profile bootstrap run --rm chrome-mirror-bootstrap`；`curl -I http://192.168.20.173:8088/156.0.8073.0/win32/chrome-headless-shell-win32.zip` |
| Provider 连不上 whisperx | socat 容器没跑 / LAN IP 错 | 服务端：`docker ps \| grep whisperx-lan-proxy`；`curl http://192.168.20.173:18765/health` |
| `git clone http://192.168.20.173:3030/hypit.git` 失败 | git-mirror 没起 / LAN IP 错 | 服务端：`docker ps \| grep git-mirror`；`curl http://192.168.20.173:3030/healthz` 应该输出 `ok` |
| `git clone` 中途 403 / 404 | nginx alias 配错或 pack index 没刷新 | 服务端：`docker exec hypit-git-mirror git -C /var/lib/git/hypit.git update-server-info` |
| Agent 找不到 `hypit` skill | 没拷到 Agent 的 skills 目录 | 重跑步骤 2e，再重启 Agent。Agent 实际读的是 `$env:USERPROFILE\.claude\skills\hypit\SKILL.md`。 |
| `uv pip install` 超时 | pypi-mirror nginx 不健康 | 服务端：`docker logs hypit-pypi-mirror --tail 20`；`curl http://192.168.20.173:4874/simple/faster-whisper/` 应该 200 |
| Studio 起来了但显示 "no runtime" | `hypit.runtime.json` 不在工作区根目录 | 确认 `Get-Location` 在 repo 内且 `Test-Path hypit.runtime.json` 是 `True` |
| 文件路径太长（>260 字符） | Win10 没开长路径 | `git config --system core.longpaths true`；或开组策略 "Enable Win32 long paths" |

## 相关阅读

- [`utils/README.md`](../../utils/README.md) — 服务端镜像栈搭建与验证
- [`docs/guide/develop.md`](./develop.md) — 通用开发指南
- [`docs/guide/runtime.md`](./runtime.md) — Runtime Profile 选型
- [`docs/guide/providers.md`](./providers.md) — Provider 配置深入