# Faculty Crawler Schema (v1.4)

> 维护方：后端开发工程师 (multica-agent: `a96a336b`)
> 适用任务：BRA-7 学校官网教师页入口发现与本地归档爬虫 / BRA-8 教师照片下载与抓取状态日志 / BRA-9 期刊论文 API 查询与华人姓名高召回初筛 / BRA-9.1 作者邮箱 enrich / BRA-9.2 ORCID 公共 API 反向查询 enrich
> 数据版本：v1.4
> 关联输入：`qs50/data/qs50_schools.json` (v1.0) + `qs50/data/qs50_departments.json` (v2.1) + `faculty/data/journals.csv`（BRA-9 附件）
> 关联下游：BRA-10（人工审核查看器）

本目录是 `BRA-7` 任务的交付物。爬虫以 `qs50/data` 为入口库，发现并归档 QS50
相关院系的教师列表页与个人主页 HTML，并对候选教师姓名执行高召回疑似华人初筛。

## 目录结构

```
faculty/
├── README.md                    # 模块说明与使用方法
├── schema/
│   └── faculty_schema.md        # 本文件
├── scripts/
│   ├── discover.js              # 主入口：从 QS50 入口库抓取教师页
│   ├── validate.js              # 校验生成的数据库/JSONL 记录
│   ├── lib/
│   │   ├── loader.js            # 加载 QS50 schools / departments JSON
│   │   ├── fetch.js             # HTTP 抓取（带重试、限速、UA、gzip）
│   │   ├── files.js             # 本地文件路径与归档
│   │   ├── classify.js          # 识别教师列表页（基于 URL 与 HTML 特征）
│   │   ├── extract.js           # 从列表页抽取个人主页链接与字段
│   │   ├── chinese.js           # 疑似华人姓名初筛（高召回）
│   │   └── storage.js           # SQLite (node:sqlite) + JSONL 写入
│   └── tests/
│       ├── run.js               # 单元测试入口
│       ├── chinese.test.js
│       ├── classify.test.js
│       ├── extract.test.js
│       ├── files.test.js
│       ├── loader.test.js
│       ├── storage.test.js
│       └── discover-flow.test.js
├── data/                        # 运行产物（默认 .gitignore）
│   ├── faculty.db               # SQLite 候选人/抓取日志数据库
│   ├── crawl_log.jsonl          # 抓取状态明细（追加写）
│   ├── candidates.jsonl         # 候选人记录（追加写）
│   └── html/                    # 归档的 HTML 文件
│       └── <school-slug>/<dept-id>/list/<idx>.html
│       └── <school-slug>/<dept-id>/people/<slug>/index.html
│       └── <school-slug>/<dept-id>/people/<slug>/photo/<hash>.<ext>  # BRA-8 照片
└── .gitignore
```

## 数据模型

爬虫产出的核心数据存在两个地方：

1. SQLite `faculty/data/faculty.db`（结构化、可查询）
2. JSONL 日志（`crawl_log.jsonl`、`candidates.jsonl`）便于人工审阅与回放

### SQLite schema

```sql
-- 候选人表：每位被发现的潜在教师/研究人员
CREATE TABLE IF NOT EXISTS candidates (
  id                          TEXT PRIMARY KEY,          -- sha1(school_rank|dept_id|source_url)
  school_rank                 INTEGER NOT NULL,
  school_name_en              TEXT    NOT NULL,
  department_id               TEXT    NOT NULL,
  department_name_en          TEXT    NOT NULL,
  category                    TEXT    NOT NULL,          -- 与 qs50_departments.json 对齐
  source_kind                 TEXT    NOT NULL,          -- 'list_page' | 'personal_page'
  source_url                  TEXT    NOT NULL,          -- 原始 URL
  source_list_url             TEXT,                      -- 该候选来自哪个列表页（个人页才有）
  local_path                  TEXT,                      -- 归档的本地 HTML 路径（相对 faculty/data/）
  name_raw                    TEXT,                      -- 原始姓名（来自 HTML，未规范化）
  title_raw                   TEXT,                      -- 原文职位
  email_raw                   TEXT,
  chinese_name_probability    REAL    DEFAULT 0,         -- 0..1，疑似华人置信度
  chinese_name_reasons        TEXT,                      -- JSON array，规则命中原因
  review_status               TEXT    NOT NULL DEFAULT 'pending',  -- pending|confirmed|excluded|focus
  review_notes                TEXT,
  first_seen_at               TEXT    NOT NULL,          -- ISO8601 UTC
  last_seen_at                TEXT    NOT NULL,
  crawl_status                TEXT    NOT NULL,          -- 参见抓取状态枚举

  -- BRA-8 照片下载（迁移添加，nullable）
  headshot_url                TEXT,                       -- 抽到的图片 URL
  headshot_local_path         TEXT,                       -- 归档的本地图片路径（相对 faculty/data/）
  headshot_content_type       TEXT,                       -- 实际响应的 MIME
  headshot_bytes              INTEGER,                    -- 图片字节数
  headshot_crawl_status       TEXT,                       -- 照片抓取状态枚举
  headshot_fetched_at         TEXT,                       -- ISO8601 UTC
  headshot_error_detail       TEXT,                       -- 失败原因
  headshot_source_url         TEXT                        -- 来自哪个 personal page（冗余便于追溯）
);

CREATE INDEX IF NOT EXISTS idx_candidates_school ON candidates(school_rank);
CREATE INDEX IF NOT EXISTS idx_candidates_dept   ON candidates(department_id);
CREATE INDEX IF NOT EXISTS idx_candidates_chs    ON candidates(chinese_name_probability);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_source ON candidates(source_kind, source_url);

-- 抓取日志：每次 HTTP/HTML 处理一条，便于回放与失败诊断
CREATE TABLE IF NOT EXISTS crawl_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,                      -- ISO8601 UTC
  target_kind     TEXT    NOT NULL,                      -- 'list_page' | 'personal_page'
  target_url      TEXT    NOT NULL,
  school_rank     INTEGER,
  department_id   TEXT,
  http_status     INTEGER,
  bytes           INTEGER,
  duration_ms     INTEGER,
  status          TEXT    NOT NULL,                      -- 抓取状态枚举
  error_detail    TEXT,                                  -- 失败原因（截断到 4KB）
  redirected_to   TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_log(status);
CREATE INDEX IF NOT EXISTS idx_crawl_dept    ON crawl_log(department_id);

-- 部门抓取汇总：每个 (school_rank, department_id) 一行
CREATE TABLE IF NOT EXISTS department_summary (
  school_rank          INTEGER NOT NULL,
  department_id        TEXT    NOT NULL,
  department_name_en   TEXT    NOT NULL,
  entry_url            TEXT    NOT NULL,                 -- qs50_departments.json 中的 url
  category             TEXT    NOT NULL,
  needs_js_hint        INTEGER NOT NULL,                 -- 0/1
  status               TEXT    NOT NULL,                 -- qs50 原 status
  discovered_list_url  TEXT,                             -- 命中的教师列表页 URL（若有）
  list_pages_count     INTEGER NOT NULL DEFAULT 0,        -- 已成功下载的列表页数
  candidates_count     INTEGER NOT NULL DEFAULT 0,        -- 已入候选人表的数量（含去重）
  candidates_chs_count INTEGER NOT NULL DEFAULT 0,        -- 疑似华人候选数
  last_run_at          TEXT,                             -- ISO8601 UTC
  last_run_status      TEXT,                             -- ok|no_list_page|requires_js|access_failed|partial|error
  PRIMARY KEY (school_rank, department_id)
);
```

### 抓取状态枚举 (`crawl_log.status` / `department_summary.last_run_status`)

| 值 | 含义 |
| --- | --- |
| `success` | HTTP 2xx/3xx 且 HTML 已写入本地 |
| `http_error` | HTTP 4xx/5xx，详见 `http_status` 字段 |
| `timeout` | 连接或读取超时 |
| `dns_error` | DNS 解析失败 |
| `connection_refused` | TCP 连接被拒 |
| `robots_disallowed` | robots.txt 拒绝（默认值允许） |
| `requires_js` | 入口标记 `needs_js_hint=true`，本次为 SSR 抓取，跳过 |
| `no_faculty_page` | 未在入口下发现教师列表页（白名单候选 URL 全部失败） |
| `parse_error` | HTML 解析失败 / 字符编码异常 |
| `too_large` | 响应超过 8 MiB 限制，主动放弃 |
| `skipped` | 主动跳过（dry-run、人工黑名单等） |
| `error` | 其他未分类错误 |

### 照片抓取状态枚举（`candidates.headshot_crawl_status`，BRA-8 引入）

| 值 | 含义 |
| --- | --- |
| `success` | 图片下载并落盘，content-type 为 image/*，字节数 > 100 |
| `no_photo` | HTML 中无可抽取的照片 URL（无 og:image/twitter:image/<img>） |
| `http_error` | HTTP 4xx/5xx（不含 401/403/451） |
| `timeout` | 下载超时 |
| `dns_error` | DNS 解析失败 |
| `connection_refused` | TCP 连接被拒 |
| `too_large` | 响应 > 8 MiB 限制 |
| `format_unsupported` | content-type 非 image/*（如 text/html 重定向/错误页） |
| `anti_leech_suspected` | 401/403/451 或空 body / < 100 字节（疑似防盗链/校验页） |
| `manual_required` | 跨 host 重定向等需要人工处理 |
| `skipped` | 本地 HTML 缺失，无法判断（仅在非 dry-run 模式下使用） |
| `error` | 其他未分类错误 |

> 备注：照片 `skipped` 不计入候选人是否入库；任何 `headshot_crawl_status` 都只写到候选人行，不影响 `candidates.crawl_status`。

### 候选人 `review_status` 枚举

`pending` (默认) / `confirmed` / `excluded` / `focus`，由人工/上游系统后续回写（详见 BRA-10）。

### `candidates.chinese_name_reasons` JSON 结构

```json
{
  "score": 0.78,
  "matches": [
    {"rule": "surname_known", "detail": "Wang"},
    {"rule": "given_name_shape", "detail": "2-syllable pinyin (xiao-ming)"},
    {"rule": "cjk_chars_present", "detail": "王小明"}
  ],
  "negatives": [
    {"rule": "western_given_name", "detail": "John"}
  ]
}
```

`chinese_name_probability` = `score`，范围 0..1，越高越像中文姓名；MVP 仅作高召回初筛。

## 候选人 `source_kind` 枚举

| 值 | 含义 |
| --- | --- |
| `list_page` | 列表页本身作为一条记录（URL 即列表页），便于复算 |
| `personal_page` | 候选人个人主页 |

## 验收对照

| 验收标准 | 落地位置 |
| --- | --- |
| 每所 QS50 学校都有官网教师页处理记录 | `department_summary` 50/50 行 + `crawl_log` 中目标为 `entry_url` 的记录 |
| 找到的列表页和个人主页 HTML 已保存到本地 | `faculty/data/html/<school>/<dept>/{list,people}/` |
| 候选人记录能追溯到原始 URL 和本地 HTML 文件 | `candidates.source_url` + `candidates.local_path` |
| 教师侧疑似华人初筛字段已输出 | `candidates.chinese_name_probability` + `chinese_name_reasons` |
| 失败和待人工确认情况有明确日志 | `crawl_log.status` 中 `http_error / timeout / requires_js / no_faculty_page / ...` |

## 一致性约束

1. `candidates.source_url` + `source_kind` 唯一（DB 唯一索引保证）。
2. `candidates.school_rank` 必须 ∈ {1..50}；`department_id` 必须存在于 `qs50_departments.json`。
3. 本地 HTML 路径形如 `html/<school-slug>/<dept-id>/{list/people/<slug>}/<file>.html`，相对 `faculty/data/`。
4. 任何对 QS50 输入的写回只发生在原数据文件的 `last_validated_at` / `http_status` 字段；本模块不修改 `qs50/data/*.json`。
5. `--dry-run` 不发请求，但仍然写入 SQLite / JSONL（用 `dryRunListSample` / `dryRunPersonalSample` 注入固定 HTML），便于 CI 验收。

## 退出码语义（`discover.js` 主入口）

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部 `processed` 完成；无真 failure（`skipped` 预期跳过不计入） |
| `1` | 参数错误或 `loadQs50` 失败 |
| `2` | 至少一个 active 入口出现真 failure（`no_list_page` / 抛错等）；输出 JSON 中 `failures > 0` |
| `3` | `--schools` / `--limit` 过滤后没有任何 entry 被选中 |

`skipped`（excluded 入口审计行 + `requires_js` 跳过）属于预期路径，不计入 `failures`、不影响退出码，输出 JSON 中单独以 `skipped` 字段暴露，便于 CI 区分。

## 后续可扩展字段（不在 v1.1 范围）

- `candidates.evidence_papers` — 论文证据，由 BRA-9 写入
- `candidates.relatedness_score` — 人工标注的相关性分数

新增字段必须先更新本 `faculty_schema.md` 的版本号再写入。

## v1.1 变更（BRA-8）

- `candidates` 表新增 8 个 nullable 列：`headshot_url` / `headshot_local_path` / `headshot_content_type` / `headshot_bytes` / `headshot_crawl_status` / `headshot_fetched_at` / `headshot_error_detail` / `headshot_source_url`
- 新增 photo 状态枚举（见上）
- 新增脚本 `faculty/scripts/photos.js` 与模块 `faculty/scripts/lib/photos.js`
- 新增测试 `photos.test.js` / `photos-flow.test.js`（+50 个测试用例）
- `crawl_log` 表的 `target_kind` 现支持 `headshot`（沿用同一表，区分 photo 事件）
- 抓取日志可区分页面失败和图片失败（同一行 `status` 字段携带不同 `target_kind`）

## v1.2 变更（BRA-9）

- 新增 3 张表：`journals` / `papers` / `paper_authors`
  - `journals` 字段：附件 CSV 8 列原文 + 解析后的 `issn_print` / `issn_electronic` / `issn_l` / `cn_code` + OpenAlex 源 ID + 5 个查询状态统计列
  - `papers` 字段：DOI、OpenAlex Work ID、标题、journal_id、出版年/月/日、卷期页、引用数、数据源、源 URL
  - `paper_authors` 字段：作者名、position、3 个布尔位（first/last/corresponding）、机构名/ID、ORCID、3 个华人初筛字段、`is_target_candidate` 标志
- `papers.id` 唯一键：DOI 存在时 = `doi:<lowercased>`；否则 = `sha1:` + sha1(source|normalized_title|year|journal_id) 前 32 hex
- `paper_authors.id` 唯一键：sha1(paper_id|author_position|normalized_name) — 同位置同人重抓幂等
- 新增脚本 `faculty/scripts/papers.js` 与模块 `faculty/scripts/lib/{papers_csv,openalex,crossref,paper_extract}.js`
- 新增测试 `papers_csv.test.js` / `paper_extract.test.js` / `papers_flow.test.js`（+40 个测试用例）
- 新增 3 个 JSONL：`journals.jsonl` / `papers.jsonl` / `paper_authors.jsonl`
- `crawl_log` 表的 `target_kind` 现支持 `journal`（沿用同一表）

### `journals` 表（BRA-9 引入）

每行一个 CSV 期刊条目 + 解析后的源 ID + 查询结果统计。id = sha1(source_file|journal_name|issn_canonical|cn_canonical)。

```sql
CREATE TABLE IF NOT EXISTS journals (
  id                    TEXT PRIMARY KEY,
  source_file           TEXT    NOT NULL,         -- CSV 的 "来源文件" 字段
  journal_system        TEXT,                     -- 中文期刊 / 英文期刊
  discipline            TEXT,                     -- 学科/方向
  journal_name_raw      TEXT    NOT NULL,         -- 期刊名称原文（CSV）
  journal_name_en       TEXT,                     -- 规范化后的英文名（OpenAlex 解析后回填）
  issn_raw              TEXT,                     -- CSV 的 "ISSN/CN" 字段原文
  issn_print            TEXT,                     -- 解析后的 print-ISSN（去横线）
  issn_electronic       TEXT,                     -- 解析后的 electronic-ISSN
  issn_l                TEXT,                     -- OpenAlex/Crossref 解析后的 linking-ISSN
  cn_code               TEXT,                     -- 中文期刊的 CN 号（11-1235/F 等）
  school_level          TEXT,                     -- A+/A/A1/A2
  usage                 TEXT,                     -- 人才库用途
  notes                 TEXT,                     -- 备注
  openalex_source_id    TEXT,                     -- OpenAlex source ID (S...)
  crossref_issn         TEXT,                     -- Crossref 用的 ISSN
  query_status          TEXT,                     -- 'success' | 'no_results' | 'api_unsupported' | 'manual_required' | 'failed'
  papers_found          INTEGER NOT NULL DEFAULT 0,
  papers_kept           INTEGER NOT NULL DEFAULT 0,
  authors_found         INTEGER NOT NULL DEFAULT 0,
  authors_chs           INTEGER NOT NULL DEFAULT 0,
  authors_target        INTEGER NOT NULL DEFAULT 0,  -- 一作/通讯作者 + 疑似华人
  last_query_at         TEXT,
  error_detail          TEXT,
  first_seen_at         TEXT    NOT NULL,
  last_seen_at          TEXT    NOT NULL
);
```

### `papers` 表（BRA-9 引入）

每行一个 paper，按 DOI 唯一（缺失时退化到 sha1）。journal_id 关联 journals.id。

```sql
CREATE TABLE IF NOT EXISTS papers (
  id                TEXT PRIMARY KEY,            -- doi 不为空时 = 'doi:'+lowercase_doi；否则 sha1(source|normalized_title|year|journal_id).slice(0,32)
  doi               TEXT,
  openalex_id       TEXT,                        -- OpenAlex Work ID (W...)
  title             TEXT    NOT NULL,
  journal_id        TEXT    NOT NULL,
  journal_name      TEXT    NOT NULL,            -- 冗余方便 join-less 查询
  issn              TEXT,
  publish_year      INTEGER,
  publish_date      TEXT,                        -- ISO8601 'YYYY-MM-DD'
  volume            TEXT,
  issue             TEXT,
  page              TEXT,                        -- 形如 "100-120"
  paper_type        TEXT,                        -- 'article' | 'review' | 'letter' | ...
  cited_by_count    INTEGER,
  language          TEXT,                        -- 'en' | 'zh' | ...
  source            TEXT    NOT NULL,            -- 'openalex' | 'crossref'
  source_url        TEXT,
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL
);
```

### `paper_authors` 表（BRA-9 引入）

每个 authorships 一行。`is_target_candidate = (is_first_author OR is_last_author OR is_corresponding) AND chinese_name_probability >= chinese_threshold`（默认 0.4）。

```sql
CREATE TABLE IF NOT EXISTS paper_authors (
  id                        TEXT PRIMARY KEY,
  paper_id                  TEXT    NOT NULL,
  author_name               TEXT    NOT NULL,
  author_position           INTEGER NOT NULL,
  is_first_author           INTEGER NOT NULL DEFAULT 0,
  is_last_author            INTEGER NOT NULL DEFAULT 0,
  is_corresponding          INTEGER NOT NULL DEFAULT 0,
  affiliation_raw           TEXT,
  affiliation_id            TEXT,
  affiliation_name          TEXT,
  orcid                     TEXT,
  chinese_name_probability  REAL    DEFAULT 0,
  chinese_name_reasons      TEXT,                -- JSON array
  chinese_name_negatives    TEXT,                -- JSON array
  is_target_candidate       INTEGER NOT NULL DEFAULT 0,
  -- BRA-9.1 邮箱 enrich 字段
  email_raw                 TEXT,                -- 抽到的邮箱原文
  email_source              TEXT,                -- 'openalex_regex' | 'publisher_wiley' | 'publisher_elsevier' | 'manual'
  email_match_context       TEXT,                -- 命中哪条 affiliation 字符串（截断 500 字符）
  first_seen_at             TEXT    NOT NULL,
  last_seen_at              TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_email_source ON paper_authors(email_source);
```

### `journals.query_status` 枚举（BRA-9 引入）

| 值 | 含义 |
| --- | --- |
| `success` | 至少 1 篇 paper 落库（含 in_range 过滤后） |
| `no_results` | API 调用成功但 0 结果（期刊 ID 找不到 / 5 年范围无 paper） |
| `api_unsupported` | 期刊无 print-ISSN（中文期刊 CN-only），OpenAlex/Crossref 均不支持按 CN 解析 |
| `manual_required` | 预留：人工通过其他渠道补充 |
| `failed` | API 调用真 failure（http_error / timeout / parse_error / unexpected） |

## 一致性约束（v1.2 增量）

1. `journals.source_file` 必须非空（CSV 原文的"来源文件"字段）
2. `papers.journal_id` 必须存在于 `journals.id`（FK）
3. `paper_authors.paper_id` 必须存在于 `papers.id`（FK + ON DELETE CASCADE）
4. `papers.doi` 唯一（如有）；缺失时由 sha1 兜底
5. 同一 paper 的同一 position + 同一姓名只入一行（`paper_authors.id` 唯一）

## 退出码语义（`papers.js` 主入口）

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部期刊都跑完（含 `success` / `no_results` / `api_unsupported` 都算 ok） |
| `1` | 参数错误 / CSV 不存在 |
| `2` | 至少一本期刊 `failed`（API 真 error） |
| `3` | 过滤后没有任何期刊被选中 |

`api_unsupported` 属于预期路径（CN-only 中文期刊），不计入 failure / 不影响退出码。

### `paper_authors.email_source` 枚举（BRA-9.1 引入，BRA-9.2 扩展）

| 值 | 含义 |
| --- | --- |
| `openalex_regex` | path A 兜底：OpenAlex `raw_affiliation_string` 正则命中 |
| `publisher_wiley` | path B（预留，后续 spike）：Wiley 论文详情页抽取 |
| `publisher_elsevier` | path B（预留，后续 spike）：Elsevier 论文详情页抽取 |
| `orcid_public_api` | path C（BRA-9.2）：ORCID 公共 API `/person` 端点命中用户主动公开的 email |
| `manual` | 人工录入 |

### 邮箱覆盖率目标（BRA-9.1 验收标准）

路径 A 经验覆盖率 < 5%（多数论文在 OpenAlex 入索引时 affiliations 已被截短）；
`validate.js` 校验门槛：`count(email_raw != null) / count(*) >= 1%`。
覆盖率不达 1% 视为 path A 失败（与 BRA-9.1 issue 验收标准对齐）。

## v1.3 变更（BRA-9.1）

- `paper_authors` 表新增 3 个 nullable 列：`email_raw` / `email_source` / `email_match_context`
- 新增索引 `idx_pa_email_source ON paper_authors(email_source)`，便于按来源筛选
- 新增模块 `faculty/scripts/lib/email_extract.js`：RFC5322 简化正则 + 黑名单域 + 长度上限 + Corresponding author 标记优先
- `paper_extract.js` 的 `extractAuthorships()` 调用 `extractEmailForAuthor()`，把命中邮箱写入 `emailRaw/emailSource/emailMatchContext`
- `storage.js` 的 `createStore()` 用 `ensureColumn()` 幂等迁移；新跑 + 老 DB 共存
- 新增测试 `email_extract.test.js`（15 个测试用例）
- `validate.js` 新增 4 段校验：覆盖率（>= 1%）、邮箱格式（GLOB + 正则）、长度上限（<= 254）、黑名单域、`email_source` 枚举
- `paper_authors.jsonl` 流水增加 `email_raw` / `email_source` / `email_match_context` 三个字段（向后兼容：未命中作者三件套都是 null）

## v1.4 变更（BRA-9.2）

- `paper_authors` 表新增 7 个 nullable 列（`orcid` 字段本身已存在）：
  - `email_orcid_id TEXT` — 命中邮箱的 ORCID iD（形如 `0000-0000-0000-0000` 或末位 `X`）
  - `orcid_credit_name TEXT` — ORCID profile 上的 display name
  - `orcid_external_ids_json TEXT` — Scopus / ResearcherID / ISNI 等 external IDs（JSON array）
  - `orcid_affiliations_json TEXT` — employment + education history（JSON array — killer feature，识别跳槽）
  - `orcid_last_modified TEXT` — ORCID profile last-modified 时间（HTTP `Last-Modified` 头）
  - `orcid_last_fetched TEXT` — 我们打 ORCID API 的时间（audit / 30 天增量窗口）
  - `orcid_profile_json TEXT` — 完整 `/person` 响应（冷字段兜底；平均 ~1 KB/作者）
- 新增索引 `idx_pa_orcid_fetched ON paper_authors(orcid, orcid_last_fetched)` — 增量重跑友好
- `email_source` 枚举增加 `'orcid_public_api'`，合法值集合 4 → 5
- 新增模块 `faculty/scripts/lib/orcid_enrich.js`：
  - `normalizeOrcidId()` — 兼容 19 位短横线 / URL 前缀 / 16 位裸数字
  - `extractEmailsFromPerson()` / `extractExternalIds()` / `extractAffiliationsFromPerson()` / `extractCreditName()`
  - `fetchPerson()` — 5 req/sec 限速 + 4xx/5xx/429 退避策略（4xx 不重试；429/5xx 指数退避 1s/2s/4s 最多 3 次）
  - `processAuthor()` — 把 fetchPerson 结果整理成 `store.recordOrcidProfile` 期望的入参
- 新增脚本 `faculty/scripts/orcid_enrich.js`（CLI 入口）：
  - `--all` / `--orcid XXXX-XXXX-XXXX-XXXX` / `--max-queries N` / `--force` / `--dry-run` / `--out DIR`
  - 输入过滤：`chinese_name_probability >= 0.4 AND (is_first_author=1 OR is_corresponding=1) AND email_raw IS NULL AND orcid 非空`
  - 30 天增量窗口（`--force` 跳过）
  - 写 `faculty/data/real-<DATE>/orcid_query_log.jsonl` 审计行（HTTP status / latency / response hash）
- `storage.js` 新增 `recordOrcidProfile()` / `selectOrcidLookupRows()` / `getOrcidLookupStats()` 三个 helper
- `validate.js` 新增 ORCID 段校验：
  - `email_orcid_id` 格式（`0000-0000-0000-0000` 或末位 `X`）
  - `email_source='orcid_public_api'` 与 `email_orcid_id` 一致性
  - 3 个 JSON 列（`orcid_external_ids_json` / `orcid_affiliations_json` / `orcid_profile_json`）`json_valid()` 合法率
  - `orcid_last_fetched` 非空的行 companion 字段（`email_orcid_id` / `orcid_last_modified` / `orcid_profile_json`）都必须非空
  - `orcid_query_log.jsonl` JSONL 合法率
- 新增测试 `orcid_enrich.test.js`（~24 个测试用例）：
  - `normalizeOrcidId` 各种输入形式
  - `extractEmailsFromPerson` / `extractExternalIds` / `extractAffiliationsFromPerson` / `extractCreditName` 各种边界
  - `isValidEmailFormat` 边界（黑名单 / ISSN-like / IP / 长度）
  - `processAuthor` 用 mock fetch 测 200+email / 200 空 email / 404 / 403（不重试） / 429 退避 / 5xx 退避 / invalid orcid
  - `store.recordOrcidProfile` 集成测试（含 `COALESCE` 保护）
  - `store.selectOrcidLookupRows` filter / 30 天窗口 / `--force` 重跑
- `email_extract.test.js` enum 校验更新（4 → 5）
- `paper_authors.jsonl` 流水增加 7 个 ORCID 字段（向后兼容：未跑 spike 的作者都是 null）
- `storage.js` 的 `createStore()` 用 `ensureColumn()` 幂等迁移；新跑 + 老 DB 共存
