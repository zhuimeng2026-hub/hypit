<#
.SYNOPSIS
    Install the pypi-mirror on Windows (PEP 503 simple index for uv).

.DESCRIPTION
    nginx for Windows fronting pypi.org with on-disk proxy_cache. Behaviour
    matches utils/nginx/conf.d/pypi-mirror.conf so the Linux/Docker stack
    and this Windows stack are interchangeable from the Win10 client's
    point of view.

    Steps:
      1. Verify admin rights + nssm present.
      2. Copy pypi-mirror.conf from utils-windows\nginx-conf\ into the
         shared C:\tools\nginx\conf\conf.d\ (same nginx instance as the
         static mirrors — see notes).
      3. Register nginx's existing "HypitStaticMirrors" service as a
         managed Windows service (the same one created by
         setup-static-mirrors.ps1) — reloaded, not duplicated.
      4. Open firewall for 4874.
      5. Verify /healthz and a real /simple/ fetch.

.PARAMETER ToolsRoot
    Where nginx + nssm live. Default: C:\tools — should match
    setup-static-mirrors.ps1.

.PARAMETER LanHost
    LAN-facing hostname. Default: 192.168.20.173. Cosmetic.

.EXAMPLE
    .\setup-pypi-mirror.ps1

.NOTES
    This script reuses the nginx instance from setup-static-mirrors.ps1 —
    one nginx process, one Windows service ("HypitStaticMirrors"), all
    four server blocks in conf.d/. If you split them into separate
    services, change AppParameters in nssm to point at per-service
    nginx.conf copies.
#>
[CmdletBinding()]
param(
    [string]$ToolsRoot = "C:\tools",
    [string]$LanHost   = "192.168.20.173"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- 0. guard: admin ---
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Must run as Administrator."
}

# --- 1. guard: nssm + nginx installed ---
$NssmExe = Join-Path $ToolsRoot "nssm\nssm.exe"
$NginxRoot = Join-Path $ToolsRoot "nginx"
$NginxExe  = Join-Path $NginxRoot "nginx.exe"
if (-not (Test-Path $NssmExe)) {
    throw "nssm not found at $NssmExe. Run setup-static-mirrors.ps1 first."
}
if (-not (Test-Path $NginxExe)) {
    throw "nginx not found at $NginxExe. Run setup-static-mirrors.ps1 first."
}

# --- 2. copy pypi-mirror.conf into the shared conf.d/ ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$src = Join-Path $ScriptDir "nginx-conf\pypi-mirror.conf"
$dst = Join-Path $NginxRoot "conf\conf.d\pypi-mirror.conf"
if (-not (Test-Path $src)) {
    throw "Missing nginx config template: $src"
}
Copy-Item -Force $src $dst

# --- 3. ensure cache dir ---
$cacheDir = Join-Path $NginxRoot "cache\pypi"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

# --- 4. nginx config test + reload ---
& $NginxExe -t 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "nginx config test failed; run '$NginxExe -t' to see errors."
}
# Reload the running service (or start it). Use the existing
# "HypitStaticMirrors" service created by setup-static-mirrors.ps1.
$svc = Get-Service -Name "HypitStaticMirrors" -ErrorAction SilentlyContinue
if (-not $svc) {
    throw "Service 'HypitStaticMirrors' not found. Run setup-static-mirrors.ps1 first."
}
if ($svc.Status -ne "Running") {
    Start-Service -Name "HypitStaticMirrors"
} else {
    # Hot reload: send HUP to the master. nginx for Windows writes its
    # pid to nginx.pid in the install dir by default; nssm keeps that dir
    # as the working dir, so `nginx.exe -s reload` reaches the running
    # master. If this fails (pid file missing on older nginx builds),
    # Restart-Service does the same job more slowly.
    & $NginxExe -s reload 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Restart-Service -Name "HypitStaticMirrors"
    }
}
Start-Sleep -Seconds 1

# --- 5. firewall ---
$ruleName = "Hypit pypi-mirror 4874"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
        -Protocol TCP -LocalPort 4874 -Action Allow -Profile Any | Out-Null
}

# --- 6. verify ---
Write-Host ""
Write-Host "[verify] testing endpoints..."
foreach ($path in @("/healthz", "/simple/faster-whisper/")) {
    try {
        $code = (Invoke-WebRequest -Uri "http://127.0.0.1:4874$path" `
            -UseBasicParsing -TimeoutSec 10).StatusCode
        Write-Host "  /4874$path  → HTTP $code"
    } catch {
        Write-Warning "  /4874$path  → FAILED ($($_.Exception.Message))"
    }
}

Write-Host ""
Write-Host "[done] pypi-mirror live."
Write-Host "  uv index  http://$LanHost`:4874/simple/"
