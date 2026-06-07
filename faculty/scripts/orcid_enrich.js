#!/usr/bin/env node
// orcid_enrich.js — 主入口：ORCID 公共 API 反向查询补全 author email + profile（BRA-9.2 spike）。
//
// 用法：
//   node faculty/scripts/orcid_enrich.js --all                          # 处理所有候选 ORCID
//   node faculty/scripts/orcid_enrich.js --orcid 0000-0000-0000-0000    # 单条测试
//   node faculty/scripts/orcid_enrich.js --max-queries 100              # 最多查询 100 条
//   node faculty/scripts/orcid_enrich.js --force                        # 忽略 30 天增量窗口
//   node faculty/scripts/orcid_enrich.js --dry-run                      # 不写 DB、不发网络
//   node faculty/scripts/orcid_enrich.js --out /tmp/bra92               # 自定义输出目录
//   node faculty/scripts/orcid_enrich.js --verbose
//
// 退出码：
//   0 = 完成（命中/未命中均算 ok）
//   1 = 参数错误 / faculty.db 不存在
//   2 = 至少 50% 的 lookup 真 failure（http 4xx/5xx/网络错误，不含 404）
//
// 输出：标准 JSON 到 stdout，包含 selected / processed / with_orcid_email / by_status / failures
//
// 数据源合规：
//   - 匿名 GET https://pub.orcid.org/v3.0/{id}/person，无 OAuth 写 scope
//   - 限速 5 req/sec/IP（ORCID 公共 API anonymous 限速 6 req/sec）
//   - User-Agent 必带 mailto（ORCID 鼓励但非强制）
//   - 仅入 DB；不发任何 outreach 邮件

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createStore } = require('./lib/storage.js');
const { createOrcidEnrich, normalizeOrcidId } = require('./lib/orcid_enrich.js');

function parseArgs(argv) {
  const out = {
    verbose: false,
    dryRun: false,
    all: false,
    orcid: null,
    maxQueries: 0,
    force: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--orcid') out.orcid = argv[++i];
    else if (a === '--max-queries') out.maxQueries = Number(argv[++i]);
    else if (a === '--force') out.force = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node faculty/scripts/orcid_enrich.js [--all | --orcid XXXX-XXXX-XXXX-XXXX] [--max-queries N] [--force] [--dry-run] [--out DIR] [--verbose]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function makeLogger(verbose) {
  return (...args) => { if (verbose) console.error('[orcid]', ...args); };
}

function parseOrcidList(text) {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeOrcidId(s))
    .filter(Boolean);
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = makeLogger(opts.verbose);

  const dataDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'faculty.db');
  if (!opts.dryRun && !fs.existsSync(dbPath)) {
    console.error(`faculty.db not found at ${dbPath}; run papers.js --all first, or use --dry-run`);
    process.exit(1);
  }

  // 审计日志：每条 ORCID API 调用都写一行（含 HTTP status / latency / response hash）
  const logPath = path.join(dataDir, 'orcid_query_log.jsonl');
  const writeLog = (entry) => {
    try { fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`); } catch (_) { /* ignore */ }
  };

  const store = opts.dryRun ? null : createStore({ dataDir, sqlite });
  const orcid = createOrcidEnrich({ logger: log });

  let targets = [];
  if (opts.orcid) {
    const ids = Array.isArray(opts.orcid) ? opts.orcid : [opts.orcid];
    const norm = ids.map(normalizeOrcidId).filter(Boolean);
    if (norm.length === 0) {
      console.error(`--orcid value invalid: ${opts.orcid}`);
      process.exit(1);
    }
    // --orcid 单条测试：构造一行虚拟 record，无 id（仅测 processAuthor 自身，不写 DB）
    targets = norm.map((oc) => ({ id: null, paper_id: null, author_name: null, orcid: oc, orcid_last_fetched: null }));
  } else if (opts.all || opts.maxQueries > 0) {
    const limit = opts.maxQueries > 0 ? opts.maxQueries : 50000;
    targets = store.selectOrcidLookupRows({ limit, force: opts.force });
    log(`selected ${targets.length} ORCID candidates from paper_authors`);
  } else {
    console.error('must pass --all, --orcid <id>, or --max-queries <N>');
    process.exit(1);
  }

  if (targets.length === 0) {
    console.log(JSON.stringify({ selected: 0, processed: 0, with_orcid_email: 0, by_status: {}, failures: 0, failures_detail: [] }, null, 2));
    if (store) store.close();
    process.exit(0);
  }

  const stats = {
    selected: targets.length,
    processed: 0,
    with_orcid_email: 0,
    no_email_public: 0,
    not_found: 0,
    by_status: {},
    failures: 0,
    failures_detail: [],
  };
  const total = targets.length;
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i += 1) {
    const row = targets[i];
    const t1 = Date.now();
    let r;
    if (opts.dryRun) {
      // dry-run: 不发请求
      r = {
        _ok: true,
        _status: 0,
        _dryRun: true,
        _orcid: row.orcid,
      };
    } else {
      try {
        r = await orcid.processAuthor({ id: row.id, orcid: row.orcid });
      } catch (err) {
        r = {
          id: row.id,
          _ok: false,
          _status: 0,
          _error: 'exception',
          _errorDetail: err.message,
          _orcid: row.orcid,
        };
      }
    }
    const durationMs = Date.now() - t1;
    const status = r._status || 0;
    stats.by_status[status] = (stats.by_status[status] || 0) + 1;
    stats.processed += 1;
    if (r._ok) {
      if (r.emailRaw) stats.with_orcid_email += 1;
      else stats.no_email_public += 1;
    } else {
      if (status === 404) stats.not_found += 1;
      else {
        stats.failures += 1;
        stats.failures_detail.push({ orcid: r._orcid || row.orcid, status, error: r._error, errorDetail: r._errorDetail });
      }
    }
    // 审计日志
    writeLog({
      ts: new Date().toISOString(),
      orcid: r._orcid || row.orcid,
      author_id: row.id,
      paper_id: row.paper_id,
      author_name: row.author_name,
      http_status: status,
      duration_ms: durationMs,
      ok: !!r._ok,
      error: r._error || null,
      error_detail: r._errorDetail || null,
      has_email: !!r.emailRaw,
      external_ids_count: r._external_ids_count || 0,
      affiliations_count: r._affiliations_count || 0,
    });
    // 写 DB：成功（_ok）+ 永久不存在（404）都更新 orcid_last_fetched，
    // 避免 30 天内重复打 API。临时错误（5xx / 网络）不写 last_fetched，下次重试
    const shouldWriteBack = !opts.dryRun && row.id && (r._ok || r._status === 404);
    if (shouldWriteBack) {
      try {
        store.recordOrcidProfile({
          id: row.id,
          emailOrcidId: r.emailOrcidId || null,
          orcidCreditName: r.orcidCreditName || null,
          orcidExternalIdsJson: r.orcidExternalIdsJson || null,
          orcidAffiliationsJson: r.orcidAffiliationsJson || null,
          orcidLastModified: r.orcidLastModified || null,
          orcidLastFetched: r.orcidLastFetched || new Date().toISOString(),
          orcidProfileJson: r.orcidProfileJson || null,
          emailRaw: r.emailRaw || null,
          emailSource: r.emailSource || null,
        });
      } catch (err) {
        log(`[error] recordOrcidProfile failed for id=${row.id}: ${err.message}`);
      }
    }
    if (opts.verbose && ((i + 1) % 10 === 0 || i === total - 1)) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = ((i + 1) / (elapsed || 1)).toFixed(2);
      log(`progress: ${i + 1}/${total} (${rate} req/sec, ${elapsed}s elapsed)`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    ...stats,
    duration_sec: Number(elapsed),
    rate_per_sec: total > 0 ? Number((total / (elapsed || 1)).toFixed(2)) : 0,
    dry_run: opts.dryRun,
  };
  console.log(JSON.stringify(summary, null, 2));

  // 退出码
  if (store) store.close();
  // 失败率 > 50% 视为 spike 真问题
  if (stats.failures > 0 && stats.failures / stats.processed > 0.5) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
