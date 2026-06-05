#!/usr/bin/env bash
# BRA-9 full real network run launcher
set -u
cd /Users/wjy/multica_workspaces_desktop-api.multica.ai/07cb4f37-083d-4f52-9010-e6031f5c1972/6b086fde/workdir/brain-bankv3
mkdir -p logs faculty/data/real-2026-06-05
LOG_DIR=/Users/wjy/multica_workspaces_desktop-api.multica.ai/07cb4f37-083d-4f52-9010-e6031f5c1972/6b086fde/workdir/logs
mkdir -p "$LOG_DIR"
STDOUT="$LOG_DIR/bra9-real-run.stdout.log"
STDERR="$LOG_DIR/bra9-real-run.stderr.log"
PIDFILE="$LOG_DIR/bra9-real-run.pid"

# Don't restart if already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi

# macOS lacks setsid.  Detach via subshell + nohup + disown: the subshell exits
# quickly so the bash tool wrapper doesn't hold the child in its session, and
# nohup + disown ensure the child ignores SIGHUP and is removed from the job
# table.
(
  cd /Users/wjy/multica_workspaces_desktop-api.multica.ai/07cb4f37-083d-4f52-9010-e6031f5c1972/6b086fde/workdir/brain-bankv3
  nohup node faculty/scripts/papers.js --all \
    --out faculty/data/real-2026-06-05 \
    --verbose \
    > "$STDOUT" 2> "$STDERR" < /dev/null &
  echo $! > "$PIDFILE"
  disown
)
echo "launched pid=$(cat "$PIDFILE")"
echo "stdout: $STDOUT"
echo "stderr: $STDERR"
