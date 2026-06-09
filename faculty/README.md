# Faculty Crawler (`faculty/`)

> 维护方：后端开发工程师 (multica-agent: `a96a336b`)，前端查看器 (BRA-10) 由前端开发工程师 (multica-agent: `63cd7915`) 维护
> 适用任务：BRA-7 学校官网教师页入口发现与本地归档爬虫 / BRA-8 教师照片下载与抓取状态日志 / BRA-9 期刊论文 API 查询 / BRA-10 本地网页查看器与人工审核
> 关联输入：`qs50/data/qs50_schools.json` (v1.0) + `qs50/data/qs50_departments.json` (v2.1)
> 关联下游：BRA-10（人工审核查看器）

基于 `qs50/data` 院系入口库，发现并归档 QS50 相关院系的教师列表页与个人主页 HTML，
对候选教师姓名执行高召回疑似华人初筛，并把结构化结果落到 SQLite + JSONL 便于 BRA-9/10 复用；
进一步从个人主页抽取头像 URL、下载本地、保存为人工复核证据（不参与华人身份判断）。

零第三方依赖（仅 Node.js ≥ 22.5 内置模块：`node:sqlite` / `node:https` / `node:fs` / `node:path` / `node:crypto` / `node:zlib` / `node:assert`）。

## 使用

```bash
# 离线 dry-run：注入样例 HTML（不发网络请求），用于验收与冒烟
node faculty/scripts/discover.js --all --dry-run

# 默认：3 个部门 / 学校，先跑一遍
node faculty/scripts/discover.js --all

# 指定学校（rank）
node faculty/scripts/discover.js --schools 1,2,20

# 每校最多 N 个部门
node faculty/scripts/discover.js --all --limit 5

# 每个部门最多抓 N 条个人主页（默认 200，dry-run 5）
node faculty/scripts/discover.js --all --max-profiles 50

# 自定义输出目录
node faculty/scripts/discover.js --all --out /tmp/faculty-out

# 详细日志
node faculty/scripts/discover.js --all --dry-run --verbose
```

跑完会在 `faculty/data/`（或 `--out` 指定目录）生成：
- `faculty.db` — SQLite（candidates / crawl_log / department_summary / meta）
- `candidates.jsonl` — 候选人追加日志（一行一条，可 `tail -f` 监控）
- `crawl_log.jsonl` — 抓取明细（成功 / 失败 / 状态码 / 耗时 / 错误）
- `html/<school>/<dept>/{list,people/<sha>}/...` — 归档的 HTML

## 教师照片下载（BRA-8）

依赖 BRA-7 已落地的 `faculty.db` 与本地 HTML。读取 `candidates` 表中
`source_kind='personal_page' AND crawl_status='success'` 的候选人，
从对应 HTML 抽取照片 URL、下载到本地、记录抓取状态。

```bash
# 离线 dry-run：用 fake fetch + 1x1 PNG，验证抽取/落盘/状态写入链路
node faculty/scripts/photos.js --all --dry-run

# 默认行为：跳过已 success 的，仅处理 pending / failed
node faculty/scripts/photos.js --all

# --force 重新处理已 success 的（用于更新原图）
node faculty/scripts/photos.js --all --force

# 只处理指定学校
node faculty/scripts/photos.js --schools 1,2,20

# 上限 + 自定义输出
node faculty/scripts/photos.js --all --max-profiles 100 --out /tmp/fo
```

跑完会在 `faculty/data/`（或 `--out` 指定目录）追加/更新：
- `candidates.headshot_*` — 8 个新列（见 schema v1.1）
- `html/<school>/<dept>/people/<sha>/photo/<hash>.<ext>` — 归档的照片
- `crawl_log` 追加 `target_kind='headshot'` 行（沿用同表，用 `target_kind` 区分页面/图片事件）

### 照片状态枚举

详见 `schema/faculty_schema.md` v1.1 节。简表：

| 状态 | 含义 |
| --- | --- |
| `success` | 200 + image/* + bytes > 100，已落盘 |
| `no_photo` | HTML 中无可抽取照片 URL |
| `http_error` | 4xx/5xx（不含 401/403/451） |
| `anti_leech_suspected` | 401/403/451 / 空 body / < 100B（疑似防盗链/校验页） |
| `format_unsupported` | content-type 非 image/* |
| `timeout` / `dns_error` / `connection_refused` / `too_large` | 网络层错误 |
| `manual_required` | 跨 host 重定向等需人工处理 |
| `skipped` | 本地 HTML 缺失（仅非 dry-run 模式） |
| `error` | 其他 |

> 备注：照片 `skipped` / `failed` / `no_photo` 不阻断候选人入库。`headshot_crawl_status` 是独立维度，不影响 `candidates.crawl_status`。
> 照片只作为人工复核证据，**不**用于自动判断华人身份。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部 `processed` 完成；无真 failure（含 `no_photo` / `skipped`） |
| `1` | 参数错误 / `faculty.db` 不存在 |
| `2` | 至少一个 headshot 出现真 failure（`http_error` / `format_unsupported` / `anti_leech` / `timeout` / ...） |
| `3` | 没有匹配到任何 personal_page 候选人 |

## 校验

```bash
node faculty/scripts/tests/run.js   # 136 个单元测试
node faculty/scripts/validate.js     # 校验跑批产出的数据
```

期望输出末尾：
- `136 tests, 0 failed`
- `VALIDATION OK`
- `school coverage: 50/50 (OK)`
- `headshot status distribution: {"success":...,"no_photo":...,...}`

## CLI 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| `--all` | 处理全部 50 校（隐式 `--limit 0`） | off |
| `--schools <ranks>` | 逗号分隔的 rank 列表，如 `1,2,20` | — |
| `--limit <N>` | 每所学校的 *active* 部门上限；`0` 不限 | 3 |
| `--max-profiles <N>` | 每个部门最多抓取的个人主页数 | 200 |
| `--dry-run` | 不发请求，注入样例 HTML | off |
| `--out <dir>` | 自定义输出目录 | `faculty/data` |
| `--verbose` / `-v` | 详细 stderr 日志 | off |
| `--help` / `-h` | 打印本 README 头部 | — |

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部 `processed` 完成；无真 failure（`skipped` 不计入） |
| `1` | 参数错误或 `loadQs50` 失败 |
| `2` | 至少一个 active 入口出现真 failure（`no_list_page` / 抛错等），输出 JSON 中 `failures > 0` |
| `3` | `--schools` / `--limit` 过滤后没有任何 entry 被选中 |

`skipped`（excluded 入口审计行 + `requires_js` 跳过）属于预期路径，不计入 `failures`、不影响退出码，输出 JSON 中单独以 `skipped` 字段暴露，便于 CI 区分。

## 关键设计

### 1. 列表页识别（无定制 selector）

`scripts/lib/classify.js` 走两层启发式：
- **URL 启发式**：入口 URL 本身 + 拼到末尾的常见列表后缀（`/people`、`/faculty`、`/staff`、`/directory`、`/team` 等）。
- **HTML 启发式**：title / h1 含 `faculty|people|staff|directory|researchers|...`；`<a href>` 含 `/people/*` 的内部链接数；网格 / 列表布局 class。

命中阈值 0.65 后停止，避免对单部门做 30+ 次请求。

### 2. 个人主页抽取（无定制 selector）

`scripts/lib/extract.js`：
- 读 `<title>` / `<meta name="author|description">` / `<meta property="og:*">` / `<h1>`。
- 邮箱用 `findEmails` 正则抓全部并去重。
- 职位关键词集合：Assistant / Associate / Full Professor、Tenure-Track、Lecturer、Research Scientist、Postdoctoral、PhD Student、Chair Professor、Dean、Director 等。
- CJK 片段提取：对每个连续 CJK run 切 2-4 字窗口，便于中文姓名识别。

### 3. 华人姓名初筛（高召回）

`scripts/lib/chinese.js`：输出 `score ∈ [0,1]` + `reasons[]` + `negatives[]`。

权重：
| 信号 | 权重 |
| --- | --- |
| CJK 字符直接出现 | +0.6 |
| 华人常见姓氏（100+） | +0.35 |
| given name 1-3 个音节，且全是短拼音 | +0.15 |
| 驼峰名（`XiaoMing Wang`） | +0.1 |
| 连字符名（`Wei-Li Wang`） | +0.1 |
| 同字姓名（`Han Han`） | 隐式 given_name_shape 仍可触发 |
| 西方 given name 在首位 + 姓氏不在华人集中 | -0.2 |
| 明显非华人前缀（`van` / `von` / `de la` / `bin` / ...） | -0.3 |
| 拉丁 / 罗曼 / 俄语后缀（`ov` / `ova` / `ski` / `opoulos`） | -0.3 |

默认阈值 `>= 0.4` 视为疑似华人，由人工/下游 BRA-10 决定最终确认。

### 4. 存储

`scripts/lib/storage.js`：
- **SQLite** (`node:sqlite`)：`candidates` / `crawl_log` / `department_summary` / `meta` 四表。
  - `(source_kind, source_url)` 唯一索引 → 自动 upsert。
  - 学校/部门/华人概率均有索引，便于 BRA-10 快速筛选。
- **JSONL**：每条记录追加写一行，文件可 `cat` / `grep` / `tail -f` 实时监控。
- 两者写入用同一事务边界（同函数体内 `insertXxx` + `appendFileSync`），无中间状态。

### 5. 网络礼貌

`scripts/lib/fetch.js`：
- 自定义 User-Agent 标注本项目身份。
- 跟随最多 5 次同 host 重定向。
- 单次请求 12-15s 超时；2 次指数退避重试；4xx 不重试。
- 响应体 8 MiB 硬上限。
- host-level 限速器（默认 1.5s 间隔），减少对单一域名的压力。
- gzip / deflate / br 自动解压。

### 6. 本地文件组织

`scripts/lib/files.js`：
```
html/<school-slug>/<dept-id>/list/<index>.html        # 列表页
html/<school-slug>/<dept-id>/people/<sha1[0:12]>/index.html   # 个人主页
```
- `school-slug` = `qs-<rank-padded>-<slugified-name>`，跨平台、可读、不冲突。
- 个人主页子目录用 URL 的 sha1 前 12 位命名，避免不同学校/同名教师冲突。

## 数据契约

详见 `schema/faculty_schema.md`。核心要点：

- `candidates.source_url` + `source_kind` 唯一。
- `chinese_name_probability` 范围 [0, 1]；`>= 0.4` 推荐为疑似华人。
- `chinese_name_reasons` 为 JSON 数组，元素形如 `{ rule, detail }`。
- `crawl_log.status` 枚举：`success` / `http_error` / `timeout` / `dns_error` / `connection_refused` / `robots_disallowed` / `requires_js` / `no_faculty_page` / `parse_error` / `too_large` / `skipped` / `error`。
- `department_summary.last_run_status` 枚举：`ok` / `no_faculty_page` / `requires_js` / `access_failed` / `partial` / `error` / `skipped` / `no_profiles`。

## 验证清单

跑 `--all --dry-run` 后应该看到：

```text
{
  "ok": true,
  "processed": 105,
  "withList": 103,
  "profiles": 515,
  "chinese": 417,
  "skipped": 2,
  "failures": 0,
  "dataDir": ".../faculty/data"
}
```

- `processed` = 105（103 active + 2 Caltech skipped）
- `withList` = 103（active 中找到 list 页）
- `profiles` = 103 × 5 = 515（dry-run 样例 5 个）
- `chinese` ≈ 417（dry-run 样例中 4/5 是华人）
- `skipped` = 2（Caltech 两个 `suspected_irrelevant` 审计行，预期跳过、不算 failure）
- `failures` = 0，进程退出码 0

然后 `node faculty/scripts/validate.js`：

```text
- department_summary covers 50 schools
- candidates: no duplicate (source_kind, source_url)
- crawl_log status distribution: {"success":515,"skipped":2}
- totals: {"candidates":618,"chinese_likely":417,"departments":105,"schools":50,...}
- school coverage: 50/50 (OK)
VALIDATION OK
```

## 移交与后续

- **BRA-8（教师照片）**：读取 `candidates` 表的 `local_path` + 解析 `<img src>`，把头像归档到 `html/.../photos/`；写入 `candidates.headshot_url` / `headshot_local_path`（schema 已在 `faculty_schema.md` 留位）。
- **BRA-9（期刊作者）**：复用 `looksChinese()` 与 `candidates` 表 schema，把期刊作者候选并入 `source_kind='journal_author'`。
- **BRA-10（人工审核）**：✅ 本仓库已自带 `scripts/viewer.js` + `viewer/`，详见下节。

## BRA-10 本地网页查看器

> 维护方：前端开发工程师 (multica-agent: `63cd7915`)

零第三方依赖的本地网页查看器。直接读 `faculty.db`，合并展示
`candidates` (personal_page) 与 `paper_authors` (is_target_candidate=1) 两类候选人，
支持按学校/院系/类别/审核状态/华人概率/关键词筛选，编辑审核状态与备注并持久化回 SQLite。

### 启动

```bash
# 默认：读 faculty/data/faculty.db，端口 7788
node faculty/scripts/viewer.js

# 自定义 DB / 端口 / 数据目录
node faculty/scripts/viewer.js --db /path/to/faculty.db --port 8080

# 启动后自动打开浏览器
node faculty/scripts/viewer.js --open
```

启动后访问 <http://127.0.0.1:7788/>。Ctrl-C 停止。

### 功能

- **统一列表**：教师 (personal_page) + 论文作者 (target_candidate) 两个数据源，单独 tab 切换
- **筛选**：学校 / 院系 / 学科类别 / 审核状态（多选），华人概率阈值，关键词搜索（姓名 / 职位 / 邮箱 / 机构 / ORCID）
- **排序**：华人概率 ↓ / 姓名 A→Z / 最近更新 ↓
- **分页**：每页 50 条，可翻页
- **详情**：教师 → 学校 / 院系 / 职位 / 邮箱 / 原始 URL / 本地 HTML 链接 / 头像 / 华人初筛原因；
  论文 → 标题 / 期刊 / 发表年 / 作者位序（一作 / 末位 / 通讯） / 机构 / DOI
- **审核**：状态 (pending / confirmed / excluded / focus) + 备注，保存到 SQLite 并立即在列表中体现
- **本地 HTML 服务**：`/html/<local_path>` 安全映射到 `dataDir`（防目录遍历）

### CLI 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| `--port` / `-p` | 监听端口 | `7788` |
| `--host` / `-H` | 监听地址 | `127.0.0.1` |
| `--db` | SQLite 文件 | `faculty/data/faculty.db` |
| `--data-dir` | 归档 HTML 根目录 | DB 同级 |
| `--static-dir` | 前端静态文件目录 | `faculty/viewer` |
| `--open` | 启动后用默认浏览器打开 | off |
| `--verbose` / `-v` | 详细日志 | off |

### API 路由

| 路由 | 用途 |
| --- | --- |
| `GET /` | SPA 入口 |
| `GET /assets/{app.js,app.css}` | 前端静态资源 |
| `GET /api/candidates?source=faculty\|paper&…` | 候选人列表（分页 / 筛选 / 排序） |
| `GET /api/candidates/{source}:{id}?source=…` | 详情 |
| `PATCH /api/candidates/{source}:{id}` | 写回审核状态 + 备注 |
| `GET /api/facets` | 维度字典（学校 / 院系 / 类别 / 状态枚举） |
| `GET /api/stats` | 顶层计数（教师 / 论文 / 华人 / 状态分布） |
| `GET /html/<encoded-path>` | 归档的本地 HTML（防目录遍历） |
| `GET /photo/<encoded-path>` | 归档的本地图片（防目录遍历） |

### BRA-23 协作约束

`paper_authors` 表的 `review_status` / `review_notes` 字段由 [BRA-23] 后端任务添加。
在那之前，查看器对论文候选人的 `PATCH` 会返回 `persisted: false` 并附 `warning`，
UI 用橙色 toast 提示，**不会**回写。BRA-23 落地后无需改查看器代码，自动转为持久化。

### 演示数据

`scripts/seed_paper_authors.js` 会向 `faculty.db` 注入 25 篇样例 paper + 50 个 paper_author
（覆盖一作 / 末位 / 通讯三种位序），用于没有 BRA-9 真实数据时快速演示：

```bash
node faculty/scripts/seed_paper_authors.js --db <data-dir>/faculty.db --count 25
```

### 自测

```bash
node faculty/scripts/tests/run.js   # 199 tests, 0 failed
```

新增的 23 个测试在 `tests/viewer_api.test.js`，覆盖：
- faculty / paper 列表 + 详情 + 筛选 + 排序 + 分页
- 关键词搜索、状态枚举、维度统计
- 写回审核（faculty 真实落库 / paper 缺列降级）
- HTTP 路由 / 路径遍历阻断 / 非法 status 拒绝

## 已知限制

- dry-run 模式只为冒烟 / 离线验收设计，不反映真实抓取成功率。
- 真实网络跑批时，部分学校（Stanford / Princeton / 清华 等）教师页需要 JS 渲染，已标记 `requires_js`，需另起 headless（puppeteer）任务；本 MVP 走 SSR，仅记录 `requires_js` 状态。
- 华人姓名规则偏向高召回（漏杀成本 >> 误报成本），下游需人工复核或加二次过滤。
- 不下载 / 处理教师照片（属 BRA-8）。
- 不抓取论文 / 出版列表（属 BRA-9，BRA-10 复用其 `paper_authors` 落库）。
- **BRA-10**：`paper_authors.review_status` / `review_notes` 写回在 [BRA-23] 落地前为 no-op；UI 提示但不阻断操作。
- **BRA-10**：`name_raw = 'Not Found'` 的列表页条目（来自 mit-idss-cm 等 WP 模板）会原样显示，建议配合原 URL fallback 一次 `og:title`（不在 MVP 范围）。

## 联系

- 字段 / 数据 / 接口调整 → 继续 mention 后端开发工程师
- 爬虫 / 抓取 / BRA-8 照片 / BRA-9 论文 → 继续 mention 后端开发工程师
- 查看器 / 人工审核 UI / BRA-10 → 前端开发工程师（owner）
