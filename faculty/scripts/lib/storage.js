// storage.js — 候选人 / 抓取日志 / 部门汇总的存储层。
//
// 双写：
//   - SQLite (node:sqlite) — 便于查询、下游 BRA-8/9/10 复用
//   - JSONL 文件 — 便于人工 cat/grep、版本控制 diff、回放
//
// 公开：
//   - createStore({ dataDir, fs, sqlite, logger }) → Store
//   - store.recordCrawl(...), store.recordCandidate(...), store.recordDepartmentSummary(...)
//   - store.finalize(), store.close()

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candidates (
  id                          TEXT PRIMARY KEY,
  school_rank                 INTEGER NOT NULL,
  school_name_en              TEXT    NOT NULL,
  department_id               TEXT    NOT NULL,
  department_name_en          TEXT    NOT NULL,
  category                    TEXT    NOT NULL,
  source_kind                 TEXT    NOT NULL,
  source_url                  TEXT    NOT NULL,
  source_list_url             TEXT,
  local_path                  TEXT,
  name_raw                    TEXT,
  title_raw                   TEXT,
  email_raw                   TEXT,
  chinese_name_probability    REAL    DEFAULT 0,
  chinese_name_reasons        TEXT,
  review_status               TEXT    NOT NULL DEFAULT 'pending',
  review_notes                TEXT,
  first_seen_at               TEXT    NOT NULL,
  last_seen_at                TEXT    NOT NULL,
  crawl_status                TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_school ON candidates(school_rank);
CREATE INDEX IF NOT EXISTS idx_candidates_dept   ON candidates(department_id);
CREATE INDEX IF NOT EXISTS idx_candidates_chs    ON candidates(chinese_name_probability);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_source ON candidates(source_kind, source_url);

CREATE TABLE IF NOT EXISTS crawl_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  target_kind     TEXT    NOT NULL,
  target_url      TEXT    NOT NULL,
  school_rank     INTEGER,
  department_id   TEXT,
  http_status     INTEGER,
  bytes           INTEGER,
  duration_ms     INTEGER,
  status          TEXT    NOT NULL,
  error_detail    TEXT,
  redirected_to   TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_log(status);
CREATE INDEX IF NOT EXISTS idx_crawl_dept    ON crawl_log(department_id);

CREATE TABLE IF NOT EXISTS department_summary (
  school_rank          INTEGER NOT NULL,
  department_id        TEXT    NOT NULL,
  department_name_en   TEXT    NOT NULL,
  entry_url            TEXT    NOT NULL,
  category             TEXT    NOT NULL,
  needs_js_hint        INTEGER NOT NULL,
  status               TEXT    NOT NULL,
  discovered_list_url  TEXT,
  list_pages_count     INTEGER NOT NULL DEFAULT 0,
  candidates_count     INTEGER NOT NULL DEFAULT 0,
  candidates_chs_count INTEGER NOT NULL DEFAULT 0,
  last_run_at          TEXT,
  last_run_status      TEXT,
  PRIMARY KEY (school_rank, department_id)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

function nowIso() { return new Date().toISOString(); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function createStore({ dataDir, sqlite, logger = console } = {}) {
  if (!dataDir) throw new Error('createStore: dataDir required');
  if (!sqlite) throw new Error('createStore: sqlite (node:sqlite) module required');
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, 'faculty.db');
  const { DatabaseSync } = sqlite;
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const candidatesJsonlPath = path.join(dataDir, 'candidates.jsonl');
  const crawlLogJsonlPath = path.join(dataDir, 'crawl_log.jsonl');
  const writeCandidates = (line) => fs.appendFileSync(candidatesJsonlPath, line);
  const writeCrawl = (line) => fs.appendFileSync(crawlLogJsonlPath, line);

  const insertCandidate = db.prepare(`
    INSERT INTO candidates (
      id, school_rank, school_name_en, department_id, department_name_en, category,
      source_kind, source_url, source_list_url, local_path,
      name_raw, title_raw, email_raw,
      chinese_name_probability, chinese_name_reasons,
      review_status, review_notes,
      first_seen_at, last_seen_at, crawl_status
    ) VALUES (
      @id, @school_rank, @school_name_en, @department_id, @department_name_en, @category,
      @source_kind, @source_url, @source_list_url, @local_path,
      @name_raw, @title_raw, @email_raw,
      @chinese_name_probability, @chinese_name_reasons,
      @review_status, @review_notes,
      @first_seen_at, @last_seen_at, @crawl_status
    )
    ON CONFLICT(source_kind, source_url) DO UPDATE SET
      local_path = excluded.local_path,
      name_raw = excluded.name_raw,
      title_raw = excluded.title_raw,
      email_raw = excluded.email_raw,
      chinese_name_probability = excluded.chinese_name_probability,
      chinese_name_reasons = excluded.chinese_name_reasons,
      last_seen_at = excluded.last_seen_at,
      crawl_status = excluded.crawl_status
  `);
  const insertCrawl = db.prepare(`
    INSERT INTO crawl_log (
      ts, target_kind, target_url, school_rank, department_id,
      http_status, bytes, duration_ms, status, error_detail, redirected_to
    ) VALUES (
      @ts, @target_kind, @target_url, @school_rank, @department_id,
      @http_status, @bytes, @duration_ms, @status, @error_detail, @redirected_to
    )
  `);
  const upsertDept = db.prepare(`
    INSERT INTO department_summary (
      school_rank, department_id, department_name_en, entry_url, category, needs_js_hint, status,
      discovered_list_url, list_pages_count, candidates_count, candidates_chs_count,
      last_run_at, last_run_status
    ) VALUES (
      @school_rank, @department_id, @department_name_en, @entry_url, @category, @needs_js_hint, @status,
      @discovered_list_url, @list_pages_count, @candidates_count, @candidates_chs_count,
      @last_run_at, @last_run_status
    )
    ON CONFLICT(school_rank, department_id) DO UPDATE SET
      department_name_en = excluded.department_name_en,
      entry_url = excluded.entry_url,
      category = excluded.category,
      needs_js_hint = excluded.needs_js_hint,
      status = excluded.status,
      discovered_list_url = COALESCE(department_summary.discovered_list_url, excluded.discovered_list_url),
      list_pages_count = excluded.list_pages_count,
      candidates_count = excluded.candidates_count,
      candidates_chs_count = excluded.candidates_chs_count,
      last_run_at = excluded.last_run_at,
      last_run_status = excluded.last_run_status
  `);
  const setMeta = db.prepare(`INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  const getMeta = db.prepare(`SELECT v FROM meta WHERE k = ?`);
  const countCandidates = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN chinese_name_probability >= 0.4 THEN 1 ELSE 0 END) AS chinese
    FROM candidates
    WHERE school_rank = ? AND department_id = ?
  `);
  // 给 --skip-existing 用：查询 (source_kind, source_url) 的最新 crawl_status
  const findCandidateStatus = db.prepare(`
    SELECT crawl_status FROM candidates
    WHERE source_kind = ? AND source_url = ?
    ORDER BY last_seen_at DESC
    LIMIT 1
  `);

  function setMetaPair(k, v) { setMeta.run(k, v); }
  function getMetaPair(k) { const r = getMeta.get(k); return r ? r.v : null; }

  function recordCrawlLog(entry) {
    const row = {
      ts: entry.ts || nowIso(),
      target_kind: entry.targetKind,
      target_url: entry.targetUrl,
      school_rank: entry.schoolRank ?? null,
      department_id: entry.departmentId ?? null,
      http_status: entry.httpStatus ?? null,
      bytes: entry.bytes ?? null,
      duration_ms: entry.durationMs ?? null,
      status: entry.status,
      error_detail: entry.errorDetail ? String(entry.errorDetail).slice(0, 4096) : null,
      redirected_to: entry.redirectedTo ?? null,
    };
    insertCrawl.run(row);
    writeCrawl(`${JSON.stringify(row)}\n`);
  }

  function recordCandidate(entry) {
    const row = {
      id: entry.id,
      school_rank: entry.schoolRank,
      school_name_en: entry.schoolNameEn,
      department_id: entry.departmentId,
      department_name_en: entry.departmentNameEn,
      category: entry.category,
      source_kind: entry.sourceKind,
      source_url: entry.sourceUrl,
      source_list_url: entry.sourceListUrl ?? null,
      local_path: entry.localPath ?? null,
      name_raw: entry.nameRaw ?? null,
      title_raw: entry.titleRaw ?? null,
      email_raw: entry.emailRaw ?? null,
      chinese_name_probability: entry.chineseNameProbability ?? 0,
      chinese_name_reasons: JSON.stringify(entry.chineseNameReasons || []),
      review_status: entry.reviewStatus || 'pending',
      review_notes: entry.reviewNotes ?? null,
      first_seen_at: entry.firstSeenAt || nowIso(),
      last_seen_at: entry.lastSeenAt || nowIso(),
      crawl_status: entry.crawlStatus,
    };
    insertCandidate.run(row);
    writeCandidates(`${JSON.stringify(row)}\n`);
  }

  function recordDepartmentSummary(entry) {
    const row = {
      school_rank: entry.schoolRank,
      department_id: entry.departmentId,
      department_name_en: entry.departmentNameEn,
      entry_url: entry.entryUrl,
      category: entry.category,
      needs_js_hint: entry.needsJsHint ? 1 : 0,
      status: entry.status,
      discovered_list_url: entry.discoveredListUrl ?? null,
      list_pages_count: entry.listPagesCount ?? 0,
      candidates_count: entry.candidatesCount ?? 0,
      candidates_chs_count: entry.candidatesChsCount ?? 0,
      last_run_at: entry.lastRunAt || nowIso(),
      last_run_status: entry.lastRunStatus,
    };
    upsertDept.run(row);
  }

  function getDeptCounts(schoolRank, departmentId) {
    const r = countCandidates.get(schoolRank, departmentId);
    return { total: r.total || 0, chinese: r.chinese || 0 };
  }

  // 给 --skip-existing 用：返回 (source_kind, source_url) 的最新 crawl_status，
  // 没有该条记录返回 null。
  function getCandidateStatus(sourceKind, sourceUrl) {
    const r = findCandidateStatus.get(sourceKind, sourceUrl);
    return r ? r.crawl_status : null;
  }

  function close() {
    try { db.close(); } catch (_) { /* ignore */ }
  }

  return {
    db,
    dbPath,
    recordCrawlLog,
    recordCandidate,
    recordDepartmentSummary,
    getDeptCounts,
    getCandidateStatus,
    setMeta: setMetaPair,
    getMeta: getMetaPair,
    close,
  };
}

module.exports = { createStore, SCHEMA_SQL };
