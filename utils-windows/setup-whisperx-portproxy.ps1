<#
.SYNOPSIS
    Expose the loopback-only hypit-whisperx service to the LAN on port 18765.

.DESCRIPTION
    Replaces utils/docker-compose.yml's whisperx-lan-proxy (socat) with the
    Windows-native netsh interface portproxy — no third-party tools, no
    extra process. Traffic bound for the LAN-facing 18765 is rewritten to
    127.0.0.1:8765 where the actual `hypit-whisperx-service` Python
    process listens.

    Steps:
      1. Verify admin rights + that hypit-whisperx is already running on
         127.0.0.1:8765.
      2. netsh interface portproxy add v4tov4 18765 -> 127.0.0.1:8765.
      3. Open firewall for 18765.
      4. Verify /health.

.PARAMETER ListenPort
    LAN-facing port. Default: 18765 — matches utils/.env.example.

.PARAMETER BackendHost
    Loopback host where hypit-whisperx binds. Default: 127.0.0.1.

.PARAMETER BackendPort
    Loopback port where hypit-whisperx binds. Default: 8765 — matches
    services/whisperx/src/hypit_whisperx_service/server.py:89.

.EXAMPLE
    .\setup-whisperx-portproxy.ps1

.NOTES
    netsh portproxy does not need a "process" — the kernel does the
    rewrite. There's no socat fork/concurrency option, but hypit-whisperx
    is a single long-lived HTTP process that opens a few connections per
    request; v4tov4 is plenty.

    To undo:
        netsh interface portproxy delete v4tov4 listenport=18765 listenaddress=0.0.0.0
#>
[CmdletBinding()]
param(
    [int]$ListenPort   = 18765,
    [string]$BackendHost = "127.0.0.1",
    [int]$BackendPort   = 8765
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- 0. guard: admin ---
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Must run as Administrator."
}

# --- 1. guard: hypit-whisperx is already listening on the backend port ---
$backend = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq $BackendHost }
if (-not $backend) {
    throw "hypit-whisperx is not listening on $BackendHost`:$BackendPort. Start it first."
}
Write-Host "[ok] backend $BackendHost`:$BackendPort is up (PID $($backend.OwningProcess))"

# --- 2. install the portproxy rule (idempotent) ---
$existing = netsh interface portproxy show v4tov4 |
    Select-String "0.0.0.0\s+$ListenPort\s+$BackendHost\s+$BackendPort"
if (-not $existing) {
    # Clear any partial rule for this listen port (e.g. wrong backend) before adding.
    $anyRule = netsh interface portproxy show v4tov4 |
        Select-String "^\s*0\.0\.0\.0\s+$ListenPort"
    if ($anyRule) {
        netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
    }
    Write-Host "[step] netsh interface portproxy add v4tov4 listen $ListenPort → $BackendHost`:$BackendPort"
    netsh interface portproxy add v4tov4 `
        listenport=$ListenPort listenaddress=0.0.0.0 `
        connectport=$BackendPort connectaddress=$BackendHost | Out-Null
} else {
    Write-Host "[skip] portproxy rule already present."
}

# --- 3. firewall ---
$ruleName = "Hypit whisperx portproxy $ListenPort"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
        -Protocol TCP -LocalPort $ListenPort -Action Allow -Profile Any | Out-Null
}

# --- 4. verify ---
Start-Sleep -Seconds 1
Write-Host "[verify] testing /health..."
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$ListenPort/health" `
        -UseBasicParsing -TimeoutSec 10
    Write-Host "  /$ListenPort/health  → HTTP $($resp.StatusCode)  body: $($resp.Content)"
} catch {
    Write-Warning "  /$ListenPort/health  → FAILED ($($_.Exception.Message))"
}

Write-Host ""
Write-Host "[done] portproxy installed."
Write-Host "  rule      0.0.0.0`:$ListenPort → $BackendHost`:$BackendPort"
Write-Host "  undo      netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0"
