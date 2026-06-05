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

-- 注：headshot_* 列通过 ensureColumn() 幂等迁移添加，避免重复 ADD COLUMN 报错
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

// 幂等 ALTER TABLE ADD COLUMN：列已存在则跳过
function ensureColumn(db, table, column, decl) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function createStore({ dataDir, sqlite, logger = console } = {}) {
  if (!dataDir) throw new Error('createStore: dataDir required');
  if (!sqlite) throw new Error('createStore: sqlite (node:sqlite) module required');
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, 'faculty.db');
  const { DatabaseSync } = sqlite;
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  // 幂等迁移：BRA-8 给 candidates 加 headshot_* 列（SQLite ADD COLUMN 不可重复）
  ensureColumn(db, 'candidates', 'headshot_url', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_local_path', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_content_type', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_bytes', 'INTEGER');
  ensureColumn(db, 'candidates', 'headshot_crawl_status', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_fetched_at', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_error_detail', 'TEXT');
  ensureColumn(db, 'candidates', 'headshot_source_url', 'TEXT');
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_headshot_status ON candidates(headshot_crawl_status)`); } catch (_) { /* ignore */ }

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
  // BRA-8: 候选人照片字段更新
  const updateHeadshot = db.prepare(`
    UPDATE candidates SET
      headshot_url = @headshot_url,
      headshot_local_path = @headshot_local_path,
      headshot_content_type = @headshot_content_type,
      headshot_bytes = @headshot_bytes,
      headshot_crawl_status = @headshot_crawl_status,
      headshot_fetched_at = @headshot_fetched_at,
      headshot_error_detail = @headshot_error_detail,
      headshot_source_url = @headshot_source_url
    WHERE id = @id
  `);
  const selectHeadshotCandidates = db.prepare(`
    SELECT id, school_rank, school_name_en, department_id, source_url, local_path,
           headshot_crawl_status
    FROM candidates
    WHERE source_kind = 'personal_page'
      AND crawl_status = 'success'
      AND local_path IS NOT NULL
      AND (@only_pending = 0 OR headshot_crawl_status IS NULL OR headshot_crawl_status != 'success' OR @force = 1)
      AND (@school_rank IS NULL OR school_rank = @school_rank)
    ORDER BY school_rank ASC, department_id ASC, id ASC
    LIMIT @limit
  `);
  const countByStatus = db.prepare(`
    SELECT headshot_crawl_status AS status, COUNT(*) AS n
    FROM candidates
    WHERE source_kind = 'personal_page' AND headshot_crawl_status IS NOT NULL
    GROUP BY headshot_crawl_status
  `);
  const headshotAggregate = db.prepare(`
    SELECT
      SUM(CASE WHEN headshot_crawl_status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN headshot_crawl_status = 'no_photo' THEN 1 ELSE 0 END) AS no_photo,
      SUM(CASE WHEN headshot_crawl_status IS NULL THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM candidates
    WHERE source_kind = 'personal_page'
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

  // BRA-8: 写回照片抓取结果
  function recordHeadshot(entry) {
    updateHeadshot.run({
      id: entry.id,
      headshot_url: entry.headshotUrl ?? null,
      headshot_local_path: entry.headshotLocalPath ?? null,
      headshot_content_type: entry.headshotContentType ?? null,
      headshot_bytes: entry.headshotBytes ?? null,
      headshot_crawl_status: entry.headshotCrawlStatus,
      headshot_fetched_at: entry.headshotFetchedAt || nowIso(),
      headshot_error_detail: entry.headshotErrorDetail
        ? String(entry.headshotErrorDetail).slice(0, 4096)
        : null,
      headshot_source_url: entry.headshotSourceUrl ?? null,
    });
  }

  // BRA-8: 选出需要处理照片的候选人
  function selectPhotoCandidates({ schoolRank = null, onlyPending = true, force = false, limit = 100000 } = {}) {
    return selectHeadshotCandidates.all({
      only_pending: onlyPending ? 1 : 0,
      force: force ? 1 : 0,
      school_rank: schoolRank,
      limit,
    });
  }

  // BRA-8: 统计 headshot_crawl_status 分布
  function getHeadshotStats() {
    const dist = {};
    for (const r of countByStatus.all()) dist[r.status || 'pending'] = r.n;
    const agg = headshotAggregate.get();
    return { distribution: dist, totals: agg || { success: 0, no_photo: 0, pending: 0, total: 0 } };
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
    recordHeadshot,
    selectPhotoCandidates,
    getHeadshotStats,
    getDeptCounts,
    setMeta: setMetaPair,
    getMeta: getMetaPair,
    close,
  };
}

module.exports = { createStore, SCHEMA_SQL };
