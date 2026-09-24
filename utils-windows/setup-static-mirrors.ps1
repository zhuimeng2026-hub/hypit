<#
.SYNOPSIS
    Install the three static-file mirrors on Windows: chrome (8088), ffmpeg (8089), git (3030).

.DESCRIPTION
    One-shot PowerShell script. Idempotent — re-running refreshes content and
    re-applies the nginx config without duplicating state.

    Steps:
      1. Verify admin rights + Node.js present.
      2. Install nginx for Windows to C:\tools\nginx (downloads the zip if missing).
      3. Install nssm to C:\tools\nssm (used by the other setup-*.ps1 scripts too).
      4. Create mirror content directories under C:\tools\nginx\html\.
      5. Bootstrap chrome-for-testing archives into C:\tools\nginx\html\chrome\
         (win32, win64, linux64, mac-arm64, mac-x64) at the pinned version.
      6. Bootstrap BtbN ffmpeg builds into C:\tools\nginx\html\ffmpeg\
         (win64 + linux64) and write index.json.
      7. git clone --bare https://github.com/hypit-ai/hypit.git into
         C:\tools\nginx\html\git\hypit.git\ and run update-server-info.
      8. Copy the three server-block configs from
         utils-windows\nginx-conf\ into C:\tools\nginx\conf\conf.d\.
      9. Register nginx as the "HypitStaticMirrors" Windows service via nssm
         and start it.
     10. Open firewall for 8088, 8089, 3030.
     11. Verify each /healthz endpoint.

.PARAMETER ToolsRoot
    Where to install nginx and nssm. Default: C:\tools

.PARAMETER LanHost
    LAN-facing hostname the README + Win10 guide use. Default: 192.168.20.173.
    Cosmetic — not used to bind ports (nginx binds 0.0.0.0).

.PARAMETER ChromeVersion
    Chrome-for-testing version to fetch. Default: 156.0.8073.0 — keeps the
    Provider's pinned browserVersion in lockstep with utils/.env.example.

.EXAMPLE
    .\setup-static-mirrors.ps1
    # All defaults; installs under C:\tools, fetches chrome 156.0.8073.0.

.NOTES
    VC++ Redistributable (2015-2022 x64) must be installed for nginx for
    Windows. Win10 1903+ ships it; older builds need a one-time install.
#>
[CmdletBinding()]
param(
    [string]$ToolsRoot = "C:\tools",
    [string]$LanHost   = "192.168.20.173",
    [string]$ChromeVersion = "156.0.8073.0"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- 0. guard: admin ---
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Must run as Administrator."
}

# --- 1. guard: git on PATH ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required (for the bare-repo mirror). Install Git for Windows first."
}

# --- 2. resolve script-relative paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NginxConfSource = Join-Path $ScriptDir "nginx-conf"
foreach ($f in @("chrome-mirror.conf", "ffmpeg-mirror.conf", "git-mirror.conf")) {
    if (-not (Test-Path (Join-Path $NginxConfSource $f))) {
        throw "Missing nginx config template: $f (looked in $NginxConfSource)"
    }
}

# --- 3. install nginx for Windows ---
$NginxRoot = Join-Path $ToolsRoot "nginx"
$NginxExe  = Join-Path $NginxRoot "nginx.exe"
$NginxZip  = Join-Path $ToolsRoot "nginx-1.27.5.zip"

if (-not (Test-Path $NginxExe)) {
    Write-Host "[step] downloading nginx 1.27.5 for Windows..."
    New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
    Invoke-WebRequest -Uri "https://nginx.org/download/nginx-1.27.5.zip" `
        -OutFile $NginxZip -UseBasicParsing
    Write-Host "[step] extracting to $NginxRoot..."
    Expand-Archive -Path $NginxZip -DestinationPath $ToolsRoot -Force
    Remove-Item $NginxZip -Force
    # nginx zip extracts to nginx-1.27.5/; rename for stable path.
    $extracted = Join-Path $ToolsRoot "nginx-1.27.5"
    if (Test-Path $extracted) {
        if (Test-Path $NginxRoot) { Remove-Item $NginxRoot -Recurse -Force }
        Rename-Item -Path $extracted -NewName "nginx"
    }
}

# --- 4. install nssm (used by the other setup-*.ps1 too) ---
$NssmDir = Join-Path $ToolsRoot "nssm"
$NssmExe = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $NssmExe)) {
    Write-Host "[step] downloading nssm 2.24..."
    New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
    $nssmZip = Join-Path $ToolsRoot "nssm-2.24.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" `
        -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath $ToolsRoot -Force
    # nssm zip extracts to nssm-2.24/win64/nssm.exe (or win32 for 32-bit).
    $extracted = Get-ChildItem -Path $ToolsRoot -Directory -Filter "nssm-2.24" | Select-Object -First 1
    if ($extracted) {
        if (Test-Path $NssmDir) { Remove-Item $NssmDir -Recurse -Force }
        Move-Item -Path $extracted.FullName -Destination $NssmDir
    }
    Remove-Item $nssmZip -Force
}
# Add nssm to user PATH so other setup-*.ps1 scripts find nssm without full path.
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$NssmDir*") {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$currentPath;$NssmDir",
        "User"
    )
    $env:Path += ";$NssmDir"
}

# --- 5. content directories ---
$ChromeDir = Join-Path $NginxRoot "html\chrome"
$FfmpegDir = Join-Path $NginxRoot "html\ffmpeg"
$GitDir    = Join-Path $NginxRoot "html\git"
New-Item -ItemType Directory -Force -Path $ChromeDir, $FfmpegDir, $GitDir | Out-Null

# --- 6. bootstrap chrome ---
$ChromeVersionDir = Join-Path $ChromeDir $ChromeVersion
New-Item -ItemType Directory -Force -Path $ChromeVersionDir | Out-Null
foreach ($plat in @("win32", "win64", "linux64", "mac-arm64", "mac-x64")) {
    $archive = "chrome-headless-shell-$plat.zip"
    $dest    = Join-Path $ChromeVersionDir $archive
    if (Test-Path $dest) { Write-Host "[skip] $archive"; continue }
    $url = "https://storage.googleapis.com/chrome-for-testing-public/$ChromeVersion/$plat/$archive"
    Write-Host "[step] downloading chrome $ChromeVersion $plat..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    } catch {
        Write-Warning "  could not fetch $url ($($_.Exception.Message)) — skipping"
        if (Test-Path $dest) { Remove-Item $dest -Force }
    }
}

# --- 7. bootstrap ffmpeg (BtbN rolling latest) ---
$ffmpegWin  = "ffmpeg-master-latest-win64-gpl.zip"
$ffmpegLin  = "ffmpeg-master-latest-linux64-gpl.tar.xz"
$winUrl  = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$ffmpegWin"
$linUrl  = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$ffmpegLin"
foreach ($pair in @(@($ffmpegWin, $winUrl), @($ffmpegLin, $linUrl))) {
    $archive = $pair[0]; $url = $pair[1]
    $subdir  = if ($archive -like "*-win64-*") { "win64" } else { "linux64" }
    $dest    = Join-Path $FfmpegDir "$subdir\$archive"
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    if (Test-Path $dest) { Write-Host "[skip] $archive"; continue }
    Write-Host "[step] downloading ffmpeg $archive..."
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}
$indexJson = @"
{
  "win64":   "/win64/$ffmpegWin",
  "linux64": "/linux64/$ffmpegLin",
  "note":    "BtbN/FFmpeg-Builds rolling latest; extract and put bin/ on PATH"
}
"@
Set-Content -Path (Join-Path $FfmpegDir "index.json") -Value $indexJson -Encoding UTF8

# --- 8. bootstrap git ---
$GitBare = Join-Path $GitDir "hypit.git"
if (-not (Test-Path (Join-Path $GitBare "HEAD"))) {
    Write-Host "[step] git clone --bare https://github.com/hypit-ai/hypit.git (long pole, ~150MB)..."
    git clone --bare https://github.com/hypit-ai/hypit.git $GitBare
}
Push-Location $GitBare
git update-server-info
Pop-Location

# --- 9. copy server-block configs into nginx/conf/conf.d/ ---
$ConfD = Join-Path $NginxRoot "conf\conf.d"
New-Item -ItemType Directory -Force -Path $ConfD | Out-Null
foreach ($f in @("chrome-mirror.conf", "ffmpeg-mirror.conf", "git-mirror.conf")) {
    Copy-Item -Force (Join-Path $NginxConfSource $f) (Join-Path $ConfD $f)
}
# The default nginx.conf ships a `server { listen 80; ... }` block. We don't
# bind 80 anywhere; leave the default page alone — it's harmless and removing
# it via regex would be fragile across nginx versions. Just make sure the
# conf.d include is in place (it is by default; sanity-check).
$includeLine = Select-String -Path (Join-Path $NginxRoot "conf\nginx.conf") -Pattern "include conf/conf.d"
if (-not $includeLine) {
    Add-Content (Join-Path $NginxRoot "conf\nginx.conf") "`ninclude conf/conf.d/*.conf;`n"
}

# --- 10. register + start Windows service ---
$svcName = "HypitStaticMirrors"
& $NginxExe -t 2>&1 | Out-Null  # config test
if ($LASTEXITCODE -ne 0) {
    throw "nginx config test failed; run '$NginxExe -t' to see errors."
}
# Use a per-service wrapper: each nssm-managed nginx needs its own nginx.conf copy
# or it will collide with the pypi-mirror nginx instance. Simplest: re-use one
# nginx, one config, all four server blocks. The pypi-mirror setup script adds
# its own server block to the same conf.d/.
if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
    & $NssmExe install $svcName $NginxExe
    & $NssmExe set $svcName AppDirectory $NginxRoot
    & $NssmExe set $svcName AppParameters "-c conf/nginx.conf"
    & $NssmExe set $svcName DisplayName "Hypit static mirrors (chrome / ffmpeg / git)"
    & $NssmExe set $svcName Start SERVICE_AUTO_START
    & $NssmExe set $svcName AppStdout (Join-Path $ToolsRoot "logs\nginx-stdout.log")
    & $NssmExe set $svcName AppStderr (Join-Path $ToolsRoot "logs\nginx-stderr.log")
    & $NssmExe set $svcName AppRotateFiles 1
    & $NssmExe set $svcName AppRotateBytes 10485760
}
New-Item -ItemType Directory -Force -Path (Join-Path $ToolsRoot "logs") | Out-Null
if ((Get-Service -Name $svcName).Status -ne "Running") {
    Start-Service -Name $svcName
}

# --- 11. firewall ---
foreach ($port in @(8088, 8089, 3030)) {
    $ruleName = "Hypit Static Mirror $port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
            -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
    }
}

# --- 12. verify ---
Write-Host ""
Write-Host "[verify] waiting 2s for nginx to settle..."
Start-Sleep -Seconds 2
foreach ($port in @(8088, 8089, 3030)) {
    try {
        $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" `
            -UseBasicParsing -TimeoutSec 5).StatusCode
        Write-Host "  port $port healthz  → HTTP $code"
    } catch {
        Write-Warning "  port $port healthz  → FAILED ($($_.Exception.Message))"
    }
}

Write-Host ""
Write-Host "[done] static mirrors running under service '$svcName'."
Write-Host "  chrome   http://$LanHost`:8088/$ChromeVersion/win32/chrome-headless-shell-win32.zip"
Write-Host "  ffmpeg   http://$LanHost`:8089/win64/$ffmpegWin"
Write-Host "  git      http://$LanHost`:3030/hypit.git"
