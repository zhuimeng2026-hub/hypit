<#
.SYNOPSIS
    Install Verdaccio as a Windows Service on port 4873.

.DESCRIPTION
    Verdaccio is itself a Node.js application — no Docker dependency. This
    script installs it globally, writes a Windows-friendly config, registers
    it via nssm, opens the firewall, and verifies.

    Steps:
      1. Verify admin rights + Node.js 22.15+ present.
      2. Install Verdaccio globally (npm install -g verdaccio). Re-runs
         idempotently.
      3. Write C:\tools\verdaccio\config.yaml from the same template the
         Docker stack uses (utils/verdaccio/config.yaml). Storage and
         plugins paths are rewritten to Windows form.
      4. Create storage + plugins directories.
      5. Register "HypitVerdaccio" Windows service via nssm.
      6. Open firewall for 4873.
      7. Verify /-/ping.

.PARAMETER ToolsRoot
    Where to install Verdaccio + its config. Default: C:\tools.

.PARAMETER LanHost
    LAN-facing hostname. Default: 192.168.20.173. Cosmetic.

.EXAMPLE
    .\setup-verdaccio.ps1

.NOTES
    The first `npm install -g verdaccio` reaches the public npm registry.
    After this script finishes, every subsequent `pnpm install` from a
    Win10 client on the LAN goes through this Verdaccio — and Verdaccio
    itself caches upstream lazily, so the public registry is only touched
    on first request per package.
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

# --- 1. guard: Node.js + nssm ---
$nodeVer = (& node --version 2>$null) -replace '^v', ''
if (-not $nodeVer) { throw "Node.js not on PATH." }
$major = [int]($nodeVer.Split('.')[0])
if ($major -lt 22) {
    throw "Node.js >= 22.15 required (got v$nodeVer)."
}
$NssmExe = Join-Path $ToolsRoot "nssm\nssm.exe"
if (-not (Test-Path $NssmExe)) {
    throw "nssm not found at $NssmExe. Run setup-static-mirrors.ps1 first."
}

# --- 2. install Verdaccio globally ---
Write-Host "[step] npm install -g verdaccio (uses public registry the first time)..."
npm install -g verdaccio | Out-Null
$verdaccioJs = (& npm root -g) + "\verdaccio\bin\verdaccio.js"
if (-not (Test-Path $verdaccioJs)) {
    throw "verdaccio install failed; $verdaccioJs not found."
}

# --- 3. write config ---
$VerdaccioRoot = Join-Path $ToolsRoot "verdaccio"
New-Item -ItemType Directory -Force -Path $VerdaccioRoot | Out-Null
$storage = Join-Path $VerdaccioRoot "storage"
$plugins = Join-Path $VerdaccioRoot "plugins"
New-Item -ItemType Directory -Force -Path $storage, $plugins | Out-Null
$cfgPath = Join-Path $VerdaccioRoot "config.yaml"

# Same template as utils/verdaccio/config.yaml, with Windows paths.
$cfg = @"
# Verdaccio config — anonymous read, npm proxy with on-disk cache, no write unless
# explicitly authenticated. Mirrors the upstream `registry.npmjs.org` lazily; once a
# tarball is fetched it lives forever under $storage.

storage: $storage
plugins: $plugins

web:
  title: Hypit internal npm registry
  enable: true

auth:
  htpasswd:
    file: $VerdaccioRoot\htpasswd     # not present; empty auth = disabled auth

packages:
  '@*/*':
    access: `$all
    publish: `$authenticated
    unpublish: `$authenticated
    proxy: npmjs
  '**':
    access: `$all
    publish: `$authenticated
    unpublish: `$authenticated
    proxy: npmjs

uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
    timeout: 30s
    maxfailures: 5
    fail_timeout: 5m

server:
  keepAliveTimeout: 60
  legacy: true

listen:
  - 0.0.0.0:4873

security:
  api:
    legacy: true

log:
  type: stdout
  format: pretty
  level: info
"@
Set-Content -Path $cfgPath -Value $cfg -Encoding UTF8

# --- 4. register Windows Service ---
$svcName = "HypitVerdaccio"
if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
    & $NssmExe install $svcName (Join-Path $env:ProgramFiles "nodejs\node.exe")
    # AppParameters is a single space-separated string; PowerShell `"`
    # escapes the embedded quotes. No surrounding parens — nssm takes the
    # literal string verbatim.
    & $NssmExe set $svcName AppParameters "`"$verdaccioJs`" --config `"$cfgPath`""
    & $NssmExe set $svcName AppDirectory (Split-Path $verdaccioJs)
    & $NssmExe set $svcName DisplayName "Hypit Verdaccio (npm/pnpm registry)"
    & $NssmExe set $svcName Start SERVICE_AUTO_START
    & $NssmExe set $svcName AppStdout (Join-Path $VerdaccioRoot "stdout.log")
    & $NssmExe set $svcName AppStderr (Join-Path $VerdaccioRoot "stderr.log")
    & $NssmExe set $svcName AppRotateFiles 1
    & $NssmExe set $svcName AppRotateBytes 10485760
}
Start-Service -Name $svcName

# --- 5. firewall ---
$ruleName = "Hypit Verdaccio 4873"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
        -Protocol TCP -LocalPort 4873 -Action Allow -Profile Any | Out-Null
}

# --- 6. verify ---
Start-Sleep -Seconds 3
Write-Host "[verify] testing /-/ping..."
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:4873/-/ping" `
        -UseBasicParsing -TimeoutSec 10
    Write-Host "  /4873/-/ping  → HTTP $($resp.StatusCode)  body: $($resp.Content)"
} catch {
    Write-Warning "  /4873/-/ping  → FAILED ($($_.Exception.Message))"
}

Write-Host ""
Write-Host "[done] Verdaccio running under service '$svcName'."
Write-Host "  registry  http://$LanHost`:4873/"
Write-Host "  config    $cfgPath"
