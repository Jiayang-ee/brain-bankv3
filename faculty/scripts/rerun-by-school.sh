#!/usr/bin/env bash
# rerun-by-school.sh — 分批重跑 faculty 抓取，断点续跑 + 单批失败不中断。
#
# 用法：
#   bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5 [--batch-size 5] [--out /path/to/data]
#   bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5 --dry-run
#
# 行为：
#   - 按 --batch-size（默认 5）切分 --schools 列表
#   - 每批调用 discover.js --schools <batch> --skip-existing --out <out>
#   - 单批失败（discover.js 退出码非 0）→ 记录但继续下一批
#   - 每批日志写到 <out>/crawl_log.batch-<N>.jsonl 片段（discover.js 也会写主 crawl_log.jsonl）
#   - 整批结束后输出 summary（成功 / 失败批次、profiles、skippedExisting、failures 合计）
#
# 适用场景：
#   - 50 校一次跑到底容易超时/被 WAF；拆批可降低单批内的 host-level 压力
#   - 任一批被 Cloudflare / Akamai 拦截时不影响后续批次
#   - 配合 --skip-existing 增量重跑，重复条目不会重新落库

set -u
# 不开 -e / pipefail：单批失败要继续跑
# 但加 trap 提示哪批炸了

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DISCOVER="$REPO_ROOT/faculty/scripts/discover.js"
DEFAULT_OUT="$REPO_ROOT/faculty/data"

SCHOOLS=""
BATCH_SIZE=5
OUT="$DEFAULT_OUT"
DRY_RUN=0
MAX_PROFILES=200

usage() {
  cat <<EOF
用法: $0 --schools <rank-list> [options]

必选:
  --schools <list>         逗号分隔的 QS rank 列表, e.g. 1,2,3,4,5

可选:
  --batch-size <N>         每批学校数, 默认 5
  --out <dir>              输出目录, 默认 faculty/data
  --max-profiles <N>       每个部门最多抓取的个人主页数, 默认 200
  --dry-run                传给 discover.js 的 --dry-run
  -h / --help              显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --schools) SCHOOLS="$2"; shift 2;;
    --batch-size) BATCH_SIZE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --max-profiles) MAX_PROFILES="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown flag: $1" >&2; usage; exit 1;;
  esac
done

if [ -z "$SCHOOLS" ]; then
  echo "ERROR: --schools <list> is required" >&2
  usage
  exit 1
fi

if [ ! -f "$DISCOVER" ]; then
  echo "ERROR: $DISCOVER not found; run from repo root" >&2
  exit 1
fi

mkdir -p "$OUT"

# 把逗号分隔的学校列表切成数组
IFS=',' read -r -a SCHOOL_ARR <<< "$SCHOOLS"

# 简单按 BATCH_SIZE 切批（无重叠）
TOTAL=${#SCHOOL_ARR[@]}
BATCH_COUNT=0
BATCH_OK=0
BATCH_FAIL=0
TOTAL_PROCESSED=0
TOTAL_PROFILES=0
TOTAL_SKIPPED_EXISTING=0
TOTAL_FAILURES=0
FAILED_BATCHES=()

echo "=== rerun-by-school ==="
echo "  schools: $SCHOOLS (total=$TOTAL)"
echo "  batch_size: $BATCH_SIZE"
echo "  out: $OUT"
echo "  max_profiles: $MAX_PROFILES"
echo "  dry_run: $DRY_RUN"
echo ""

i=0
while [ $i -lt $TOTAL ]; do
  BATCH=$((TOTAL - i < BATCH_SIZE ? TOTAL - i : BATCH_SIZE))
  BATCH_LIST=$(IFS=,; echo "${SCHOOL_ARR[*]:i:BATCH}")
  BATCH_COUNT=$((BATCH_COUNT + 1))
  BATCH_START=$(date +%s)
  BATCH_LOG="$OUT/crawl_log.batch-$BATCH_COUNT.log"

  echo "--- batch $BATCH_COUNT: schools=[$BATCH_LIST] (count=$BATCH) ---"

  # 构造 discover.js 参数
  ARGS=(--schools "$BATCH_LIST" --skip-existing --out "$OUT" --max-profiles "$MAX_PROFILES")
  if [ "$DRY_RUN" = "1" ]; then
    ARGS+=(--dry-run)
  fi

  # 不重定向主输出，但额外把 stdout/stderr 复制到 per-batch 日志
  set +e
  node "$DISCOVER" "${ARGS[@]}" 2>&1 | tee "$BATCH_LOG"
  RC=${PIPESTATUS[0]}
  set -e 2>/dev/null || true
  BATCH_END=$(date +%s)
  BATCH_ELAPSED=$((BATCH_END - BATCH_START))

  # 从 stdout 末尾的 JSON object 解析关键计数（discover.js 末尾打印的是多行缩进 JSON object）
  # 简单做法：用 python -c 读整个文件，提取最后以 { 开始、匹配括号的对象
  JSON_TAIL=$(awk '/^{/{flag=1; buf=""} flag{buf=buf $0 "\n"; if($0 == "}"){obj=buf; flag=0}} END{print obj}' "$BATCH_LOG")
  P=$(echo "$JSON_TAIL" | grep -oE '"processed": *[0-9]+' | grep -oE '[0-9]+' || echo 0)
  PR=$(echo "$JSON_TAIL" | grep -oE '"profiles": *[0-9]+' | grep -oE '[0-9]+' || echo 0)
  SE=$(echo "$JSON_TAIL" | grep -oE '"skippedExisting": *[0-9]+' | grep -oE '[0-9]+' || echo 0)
  FA=$(echo "$JSON_TAIL" | grep -oE '"failures": *[0-9]+' | grep -oE '[0-9]+' || echo 0)

  TOTAL_PROCESSED=$((TOTAL_PROCESSED + ${P:-0}))
  TOTAL_PROFILES=$((TOTAL_PROFILES + ${PR:-0}))
  TOTAL_SKIPPED_EXISTING=$((TOTAL_SKIPPED_EXISTING + ${SE:-0}))
  TOTAL_FAILURES=$((TOTAL_FAILURES + ${FA:-0}))

  if [ "$RC" -eq 0 ]; then
    BATCH_OK=$((BATCH_OK + 1))
    echo "  [batch $BATCH_COUNT] OK in ${BATCH_ELAPSED}s (processed=${P:-0} profiles=${PR:-0} skippedExisting=${SE:-0} failures=${FA:-0})"
  else
    BATCH_FAIL=$((BATCH_FAIL + 1))
    FAILED_BATCHES+=("$BATCH_COUNT:$BATCH_LIST(rc=$RC)")
    echo "  [batch $BATCH_COUNT] FAIL rc=$RC in ${BATCH_ELAPSED}s — 继续下一批" >&2
  fi
  echo ""

  i=$((i + BATCH))
done

echo "=== summary ==="
echo "  batches: total=$BATCH_COUNT ok=$BATCH_OK fail=$BATCH_FAIL"
echo "  totals: processed=$TOTAL_PROCESSED profiles=$TOTAL_PROFILES skippedExisting=$TOTAL_SKIPPED_EXISTING failures=$TOTAL_FAILURES"
if [ "$BATCH_FAIL" -gt 0 ]; then
  echo "  failed_batches:"
  for b in "${FAILED_BATCHES[@]}"; do
    echo "    - $b"
  done
  echo "  (per-batch 日志: $OUT/crawl_log.batch-*.log)"
  exit 2
fi
echo "  (per-batch 日志: $OUT/crawl_log.batch-*.log)"
exit 0
