#!/usr/bin/env node
// validate.js — 校验 faculty/data/faculty.db + JSONL 文件的内部一致性。
// 用法： node faculty/scripts/validate.js
// 退出码：0=ok；1=失败

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'faculty.db');
const REQUIRED_CATEGORIES = new Set([
  'business_school', 'management_school',
  'engineering_management', 'industrial_engineering', 'systems_engineering',
  'operations_research', 'decision_science', 'information_systems',
  'business_analytics', 'public_policy',
]);

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
}

(function main() {
  if (!fs.existsSync(DB_PATH)) {
    fail(`faculty.db not found at ${DB_PATH}; run discover.js first`);
    return;
  }
  const db = new sqlite.DatabaseSync(DB_PATH);

  // ---- 部门汇总：50/50 覆盖 ----
  const ranks = new Set();
  const seenRanks = db.prepare('SELECT DISTINCT school_rank FROM department_summary');
  for (const r of seenRanks.all()) ranks.add(r.school_rank);
  if (ranks.size < 50) {
    fail(`department_summary covers only ${ranks.size}/50 schools; re-run with --all to seed`);
  } else {
    console.log(`- department_summary covers ${ranks.size} schools`);
  }

  // ---- 候选人：source_url 唯一 ----
  const dupes = db.prepare(`
    SELECT source_kind, source_url, COUNT(*) AS n
    FROM candidates
    GROUP BY source_kind, source_url
    HAVING n > 1
  `).all();
  if (dupes.length > 0) {
    fail(`candidate duplicates: ${dupes.length}`);
    for (const d of dupes.slice(0, 5)) console.error(`   ${d.source_kind} ${d.source_url} x${d.n}`);
  } else {
    console.log('- candidates: no duplicate (source_kind, source_url)');
  }

  // ---- category 枚举 ----
  const badCategory = db.prepare(`
    SELECT DISTINCT category FROM candidates
    WHERE category NOT IN (${[...REQUIRED_CATEGORIES].map(() => '?').join(',')})
  `).all();
  if (badCategory.length > 0) {
    fail(`unknown category in candidates: ${badCategory.map((r) => r.category).join(', ')}`);
  }

  // ---- crawl_log 状态分布 ----
  const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM crawl_log GROUP BY status ORDER BY n DESC`).all();
  console.log(`- crawl_log status distribution: ${JSON.stringify(Object.fromEntries(statusRows.map((r) => [r.status, r.n])))}`);

  // ---- 总体统计 ----
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM candidates) AS candidates,
      (SELECT COUNT(*) FROM candidates WHERE chinese_name_probability >= 0.4) AS chinese_likely,
      (SELECT COUNT(*) FROM department_summary) AS departments,
      (SELECT COUNT(DISTINCT school_rank) FROM department_summary) AS schools,
      (SELECT COUNT(*) FROM crawl_log) AS crawl_events
  `).get();
  console.log(`- totals: ${JSON.stringify(totals)}`);

  // ---- 每个 QS 排名至少 1 个 department_summary 行 ----
  if (totals.schools < 50) {
    fail(`schools covered = ${totals.schools}/50`);
  } else {
    console.log(`- school coverage: ${totals.schools}/50 (OK)`);
  }

  // ---- jsonl 文件存在且可解析 ----
  for (const name of ['candidates.jsonl', 'crawl_log.jsonl']) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      try { JSON.parse(line); } catch (_) { bad += 1; }
    }
    if (bad > 0) fail(`${name}: ${bad}/${lines.length} invalid JSONL rows`);
    else console.log(`- ${name}: ${lines.length} rows valid`);
  }

  if (process.exitCode === 1) console.error('\nVALIDATION FAILED');
  else console.log('\nVALIDATION OK');
  db.close();
})();
