---
title: Win10 client over an internal mirror LAN
description: One-shot PowerShell sequence to point a Windows 10 machine at the LAN-hosted npm, PyPI, Chrome and ffmpeg mirrors, install Hypit, and run a first local render.
---

This guide is for a Windows 10 client that has no direct internet access (or should not use it):
every dependency is served by an internal mirror on the LAN. The mirror stack itself lives at
[`utils/` in this repo](../utils/) and is documented in `utils/README.md`. Read that first if you
need to bring the server side up; this guide assumes the server is already running and reachable.

> **Server has no docker?** If the LAN host can't run the Linux + Docker stack, the same six
> mirrors can be installed natively on Windows 10 with the PowerShell scripts under
> [`utils-windows/`](../utils-windows/) — same ports, same URLs, same `~/.npmrc` / `uv.toml`
> / `browserDownloadBaseUrl` / `git clone` sequence this guide covers. The Windows scripts use
> nginx for Windows + nssm + netsh portproxy instead of Docker, and assume the server itself
> is the LAN mirror host (no separate Linux box).

Throughout, `192.168.20.173` is the LAN IP of the mirror host. Replace it with whatever your
server's `HYPIT_LAN_HOST` resolves to.

## 0. Pre-flight — confirm the server side is up

Before touching the Win10 client, run these from any machine that can reach the LAN host:

```bash
curl -s http://192.168.20.173:4873/-/ping                # verdaccio → "ok"
curl -s -o /dev/null -w '%{http_code}\n' \
     http://192.168.20.173:4874/simple/faster-whisper/   # pypi-mirror → 200
curl -sI http://192.168.20.173:8088/156.0.8073.0/win32/chrome-headless-shell-win32.zip | head -1
curl -sI http://192.168.20.173:8089/win64/ffmpeg-master-latest-win64-gpl.zip | head -1
curl -s http://192.168.20.173:18765/health                # whisperx proxy → {"ok":true,...}
curl -s http://192.168.20.173:3030/healthz                # git-mirror → "ok"
```

All six must return non-error responses. If one fails, fix the server before continuing.

## 1. Install the toolchain (one-time, ~5 min)

Open **PowerShell as Administrator**. Corepack ships with Node 22+ and gives you pnpm 10.33 with no
extra download.

```powershell
# Node 22.15+ (LTS) from https://nodejs.org; tick "Add to PATH" in the installer.
node --version          # → v22.x or v24.x

corepack enable         # enables `pnpm` and `yarn` shims
corepack prepare pnpm@10.33.0 --activate

pnpm --version          # → 10.33.x
```

You do not need to `pnpm install -g @hypit/hypit` for the SDK; this guide uses the repo checkout so
you stay on a pinned commit.

## 2. Pull Hypit and set the LAN registry

```powershell
# Pick a working directory. Avoid paths deeper than ~30 chars; long paths break some Windows APIs.
cd D:\work

# Clone from the LAN git-mirror, NOT github.com — the mirror is dumb-HTTP, read-only,
# refreshes every hour from upstream. Push is unreachable at the protocol level.
git clone http://192.168.20.173:3030/hypit.git
cd hypit
```

Write the four LAN-pointing config files. Each one is small enough to create with `Set-Content`.

### 2a. npm / pnpm registry

```powershell
# Make sure the file lives in your USER home, not the project — that's the level that wins
# for transitive deps.
$npmrc = "$env:USERPROFILE\.npmrc"
Set-Content -Path $npmrc -Encoding ascii -Value @"
registry=http://192.168.20.173:4873/
strict-ssl=false
"@
```

### 2b. uv / PyPI index

```powershell
# uv stores user config under %APPDATA%\uv\uv.toml (Windows). Folder may not exist yet.
New-Item -ItemType Directory -Force -Path "$env:APPDATA\uv" | Out-Null
Set-Content -Path "$env:APPDATA\uv\uv.toml" -Encoding utf8 -Value @"
[index]
url = "http://192.168.20.173:4874/simple/"
"@
```

### 2c. ffmpeg / ffprobe

```powershell
# Download the LAN-hosted BtbN build, extract, and put it on PATH for this session.
$ffmpegZip = "$env:TEMP\ffmpeg.zip"
Invoke-WebRequest `
    -Uri "http://192.168.20.173:8089/win64/ffmpeg-master-latest-win64-gpl.zip" `
    -OutFile $ffmpegZip

$ffmpegRoot = "C:\tools\ffmpeg"
New-Item -ItemType Directory -Force -Path $ffmpegRoot | Out-Null
Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegRoot -Force

# The zip extracts to a versioned subdirectory; rename for a stable PATH.
Get-ChildItem $ffmpegRoot -Directory | ForEach-Object {
    Move-Item "$($_.FullName)\bin\*" $ffmpegRoot -Force
    Remove-Item $_.FullName -Recurse -Force
}

# Add to PATH for the current user (no admin needed). New shells pick it up immediately.
[Environment]::SetEnvironmentVariable(
    "Path",
    "$env:Path;$ffmpegRoot",
    "User"
)
$env:Path += ";$ffmpegRoot"

ffmpeg -version   # must print a version banner from BtbN
ffprobe -version
```

> If you prefer not to add ffmpeg to PATH, point the Provider at the absolute paths instead
> (see step 3). Both work; PATH is simpler.

### 2d. Hypit runtime config — point at the chrome mirror and the local whisperx

```powershell
# The repo ships an example that you can copy and edit.
Copy-Item examples\semantic-composition\hypit.runtime.json hypit.runtime.json

# Patch the chrome-mirror baseUrl into the local hyperframes endpoint, and add the
# whisperx endpoint that points at the socat proxy on the server.
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

> The Provider validates `browserDownloadBaseUrl`: it must be an absolute HTTP(S) URL with no
> credentials, query or fragment. The URL form above is what `packages/provider-hyperframes-local/src/browser.ts`
> enforces.

### 2e. Install the Hypit Skill from the cloned repo

`npx skills add hypit-ai/hypit -g` reaches github.com, so it does not work on an offline
LAN. The Skill ships inside the repository you just cloned — copy it into your Agent's
skill directory and it behaves identically to `skills add`:

```powershell
# Claude Code / Codex — user-global skill directory.
$skillsRoot = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

# Replace any previously installed copy to keep it in sync with this checkout.
if (Test-Path "$skillsRoot\hypit") {
    Remove-Item "$skillsRoot\hypit" -Recurse -Force
}
Copy-Item -Recurse -Force .\skills\hypit "$skillsRoot\hypit"

# Sanity check: the file the Agent loads should be at this exact path.
Test-Path "$skillsRoot\hypit\SKILL.md"     # → True
```

Restart your Agent so it picks up the new skill directory. When the upstream
`skills/hypit/` directory moves, re-run `Copy-Item` over the top — that is the LAN
equivalent of `npx skills add ...` updating.

## 3. Install dependencies and verify

```powershell
# pnpm install pulls every workspace package through Verdaccio.
pnpm install --frozen-lockfile

# Type-check the whole monorepo against the pinned SDK.
pnpm check

# Run the default test suite (no GPU, no network).
pnpm test
```

Expected: `pnpm check` exits 0; `pnpm test` reports `tests N pass M` with `N > 0`.

## 4. First local render

```powershell
# Make sure the Provider downloaded Chrome Headless Shell from the LAN mirror, not Google.
pnpm hypit -- runtime up --runtime local

pnpm hypit -- doctor --runtime local    # should report all programs available
```

Run a one-off build against the example project:

```powershell
cd examples\semantic-composition
pnpm exec --workspace=. -- hypit video build scene-1.svml --runtime local
cd ..\..

# Output lands under .hypit/runtimes/local/build/<timestamp>/...
Get-ChildItem .hypit\runtimes\local -Recurse -Filter *.mp4 | Select-Object -First 3
```

If the Provider reports it cannot find a browser, re-run `pnpm hypit -- runtime up --runtime local`
with `--verbose`; it should log `Downloading Chrome Headless Shell 156.0.8073.0/win32/...` and the
URL must start with `http://192.168.20.173:8088/`. If it doesn't, your `browserDownloadBaseUrl`
patch in step 2d did not stick — re-check.

## 5. Day-to-day workflow

```powershell
cd D:\work\hypit
git pull                                    # upstream changes
pnpm install --frozen-lockfile              # picks up new deps through Verdaccio
pnpm check                                  # type-check
pnpm test                                   # default suite

# Render jobs
pnpm hypit -- runtime up --runtime local              # one-time browser prep
pnpm hypit -- video build path\to\scene.svml --runtime local
pnpm hypit -- studio                                   # launch Studio in browser
```

Optional env-gated suites:

```powershell
$env:HYPIT_RUNTIME_SCALE_TESTS = "1"
pnpm test:runtime-scale

$env:HYPIT_OPENCV_TESTS = "1"
pnpm test:image-opencv
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm install` fails with `ECONNREFUSED 127.0.0.1:7890` | Stale global npm/pnpm proxy config | Run `npm config delete proxy; npm config delete https-proxy` (and same for pnpm). |
| `pnpm install` falls back to public registry | `~/.npmrc` not at user home | Confirm `Get-Content $env:USERPROFILE\.npmrc` returns your LAN line. |
| `pnpm check` complains about `koffi` not loading | Native dep mismatch | Reinstall with `pnpm install --frozen-lockfile --force`; koffi ships win32-x64 prebuilds for Node 22/24. |
| Provider says `chromePath ... not found` | Mirror empty / wrong version | Re-run `docker compose --profile bootstrap run --rm chrome-mirror-bootstrap` on the server; check `curl -I http://192.168.20.173:8088/156.0.8073.0/win32/chrome-headless-shell-win32.zip` |
| Provider cannot reach whisperx | socat container not running, or LAN IP wrong | On server: `docker ps | grep whisperx-lan-proxy`. Then `curl http://192.168.20.173:18765/health` |
| `git clone http://192.168.20.173:3030/hypit.git` is unreachable | git-mirror not running, or LAN IP wrong | On server: `docker ps | grep git-mirror`; `curl http://192.168.20.173:3030/healthz` should print `ok` |
| `git clone` returns 403 / 404 mid-fetch | nginx alias issue or pack index not generated | On server: `docker exec hypit-git-mirror git -C /var/lib/git/hypit.git update-server-info` |
| Agent can't find `hypit` skill | Skill not copied into Agent skills dir | Re-run step 2e; restart the Agent. The file path the Agent reads is `$env:USERPROFILE\.claude\skills\hypit\SKILL.md`. |
| `uv pip install` times out | pypi-mirror nginx not healthy | On server: `docker logs hypit-pypi-mirror --tail 20`; confirm `curl http://192.168.20.173:4874/simple/faster-whisper/` returns 200 |
| Studio starts but shows "no runtime" | `hypit.runtime.json` not in workspace root | Confirm `Get-Location` is inside the repo and `Test-Path hypit.runtime.json` is `True` |
| File path too long errors (>260 chars) | Win10 long-path policy off | `git config --system core.longpaths true`; or enable the group policy "Enable Win32 long paths". |

## See also

- [`utils/README.md`](../../utils/README.md) — server-side stack bring-up and verification
- [`docs/guide/develop.md`](./develop.md) — general Development Guide
- [`docs/guide/runtime.md`](./runtime.md) — Runtime Profile selection
- [`docs/guide/providers.md`](./providers.md) — Provider configuration in depth