# Hypit 内部镜像 — Windows 原生部署

如果 LAN 服务器不能跑 Docker（没有 Linux 主机、不允许装 docker daemon、运维团队只熟悉 Windows），用这套脚本在 **Windows 10 Pro/Enterprise** 或 **Windows Server 2019+** 上以原生 Windows 服务形式搭出同一组 6 个镜像。

URL 端点跟 `utils/` 那套完全一致 — `docs/guide/win10-internal-mirrors.md` 的客户端配置一字不用改。

## 运行顺序（按依赖顺序逐个跑）

| # | 脚本 | 端口 | 承担 |
|---|---|---|---|
| 1 | `setup-static-mirrors.ps1` | 8088 / 8089 / 3030 | chrome-mirror, ffmpeg-mirror, git-mirror |
| 2 | `setup-pypi-mirror.ps1` | 4874 | pypi-mirror（追加到同一个 nginx 实例） |
| 3 | `setup-verdaccio.ps1` | 4873 | Verdaccio（npm/pnpm registry） |
| 4 | `setup-whisperx-portproxy.ps1` | 18765 | whisperx 暴露（用 netsh portproxy，不起新进程） |

每个脚本**幂等** — 重跑只刷新内容、不复制状态；中途出错会在那一行 throw 停住。

## 端口速查

| 端口 | 服务 | 健康端点 |
|---|---|---|
| 4873 | Verdaccio | `http://localhost:4873/-/ping` |
| 4874 | pypi-mirror | `http://localhost:4874/healthz` |
| 8088 | chrome-mirror | `http://localhost:8088/healthz` |
| 8089 | ffmpeg-mirror | `http://localhost:8089/healthz` |
| 3030 | git-mirror | `http://localhost:3030/healthz` |
| 18765 | whisperx-lan-proxy | `http://localhost:18765/health` |

所有端口绑定 `0.0.0.0`，LAN 内任何机器能直接访问。

## 前置条件

- Windows 10 Pro/Enterprise 1903+ 或 Windows Server 2019+
- PowerShell 5.1+（Win10 自带）
- **管理员权限**（启用 IIS 不需要，但 nssm 注册服务、netsh portproxy、防火墙规则都需要）
- Node.js **22.15+**（仅 `setup-verdaccio.ps1` 需要；https://nodejs.org 下载安装）
- Git for Windows（`setup-static-mirrors.ps1` 跑 `git clone --bare` 需要；https://git-scm.com/download/win）
- VC++ Redistributable 2015-2022 x64（nginx for Windows 需要；Win10 1903+ 自带）
- 能访问公网一次（拉 Verdaccio 包、nginx zip、nssm zip、chrome/ffmpeg/git 上游归档）
- LAN 内能到达 `127.0.0.1:8765` 上跑的 `hypit-whisperx-service` 进程（仅 `setup-whisperx-portproxy.ps1` 需要）

## 一次跑通的最小命令

```powershell
# 全部管理员 PowerShell，依次执行。
cd C:\path\to\repo\utils-windows

.\setup-static-mirrors.ps1
.\setup-pypi-mirror.ps1
.\setup-verdaccio.ps1
.\setup-whisperx-portproxy.ps1
```

每个脚本跑完会打印 `[done]` 和一组 `http://...` 验证链接。如果有 `FAILED` 行，看 `C:\tools\logs\nginx-stderr.log` 或 `C:\tools\verdaccio\stderr.log`。

## 服务名

| 服务名 | 类型 | 控制命令 |
|---|---|---|
| `HypitStaticMirrors` | nginx for Windows（扛 8088 / 8089 / 3030 / 4874） | `Restart-Service HypitStaticMirrors` |
| `HypitVerdaccio` | Node.js Verdaccio（扛 4873） | `Restart-Service HypitVerdaccio` |
| （whisperx portproxy 是 netsh，不占服务） | netsh 内核级端口重写 | `netsh interface portproxy show v4tov4` |

## 与 utils/ (Linux + Docker) 的对比

| 维度 | utils/ | utils-windows/ |
|---|---|---|
| 一键部署 | `docker compose up -d` | 4 个脚本按序跑 |
| 服务升级 | 改 tag + `pull && up -d` | 各自重装 |
| 维护技能栈 | docker + nginx + git | IIS/不要、nginx for Windows、nssm、netsh、git |
| 资源占用 | ~200 MB（容器叠） | ~150 MB（原生进程） |
| 适合场景 | 有 docker 运维能力 | 强制要求 Windows 原生 / 不允许装 docker |

## 跟 `utils/` 配对的注意点

- `nginx-conf/*.conf` 的 root 路径是 `C:/tools/nginx/...`，与 `utils/nginx/conf.d/*.conf` 的 `/usr/share/nginx/...` 不同。两边不要混用 — 每个栈用各自的 conf 文件。
- `setup-static-mirrors.ps1` 安装的 nginx 实例同时扛 8088/8089/3030/4874 — `setup-pypi-mirror.ps1` 把 pypi 的 server block 追加到同一个 `conf.d/`，由 nssm 跑成同一个 Windows Service。如果你想要分开管理，可以拆成两份 nginx.conf + 两个 service。
- 服务端的镜像版本（Chrome 156.0.8073.0、Provider 默认 `browserVersion` 等）需要跟 `utils/.env.example` 保持一致，否则 Win10 客户端 `browserVersion` 写啥就在这个 nginx 上下啥 — 路径不存在就 404。
- 防火墙规则以 `Hypit ...` 为名前缀，重复跑不会留垃圾。
