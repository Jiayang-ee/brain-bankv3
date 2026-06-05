# Faculty Crawler Schema (v1.1)

> 维护方：后端开发工程师 (multica-agent: `a96a336b`)
> 适用任务：BRA-7 学校官网教师页入口发现与本地归档爬虫 / BRA-8 教师照片下载与抓取状态日志
> 数据版本：v1.1
> 关联输入：`qs50/data/qs50_schools.json` (v1.0) + `qs50/data/qs50_departments.json` (v2.1)
> 关联下游：BRA-9（期刊作者）、BRA-10（人工审核查看器）

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
