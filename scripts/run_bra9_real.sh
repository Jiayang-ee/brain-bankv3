#!/usr/bin/env bash
# BRA-9 full real network run launcher.
#
# Usage:
#   scripts/run_bra9_real.sh                              # default: out=<repo>/faculty/data/real-YYYY-MM-DD, log=<repo>/logs
#   OUT_DIR=path/to/out LOG_DIR=path/to/log scripts/run_bra9_real.sh
#
# Repo root is auto-detected by walking up from $0 until a .git directory or
# worktree pointer file is found, so the script works from any checkout
# (CI, local dev, git worktree, plain clone).
set -u

# --- locate repo root -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
# Accept .git as either a directory (main clone) or a worktree pointer file
# (worktree clones have a 168-byte text file `gitdir: ...` instead).
while [ "$REPO_ROOT" != "/" ] && [ ! -e "$REPO_ROOT/.git" ]; do
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
if [ ! -e "$REPO_ROOT/.git" ]; then
  echo "fatal: could not find a .git (dir or file) above $SCRIPT_DIR" >&2
  exit 1
fi
echo "repo: $REPO_ROOT"

# --- resolve out / log dirs -------------------------------------------------
DATE_TAG="$(date +%Y-%m-%d)"
DEFAULT_OUT="$REPO_ROOT/faculty/data/real-$DATE_TAG"
DEFAULT_LOG="$REPO_ROOT/logs"
OUT_DIR="${OUT_DIR:-$DEFAULT_OUT}"
LOG_DIR="${LOG_DIR:-$DEFAULT_LOG}"

# Optional narrow-scope filter.  Empty = all 51 journals (default).
SYSTEMS_FLAG=""
if [ -n "${SYSTEMS_FILTER:-}" ]; then
  SYSTEMS_FLAG="--systems $SYSTEMS_FILTER"
fi

mkdir -p "$OUT_DIR" "$LOG_DIR"
STDOUT="$LOG_DIR/bra9-real-run.stdout.log"
STDERR="$LOG_DIR/bra9-real-run.stderr.log"
PIDFILE="$LOG_DIR/bra9-real-run.pid"

# --- don't double-launch ----------------------------------------------------
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi

# --- launch detached --------------------------------------------------------
# macOS lacks setsid.  Detach via subshell + nohup + disown: the subshell exits
# quickly so the bash tool wrapper doesn't hold the child in its session, and
# nohup + disown ensure the child ignores SIGHUP and is removed from the job
# table.
(
  cd "$REPO_ROOT"
  nohup node faculty/scripts/papers.js --all \
    --out "$OUT_DIR" \
    --verbose \
    $SYSTEMS_FLAG \
    > "$STDOUT" 2> "$STDERR" < /dev/null &
  echo $! > "$PIDFILE"
  disown
)
echo "launched pid=$(cat "$PIDFILE")"
echo "out:   $OUT_DIR"
echo "log:   $LOG_DIR"
echo "stdout: $STDOUT"
echo "stderr: $STDERR"
