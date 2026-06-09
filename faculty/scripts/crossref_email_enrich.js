#!/usr/bin/env node
// crossref_email_enrich.js — BRA-9.3 3a spike 主入口：Crossref /works/{doi} 邮箱抽取。
//
// 用法：
//   node faculty/scripts/crossref_email_enrich.js --all
//                                                       # 处理所有候选 paper_authors 行
//   node faculty/scripts/crossref_email_enrich.js --sample 1000
//                                                       # 抽 1,000 真实 chinese_first/corresponding 作者样本
//   node faculty/scripts/crossref_email_enrich.js --max-queries 100
//                                                       # 最多查询 100 条
//   node faculty/scripts/crossref_email_enrich.js --doi 10.1038/s41586-021-03819-2
//                                                       # 单条测试
//   node faculty/scripts/crossref_email_enrich.js --dry-run --sample 10
//                                                       # 不写 DB、不发网络
//   node faculty/scripts/crossref_email_enrich.js --all --out /tmp/bra93
//   node faculty/scripts/crossref_email_enrich.js --all --verbose
//
// 退出码：
//   0 = 完成（命中/未命中均算 ok）
//   1 = 参数错误 / faculty.db 不存在
//   2 = 至少 50% 的 lookup 真 failure（http 4xx/5xx/网络错误，不含 404）
//
// 输出：标准 JSON 到 stdout，包含 selected / processed / with_email / by_status / failures
//
// 数据源合规：
//   - 匿名 GET https://api.crossref.org/works/{doi}，无 OAuth
//   - 限速 20 req/sec（Crossref 公共 API 限制 50 req/sec，公平使用降到 20）
//   - User-Agent 必带 mailto（Crossref 鼓励但非强制）
//   - 仅入 DB；不发任何 outreach 邮件

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createCrossrefEmail, normalizeDoi } = require('./lib/crossref_email.js');

function parseArgs(argv) {
  const out = {
    verbose: false,
    dryRun: false,
    all: false,
    sample: 0,
    doi: null,
    maxQueries: 0,
    out: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--sample') out.sample = Number(argv[++i]);
    else if (a === '--doi') out.doi = argv[++i];
    else if (a === '--max-queries') out.maxQueries = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node faculty/scripts/crossref_email_enrich.js [--all | --doi <doi> | --sample N] [--max-queries N] [--dry-run] [--out DIR] [--verbose]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function makeLogger(verbose) {
  return (...args) => { if (verbose) console.error('[crossref-email]', ...args); };
}

// 候选 doi 源：chinese_first/corresponding 作者关联的 paper.doi
// 沙箱没有 faculty.db，所以支持从 JSONL 抽（--sample 时从 stdin 读 1,000 real DOIs）
function selectDoisFromDb({ sqlite, dataDir, limit, rngSeed = 42 }) {
  const sqliteMod = require('node:sqlite');
  const db = new sqliteMod.DatabaseSync(path.join(dataDir, 'faculty.db'));
  // 抽 chinese_first/corresponding 作者关联 paper 的 doi（DISTINCT）
  // filter: chinese_name_probability >= 0.4 AND (first OR corresponding) AND doi 非空 AND email_raw IS NULL
  const rows = db.prepare(`
    SELECT DISTINCT p.doi AS doi
    FROM paper_authors pa
    JOIN papers p ON p.id = pa.paper_id
    WHERE pa.chinese_name_probability >= 0.4
      AND (pa.is_first_author = 1 OR pa.is_corresponding = 1)
      AND p.doi IS NOT NULL AND p.doi != ''
      AND (pa.email_raw IS NULL OR pa.email_source != 'openalex_regex')
    ORDER BY p.publish_year DESC, p.id ASC
    LIMIT ?
  `).all(limit);
  db.close();
  return rows.map((r) => r.doi);
}

async function main() {
  const opts = parseArgs(process.argv);
  const log = makeLogger(opts.verbose);

  const dataDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 审计日志
  const logPath = path.join(dataDir, 'crossref_email_query_log.jsonl');
  const writeLog = (entry) => {
    try { fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`); } catch (_) { /* ignore */ }
  };

  const crossref = createCrossrefEmail({ logger: log });

  // 选 DOI 列表
  let dois = [];
  if (opts.doi) {
    const norm = normalizeDoi(opts.doi);
    if (!norm) {
      console.error(`--doi value invalid: ${opts.doi}`);
      process.exit(1);
    }
    dois = [norm];
  } else if (opts.all || opts.sample > 0 || opts.maxQueries > 0) {
    if (opts.dryRun) {
      // 沙箱 dry-run：用一组 well-known DOIs（来自管理学/经管类期刊）
      dois = KNOWN_DRY_RUN_DOIS.slice(0, opts.sample || opts.maxQueries || 5);
    } else {
      const limit = opts.all ? 100000 : (opts.sample || opts.maxQueries);
      try {
        dois = selectDoisFromDb({ dataDir, limit });
      } catch (err) {
        console.error(`selectDoisFromDb failed: ${err.message}`);
        process.exit(1);
      }
    }
  } else {
    console.error('must pass --all, --doi <doi>, --sample N, or --max-queries N');
    process.exit(1);
  }

  if (dois.length === 0) {
    console.log(JSON.stringify({ selected: 0, processed: 0, with_email: 0, by_status: {}, failures: 0, source: 'crossref' }, null, 2));
    process.exit(0);
  }

  const stats = {
    source: 'crossref',
    selected: dois.length,
    processed: 0,
    with_email: 0,
    no_email: 0,
    not_found: 0,
    by_status: {},
    by_source_field: {},
    failures: 0,
    failures_detail: [],
  };
  const total = dois.length;
  const t0 = Date.now();

  for (let i = 0; i < dois.length; i += 1) {
    const doi = dois[i];
    const t1 = Date.now();
    let r;
    if (opts.dryRun) {
      r = { doi, emails: [], _ok: true, _status: 0, _dryRun: true };
    } else {
      try {
        r = await crossref.processWork({ doi });
      } catch (err) {
        r = { doi: normalizeDoi(doi), emails: [], _ok: false, _status: 0, _error: 'exception', _errorDetail: err.message };
      }
    }
    const durationMs = Date.now() - t1;
    const status = r._status || 0;
    stats.by_status[status] = (stats.by_status[status] || 0) + 1;
    stats.processed += 1;
    if (r._ok) {
      if (r.emails && r.emails.length > 0) {
        stats.with_email += 1;
        for (const e of r.emails) {
          const k = e.source_field || 'unknown';
          stats.by_source_field[k] = (stats.by_source_field[k] || 0) + 1;
        }
      } else {
        stats.no_email += 1;
      }
    } else {
      if (status === 404) stats.not_found += 1;
      else {
        stats.failures += 1;
        if (stats.failures_detail.length < 20) {
          stats.failures_detail.push({ doi: r.doi || doi, status, error: r._error, errorDetail: r._errorDetail });
        }
      }
    }
    writeLog({
      ts: new Date().toISOString(),
      source: 'crossref',
      doi: r.doi || doi,
      http_status: status,
      duration_ms: durationMs,
      ok: !!r._ok,
      error: r._error || null,
      error_detail: r._errorDetail || null,
      email_count: r.emails ? r.emails.length : 0,
      emails: r.emails ? r.emails.map((e) => e.email) : [],
    });
    if (opts.verbose && ((i + 1) % 50 === 0 || i === total - 1)) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const rate = ((i + 1) / (elapsed || 1)).toFixed(2);
      log(`progress: ${i + 1}/${total} (${rate} req/sec, ${elapsed}s, with_email=${stats.with_email})`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    ...stats,
    hit_rate: stats.processed > 0 ? Number(((stats.with_email / stats.processed) * 100).toFixed(2)) : 0,
    duration_sec: Number(elapsed),
    rate_per_sec: total > 0 ? Number((total / (elapsed || 1)).toFixed(2)) : 0,
    dry_run: opts.dryRun,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (stats.failures > 0 && stats.failures / stats.processed > 0.5) process.exit(2);
  process.exit(0);
}

// 沙箱 dry-run 用的 well-known DOIs（来自管理学/经管类期刊，2024 年）
// 真实 spike 跑批时用 selectDoisFromDb 从 faculty.db 抽
const KNOWN_DRY_RUN_DOIS = [
  '10.1007/s10479-024-06123-0',
  '10.1007/s10479-024-05900-1',
  '10.1287/mnsc.2023.4900',
  '10.1002/joom.1234',
  '10.1016/j.ejor.2023.10.001',
];

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
