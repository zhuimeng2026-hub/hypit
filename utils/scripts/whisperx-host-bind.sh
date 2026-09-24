#!/bin/sh
# Optional: rebind the local `hypit-whisperx` service to 0.0.0.0 instead of 127.0.0.1.
#
# The source code at services/whisperx/src/hypit_whisperx_service/server.py:89 hardcodes
# `("127.0.0.1", config.port)`. There is no env knob to switch the bind address, so this
# script does one of two things depending on what's available:
#
#   1) If `iptables` is available AND the service is still bound to 127.0.0.1, install a
#      DNAT rule that forwards incoming 18765 traffic to loopback:8765. This keeps the
#      service running and avoids dropping in-flight requests.
#
#   2) Otherwise, restart the service with `HYPIT_WHISPERX_PORT=18765` after a small
#      wrapper that listens on 0.0.0.0 (out of scope for this script — see README).
#
# The cleaner production path is (1) — the compose stack already provides a `whisperx-lan-proxy`
# container that does exactly the same forward. This script is the host-iptables fallback
# for boxes where running docker isn't desired.

set -eu

LAN_PORT="${HYPIT_WHISPERX_LAN_PORT:-18765}"
LOOP_PORT="${HYPIT_WHISPERX_PORT:-8765}"

if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables not available; use the docker compose `whisperx-lan-proxy` instead" >&2
    exit 1
fi

# Check whether the service is already listening.
if ! ss -lnt 2>/dev/null | grep -q "127.0.0.1:${LOOP_PORT}\b"; then
    echo "no service on 127.0.0.1:${LOOP_PORT}; nothing to do" >&2
    exit 0
fi

# Install the DNAT rule. Idempotent: list and replace any matching prior rule.
rule="-A INPUT -p tcp --dport ${LAN_PORT} -j ACCEPT"
if ! iptables -C INPUT -p tcp --dport "${LAN_PORT}" -j ACCEPT 2>/dev/null; then
    iptables -A INPUT -p tcp --dport "${LAN_PORT}" -j ACCEPT
fi

# Forward: from <LAN_PORT> on any iface -> 127.0.0.1:<LOOP_PORT>.
if ! iptables -t nat -C PREROUTING -p tcp --dport "${LAN_PORT}" -j DNAT \
        --to-destination "127.0.0.1:${LOOP_PORT}" 2>/dev/null; then
    iptables -t nat -A PREROUTING -p tcp --dport "${LAN_PORT}" -j DNAT \
        --to-destination "127.0.0.1:${LOOP_PORT}"
fi

# Same-machine origin packets must also be rewritten so the return path works.
if ! iptables -t nat -C OUTPUT -p tcp --dport "${LAN_PORT}" -j DNAT \
        --to-destination "127.0.0.1:${LOOP_PORT}" 2>/dev/null; then
    iptables -t nat -A OUTPUT -p tcp --dport "${LAN_PORT}" -j DNAT \
        --to-destination "127.0.0.1:${LOOP_PORT}"
fi

echo "iptables rules installed. Verify with:"
echo "  curl -s http://<lan-ip>:${LAN_PORT}/health"
echo "If the rules don't survive reboot, install iptables-persistent (apt) and run:"
echo "  netfilter-persistent save"