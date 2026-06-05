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

-- BRA-9 期刊论文与作者：附件期刊清单 + OpenAlex / Crossref 查询产物。
--
-- 期刊表 (journals)：每行一个 CSV 期刊条目，带原始 8 字段 + 解析后的源 ID + 查询结果统计
-- 论文表 (papers)：每个 paper 一行（按 doi 或 sha1(source|normalized_title|year) 唯一）
-- 论文作者表 (paper_authors)：每个 paper 的 authorships 一行（带华人初筛分数 + 是否 target candidate）
--
-- target candidate 规则：is_first_author=1 OR is_last_author=1 OR is_corresponding=1
--                            AND chinese_name_probability >= chinese_threshold (默认 0.4)
--
-- 设计要点：
--   1. journals / papers / paper_authors 沿用 candidates 的 (id, first_seen_at, last_seen_at) 三件套
--   2. paper_authors 唯一性按 (paper_id, author_position, normalized_name) — 同一篇 paper 同位置同人重抓幂等
--   3. 论文按 doi 唯一（doi 缺失时退化到 sha1 哈希）
--   4. 所有 JSON 字段以 TEXT 存（chinese_name_reasons / negatives 等）
CREATE TABLE IF NOT EXISTS journals (
  id                    TEXT PRIMARY KEY,        -- sha1(source_file|journal_name|issn_canonical)
  source_file           TEXT    NOT NULL,        -- CSV 的 "来源文件" 字段
  journal_system        TEXT,                    -- 中文期刊 / 英文期刊
  discipline            TEXT,                    -- 学科/方向
  journal_name_raw      TEXT    NOT NULL,        -- 期刊名称原文（CSV）
  journal_name_en       TEXT,                    -- 规范化后的英文名（OpenAlex 解析后回填）
  issn_raw              TEXT,                    -- CSV 的 "ISSN/CN" 字段原文
  issn_print            TEXT,                    -- 解析后的 print-ISSN（去横线）
  issn_electronic       TEXT,                    -- 解析后的 electronic-ISSN
  issn_l                TEXT,                    -- OpenAlex/Crossref 解析后的 linking-ISSN
  cn_code               TEXT,                    -- 中文期刊的 CN 号（11-1235/F 等）
  school_level          TEXT,                    -- A+/A/A1/A2
  usage                 TEXT,                    -- 人才库用途
  notes                 TEXT,                    -- 备注
  -- 解析后的外部源 ID
  openalex_source_id    TEXT,                    -- OpenAlex source ID (S...)
  crossref_issn         TEXT,                    -- Crossref 用的 ISSN
  -- 查询结果
  query_status          TEXT,                    -- 'success' | 'no_results' | 'api_unsupported' | 'manual_required' | 'failed'
  papers_found          INTEGER NOT NULL DEFAULT 0,
  papers_kept           INTEGER NOT NULL DEFAULT 0,
  authors_found         INTEGER NOT NULL DEFAULT 0,
  authors_chs           INTEGER NOT NULL DEFAULT 0,
  authors_target        INTEGER NOT NULL DEFAULT 0,  -- 一作/通讯作者 + 疑似华人
  last_query_at         TEXT,
  error_detail          TEXT,                    -- 截断到 4KB
  first_seen_at         TEXT    NOT NULL,
  last_seen_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journals_status   ON journals(query_status);
CREATE INDEX IF NOT EXISTS idx_journals_oa_id    ON journals(openalex_source_id);
CREATE INDEX IF NOT EXISTS idx_journals_issn     ON journals(issn_l);
CREATE INDEX IF NOT EXISTS idx_journals_system   ON journals(journal_system);

CREATE TABLE IF NOT EXISTS papers (
  id                TEXT PRIMARY KEY,            -- doi 不为空时 = 'doi:'+lowercase_doi；否则 sha1(source|normalized_title|year|journal_id)
  doi               TEXT,                        -- 原文（lowercase, strip https://doi.org/）
  openalex_id       TEXT,                        -- OpenAlex Work ID (W...)
  title             TEXT    NOT NULL,
  journal_id        TEXT    NOT NULL,            -- 关联 journals.id
  journal_name      TEXT    NOT NULL,            -- 冗余方便 join-less 查询
  issn              TEXT,                        -- 该 paper 解析后的 issn-l
  publish_year      INTEGER,
  publish_date      TEXT,                        -- ISO8601 'YYYY-MM-DD'（如有）
  volume            TEXT,
  issue             TEXT,
  page              TEXT,
  paper_type        TEXT,                        -- 'article' | 'review' | 'letter' | ...
  cited_by_count    INTEGER,
  language          TEXT,                        -- 'en' | 'zh' | ...
  source            TEXT    NOT NULL,            -- 'openalex' | 'crossref'
  source_url        TEXT,                        -- 论文主页 URL（OpenAlex/Crossref/DOI）
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  FOREIGN KEY (journal_id) REFERENCES journals(id)
);
CREATE INDEX IF NOT EXISTS idx_papers_journal  ON papers(journal_id);
CREATE INDEX IF NOT EXISTS idx_papers_doi      ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_year     ON papers(publish_year);
CREATE INDEX IF NOT EXISTS idx_papers_source   ON papers(source);

CREATE TABLE IF NOT EXISTS paper_authors (
  id                        TEXT PRIMARY KEY,    -- sha1(paper_id|author_position|normalized_name)
  paper_id                  TEXT    NOT NULL,    -- 关联 papers.id
  author_name               TEXT    NOT NULL,    -- 原文姓名
  author_position           INTEGER NOT NULL,    -- 0-based
  is_first_author           INTEGER NOT NULL DEFAULT 0,  -- position == 0
  is_last_author            INTEGER NOT NULL DEFAULT 0,  -- position == total-1 (per-paper)
  is_corresponding          INTEGER NOT NULL DEFAULT 0,  -- OpenAlex/Crossref 标记
  affiliation_raw           TEXT,                -- 原始机构字符串
  affiliation_id            TEXT,                -- OpenAlex inst ID 或 Crossref aff id
  affiliation_name          TEXT,                -- 机构英文名
  orcid                     TEXT,
  chinese_name_probability  REAL    DEFAULT 0,
  chinese_name_reasons      TEXT,                -- JSON array
  chinese_name_negatives    TEXT,                -- JSON array
  is_target_candidate       INTEGER NOT NULL DEFAULT 0,  -- (first/last/corresponding) AND chinese_likely
  -- BRA-9.1 邮箱 enrich：path A (openalex_regex) 兜底，path B (publisher_*) 预留
  email_raw                 TEXT,                -- 抽到的邮箱原文
  email_source              TEXT,                -- 'openalex_regex' | 'publisher_wiley' | 'publisher_elsevier' | 'manual'
  email_match_context       TEXT,                -- 命中哪条 affiliation 字符串（截断 500 字符）
  first_seen_at             TEXT    NOT NULL,
  last_seen_at              TEXT    NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pa_paper    ON paper_authors(paper_id);
CREATE INDEX IF NOT EXISTS idx_pa_chs      ON paper_authors(chinese_name_probability);
CREATE INDEX IF NOT EXISTS idx_pa_target   ON paper_authors(is_target_candidate);
CREATE INDEX IF NOT EXISTS idx_pa_first    ON paper_authors(is_first_author);
CREATE INDEX IF NOT EXISTS idx_pa_corr     ON paper_authors(is_corresponding);
CREATE INDEX IF NOT EXISTS idx_pa_email_source ON paper_authors(email_source);
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
  // 幂等迁移：BRA-9.1 给 paper_authors 加 email_raw / email_source / email_match_context 列
  ensureColumn(db, 'paper_authors', 'email_raw', 'TEXT');
  ensureColumn(db, 'paper_authors', 'email_source', 'TEXT');
  ensureColumn(db, 'paper_authors', 'email_match_context', 'TEXT');
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_email_source ON paper_authors(email_source)`); } catch (_) { /* ignore */ }

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

  // ---- BRA-9: 期刊 / 论文 / 论文作者 ----
  const papersJsonlPath = path.join(dataDir, 'papers.jsonl');
  const paperAuthorsJsonlPath = path.join(dataDir, 'paper_authors.jsonl');
  const journalsJsonlPath = path.join(dataDir, 'journals.jsonl');
  const writePapers = (line) => fs.appendFileSync(papersJsonlPath, line);
  const writePaperAuthors = (line) => fs.appendFileSync(paperAuthorsJsonlPath, line);
  const writeJournals = (line) => fs.appendFileSync(journalsJsonlPath, line);

  const insertJournal = db.prepare(`
    INSERT INTO journals (
      id, source_file, journal_system, discipline,
      journal_name_raw, journal_name_en,
      issn_raw, issn_print, issn_electronic, issn_l, cn_code,
      school_level, usage, notes,
      openalex_source_id, crossref_issn,
      query_status, papers_found, papers_kept,
      authors_found, authors_chs, authors_target,
      last_query_at, error_detail,
      first_seen_at, last_seen_at
    ) VALUES (
      @id, @source_file, @journal_system, @discipline,
      @journal_name_raw, @journal_name_en,
      @issn_raw, @issn_print, @issn_electronic, @issn_l, @cn_code,
      @school_level, @usage, @notes,
      @openalex_source_id, @crossref_issn,
      @query_status, @papers_found, @papers_kept,
      @authors_found, @authors_chs, @authors_target,
      @last_query_at, @error_detail,
      @first_seen_at, @last_seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      journal_system = excluded.journal_system,
      discipline = excluded.discipline,
      journal_name_en = excluded.journal_name_en,
      issn_raw = excluded.issn_raw,
      issn_print = excluded.issn_print,
      issn_electronic = excluded.issn_electronic,
      issn_l = excluded.issn_l,
      cn_code = excluded.cn_code,
      school_level = excluded.school_level,
      usage = excluded.usage,
      notes = excluded.notes,
      openalex_source_id = excluded.openalex_source_id,
      crossref_issn = excluded.crossref_issn,
      query_status = excluded.query_status,
      papers_found = excluded.papers_found,
      papers_kept = excluded.papers_kept,
      authors_found = excluded.authors_found,
      authors_chs = excluded.authors_chs,
      authors_target = excluded.authors_target,
      last_query_at = excluded.last_query_at,
      error_detail = excluded.error_detail,
      last_seen_at = excluded.last_seen_at
  `);

  const insertPaper = db.prepare(`
    INSERT INTO papers (
      id, doi, openalex_id, title, journal_id, journal_name, issn,
      publish_year, publish_date, volume, issue, page, paper_type,
      cited_by_count, language, source, source_url,
      first_seen_at, last_seen_at
    ) VALUES (
      @id, @doi, @openalex_id, @title, @journal_id, @journal_name, @issn,
      @publish_year, @publish_date, @volume, @issue, @page, @paper_type,
      @cited_by_count, @language, @source, @source_url,
      @first_seen_at, @last_seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      doi = COALESCE(excluded.doi, papers.doi),
      openalex_id = COALESCE(excluded.openalex_id, papers.openalex_id),
      title = excluded.title,
      journal_id = excluded.journal_id,
      journal_name = excluded.journal_name,
      issn = COALESCE(excluded.issn, papers.issn),
      publish_year = excluded.publish_year,
      publish_date = excluded.publish_date,
      volume = excluded.volume,
      issue = excluded.issue,
      page = excluded.page,
      paper_type = excluded.paper_type,
      cited_by_count = COALESCE(excluded.cited_by_count, papers.cited_by_count),
      language = excluded.language,
      source = excluded.source,
      source_url = excluded.source_url,
      last_seen_at = excluded.last_seen_at
  `);

  const insertPaperAuthor = db.prepare(`
    INSERT INTO paper_authors (
      id, paper_id, author_name, author_position,
      is_first_author, is_last_author, is_corresponding,
      affiliation_raw, affiliation_id, affiliation_name, orcid,
      chinese_name_probability, chinese_name_reasons, chinese_name_negatives,
      is_target_candidate,
      email_raw, email_source, email_match_context,
      first_seen_at, last_seen_at
    ) VALUES (
      @id, @paper_id, @author_name, @author_position,
      @is_first_author, @is_last_author, @is_corresponding,
      @affiliation_raw, @affiliation_id, @affiliation_name, @orcid,
      @chinese_name_probability, @chinese_name_reasons, @chinese_name_negatives,
      @is_target_candidate,
      @email_raw, @email_source, @email_match_context,
      @first_seen_at, @last_seen_at
    )
    ON CONFLICT(id) DO UPDATE SET
      author_name = excluded.author_name,
      is_first_author = excluded.is_first_author,
      is_last_author = excluded.is_last_author,
      is_corresponding = excluded.is_corresponding,
      affiliation_raw = excluded.affiliation_raw,
      affiliation_id = excluded.affiliation_id,
      affiliation_name = excluded.affiliation_name,
      orcid = excluded.orcid,
      chinese_name_probability = excluded.chinese_name_probability,
      chinese_name_reasons = excluded.chinese_name_reasons,
      chinese_name_negatives = excluded.chinese_name_negatives,
      is_target_candidate = excluded.is_target_candidate,
      email_raw = excluded.email_raw,
      email_source = excluded.email_source,
      email_match_context = excluded.email_match_context,
      last_seen_at = excluded.last_seen_at
  `);

  const journalStatsQ = db.prepare(`
    SELECT
      query_status, COUNT(*) AS n
    FROM journals
    GROUP BY query_status
  `);
  const paperStatsQ = db.prepare(`
    SELECT
      COUNT(*) AS total_papers,
      SUM(CASE WHEN publish_year >= 2021 AND publish_year <= 2026 THEN 1 ELSE 0 END) AS in_range
    FROM papers
  `);
  const authorStatsQ = db.prepare(`
    SELECT
      COUNT(*) AS total_authors,
      SUM(CASE WHEN is_target_candidate = 1 THEN 1 ELSE 0 END) AS target_candidates,
      SUM(CASE WHEN chinese_name_probability >= 0.4 THEN 1 ELSE 0 END) AS chinese_likely
    FROM paper_authors
  `);

  function recordJournal(entry) {
    const row = {
      id: entry.id,
      source_file: entry.sourceFile,
      journal_system: entry.journalSystem ?? null,
      discipline: entry.discipline ?? null,
      journal_name_raw: entry.journalNameRaw,
      journal_name_en: entry.journalNameEn ?? null,
      issn_raw: entry.issnRaw ?? null,
      issn_print: entry.issnPrint ?? null,
      issn_electronic: entry.issnElectronic ?? null,
      issn_l: entry.issnL ?? null,
      cn_code: entry.cnCode ?? null,
      school_level: entry.schoolLevel ?? null,
      usage: entry.usage ?? null,
      notes: entry.notes ?? null,
      openalex_source_id: entry.openalexSourceId ?? null,
      crossref_issn: entry.crossrefIssn ?? null,
      query_status: entry.queryStatus ?? 'pending',
      papers_found: entry.papersFound ?? 0,
      papers_kept: entry.papersKept ?? 0,
      authors_found: entry.authorsFound ?? 0,
      authors_chs: entry.authorsChs ?? 0,
      authors_target: entry.authorsTarget ?? 0,
      last_query_at: entry.lastQueryAt ?? null,
      error_detail: entry.errorDetail ? String(entry.errorDetail).slice(0, 4096) : null,
      first_seen_at: entry.firstSeenAt || nowIso(),
      last_seen_at: entry.lastSeenAt || nowIso(),
    };
    insertJournal.run(row);
    writeJournals(`${JSON.stringify(row)}\n`);
    return row;
  }

  function recordPaper(entry) {
    const row = {
      id: entry.id,
      doi: entry.doi ?? null,
      openalex_id: entry.openalexId ?? null,
      title: entry.title,
      journal_id: entry.journalId,
      journal_name: entry.journalName,
      issn: entry.issn ?? null,
      publish_year: entry.publishYear ?? null,
      publish_date: entry.publishDate ?? null,
      volume: entry.volume ?? null,
      issue: entry.issue ?? null,
      page: entry.page ?? null,
      paper_type: entry.paperType ?? null,
      cited_by_count: entry.citedByCount ?? null,
      language: entry.language ?? null,
      source: entry.source,
      source_url: entry.sourceUrl ?? null,
      first_seen_at: entry.firstSeenAt || nowIso(),
      last_seen_at: entry.lastSeenAt || nowIso(),
    };
    insertPaper.run(row);
    writePapers(`${JSON.stringify(row)}\n`);
    return row;
  }

  function recordPaperAuthor(entry) {
    const row = {
      id: entry.id,
      paper_id: entry.paperId,
      author_name: entry.authorName,
      author_position: entry.authorPosition,
      is_first_author: entry.isFirstAuthor ? 1 : 0,
      is_last_author: entry.isLastAuthor ? 1 : 0,
      is_corresponding: entry.isCorresponding ? 1 : 0,
      affiliation_raw: entry.affiliationRaw ?? null,
      affiliation_id: entry.affiliationId ?? null,
      affiliation_name: entry.affiliationName ?? null,
      orcid: entry.orcid ?? null,
      chinese_name_probability: entry.chineseNameProbability ?? 0,
      chinese_name_reasons: JSON.stringify(entry.chineseNameReasons || []),
      chinese_name_negatives: JSON.stringify(entry.chineseNameNegatives || []),
      is_target_candidate: entry.isTargetCandidate ? 1 : 0,
      email_raw: entry.emailRaw ?? null,
      email_source: entry.emailSource ?? null,
      email_match_context: entry.emailMatchContext
        ? String(entry.emailMatchContext).slice(0, 4096)
        : null,
      first_seen_at: entry.firstSeenAt || nowIso(),
      last_seen_at: entry.lastSeenAt || nowIso(),
    };
    insertPaperAuthor.run(row);
    writePaperAuthors(`${JSON.stringify(row)}\n`);
    return row;
  }

  function getJournalStats() {
    const dist = {};
    for (const r of journalStatsQ.all()) dist[r.query_status || 'pending'] = r.n;
    const p = paperStatsQ.get() || { total_papers: 0, in_range: 0 };
    const a = authorStatsQ.get() || { total_authors: 0, target_candidates: 0, chinese_likely: 0 };
    return {
      journal_status: dist,
      papers: p,
      authors: a,
    };
  }

  function listJournals({ statuses = null, system = null } = {}) {
    let where = '1=1';
    const params = [];
    if (statuses && statuses.length) {
      where += ` AND query_status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
    if (system) {
      where += ' AND journal_system = ?';
      params.push(system);
    }
    return db.prepare(`SELECT * FROM journals WHERE ${where} ORDER BY id ASC`).all(...params);
  }

  function getJournal(id) {
    return db.prepare('SELECT * FROM journals WHERE id = ?').get(id) || null;
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
    recordJournal,
    recordPaper,
    recordPaperAuthor,
    selectPhotoCandidates,
    getHeadshotStats,
    getJournalStats,
    listJournals,
    getJournal,
    getDeptCounts,
    setMeta: setMetaPair,
    getMeta: getMetaPair,
    close,
  };
}

module.exports = { createStore, SCHEMA_SQL };
