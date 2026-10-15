#!/usr/bin/env bash
# Rebuild guangzhou-clone with the latest assets, export guangzhou-final.video.
# Designed to run unattended (no TTY, no Claude): logs everything to a
# timestamped file under .hypit/cron-logs/.
set -u
set -o pipefail

PROJECT="/opt/hypit/examples/guangzhou-clone"
LOGDIR="$PROJECT/.hypit/cron-logs"
mkdir -p "$LOGDIR"

# Pin Node the way guizou-clone/cron-build.sh does. hypit.mjs has a
# `#!/usr/bin/env node` shebang, so under cron's minimal PATH it would pick up
# /usr/local/bin/node (v22.13.1); the nvm build (v22.22.1) is the supported
# runtime. Prepend its dir so the shebang and any subprocesses resolve to it.
NODE_BIN="${HYPIT_NODE_BIN:-/root/.nvm/versions/node/v22.22.1/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
HYPIT="$NODE_BIN /opt/hypit/bin/hypit.mjs"

# Every cron invocation gets its own timestamp suffix used for: log file,
# build title, and exported MP4 path. That way two runs in the same hour
# never collide.
TS=$(date +%Y%m%d-%H%M%S)
LOG="$LOGDIR/rebuild-${TS}.log"

{
  echo "==== hypit-guangzhou-cron ===="
  echo "started: $(date -Iseconds)"
  echo "host: $(hostname)"
  echo "project: $PROJECT"
  echo "ts: $TS"
  echo "node: $NODE_BIN ($("$NODE_BIN" -v 2>&1))"
  echo
} > "$LOG"

cd "$PROJECT" || { echo "cd 失败: $PROJECT" | tee -a "$LOG"; exit 1; }

# The Runtime must be up before a Build is submitted: the HTML rasterizer
# needs its managed Chrome program, and preflight fails the submission
# otherwise. `runtime up` is idempotent and cheap when already ready.
echo "[0/3] runtime up ..." | tee -a "$LOG"
$HYPIT runtime up --runtime ./hypit.runtime.json --project "$PROJECT" 2>&1 | tee -a "$LOG"

# 1. rebuild — submit a Build, capture the id
echo "[1/3] hypit build ..." | tee -a "$LOG"
BUILD_OUT=$($HYPIT build ./guangzhou.svrun \
  --runtime ./hypit.runtime.json \
  --project "$PROJECT" \
  --title "guangzhou-cron-$TS" \
  --json 2>&1)
echo "$BUILD_OUT" >> "$LOG"

BUILD_ID=$(printf '%s' "$BUILD_OUT" \
  | python3 -c 'import json,sys,re
raw=sys.stdin.read()
m=re.search(r"bld_\d{8}T\d{9}Z_[A-Z0-9]+", raw)
print(m.group(0) if m else "")')

if [ -z "$BUILD_ID" ]; then
  # ⚠️ 报出 CLI 的真实错误，而不是只说「没解析出 build id」。
  #    2026-10-10 踩过：构建早就因为 hypit.project 标记缺失而失败，日志却停在
  #    「FAIL: no build id parsed from output」，把真正的 CLI_ERROR 埋在上面的
  #    JSON 里没人看 —— 与本仓库反复出现的「静默失效」同型。
  echo "FAIL: 构建未提交（上方 BUILD_OUT 是 CLI 的真实报错）" | tee -a "$LOG"
  printf '%s' "$BUILD_OUT" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    e=d.get("error") or {}
    print("  code: %s" % e.get("code","-"), file=sys.stderr)
    print("  message: %s" % e.get("message","-"), file=sys.stderr)
except Exception:
    print("  (输出非 JSON，见日志)", file=sys.stderr)' 2>&1 | tee -a "$LOG"
  echo "ended: $(date -Iseconds)" >> "$LOG"
  exit 1
fi
echo "build id: $BUILD_ID" | tee -a "$LOG"

# 2. wait for completion (poll up to 45 min; the 9:16 render takes ~10 min on CPU)
echo "[2/3] waiting for build to finish ..." | tee -a "$LOG"
DEADLINE=$(( $(date +%s) + 2700 ))
STATE=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$($HYPIT status "$BUILD_ID" --runtime ./hypit.runtime.json --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
  j=json.load(sys.stdin)
  # ⚠️ `status --json` 的字段都在 build 对象下面，顶层只有 format/build。
  #    2026-10-11/12 连着两天读顶层，STATE 恒为空串 → 空转满 45 分钟 →
  #    落到 case 的 * 分支，把已经构建成功的成片当失败丢弃。
  #    work.outcome 优先（它是终态判定），其次 result.state，最后 work.state。
  b=j.get("build") or {}
  w=b.get("work") or {}
  r=b.get("result") or {}
  print(w.get("outcome") or r.get("state") or w.get("state") or "")
except Exception:
  print("")')
  echo "  $(date +%H:%M:%S) state=$STATE" >> "$LOG"
  case "$STATE" in
    complete|succeeded|failed|cancelled|errored) break ;;
  esac
  sleep 30
done
echo "final state: $STATE" | tee -a "$LOG"

# 3. export final video — 但失败时不要导出一个「看起来成功」的旧文件
echo "[3/3] exporting guangzhou-final.video ..." | tee -a "$LOG"
case "$STATE" in
  complete|succeeded) ;;
  *)
    echo "构建未成功（state=$STATE），跳过导出" | tee -a "$LOG"
    echo "ended: $(date -Iseconds)" >> "$LOG"
    exit 1
    ;;
esac
OUT="$LOGDIR/guangzhou-cron-$TS.mp4"
$HYPIT get "$BUILD_ID" --project "$PROJECT" --output guangzhou-final.video --to "$OUT" 2>&1 | tee -a "$LOG"
ls -la "$OUT" 2>/dev/null | tee -a "$LOG"

echo "ended: $(date -Iseconds)" | tee -a "$LOG"
echo "log: $LOG"
