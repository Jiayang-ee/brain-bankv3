#!/usr/bin/env node
// openaire_email_enrich.js — BRA-9.3 3a spike 主入口：OpenAIRE /search/researchProducts 邮箱抽取。
//
// 用法：
//   node faculty/scripts/openaire_email_enrich.js --all
//   node faculty/scripts/openaire_email_enrich.js --sample 1000
//   node faculty/scripts/openaire_email_enrich.js --max-queries 100
//   node faculty/scripts/openaire_email_enrich.js --doi 10.1038/s41586-021-03819-2
//   node faculty/scripts/openaire_email_enrich.js --dry-run --sample 10
//
// 退出码：与 crossref_email_enrich.js 对齐（0/1/2）

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const { createOpenaireEmail, normalizeDoi } = require('./lib/openaire_email.js');

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
      console.log('Usage: node faculty/scripts/openaire_email_enrich.js [--all | --doi <doi> | --sample N] [--max-queries N] [--dry-run] [--out DIR] [--verbose]');
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function makeLogger(verbose) {
  return (...args) => { if (verbose) console.error('[openaire-email]', ...args); };
}

function selectDoisFromDb({ dataDir, limit }) {
  const db = new sqlite.DatabaseSync(path.join(dataDir, 'faculty.db'));
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

  const logPath = path.join(dataDir, 'openaire_email_query_log.jsonl');
  const writeLog = (entry) => {
    try { fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`); } catch (_) { /* ignore */ }
  };

  const openaire = createOpenaireEmail({ logger: log });

  let dois = [];
  if (opts.doi) {
    const norm = normalizeDoi(opts.doi);
    if (!norm) { console.error(`--doi value invalid: ${opts.doi}`); process.exit(1); }
    dois = [norm];
  } else if (opts.all || opts.sample > 0 || opts.maxQueries > 0) {
    if (opts.dryRun) {
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
    console.log(JSON.stringify({ selected: 0, processed: 0, with_email: 0, by_status: {}, failures: 0, source: 'openaire' }, null, 2));
    process.exit(0);
  }

  const stats = {
    source: 'openaire',
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
        r = await openaire.processDoi({ doi });
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
      source: 'openaire',
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

const KNOWN_DRY_RUN_DOIS = [
  '10.1038/s41586-021-03819-2',
  '10.1007/s10479-024-06123-0',
  '10.1007/s10479-024-05900-1',
  '10.1287/mnsc.2023.4900',
  '10.1002/joom.1234',
];

main().catch((err) => {
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
