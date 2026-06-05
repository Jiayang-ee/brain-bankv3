# Faculty Crawler (`faculty/`)

> 维护方：后端开发工程师 (multica-agent: `a96a336b`)
> 适用任务：BRA-7 学校官网教师页入口发现与本地归档爬虫
> 关联输入：`qs50/data/qs50_schools.json` (v1.0) + `qs50/data/qs50_departments.json` (v2.1)
> 关联下游：BRA-8（教师照片）、BRA-9（期刊作者）、BRA-10（人工审核查看器）

基于 `qs50/data` 院系入口库，发现并归档 QS50 相关院系的教师列表页与个人主页 HTML，
对候选教师姓名执行高召回疑似华人初筛，并把结构化结果落到 SQLite + JSONL 便于 BRA-8/9/10 复用。

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

# 断点续跑：跳过 db 中已有且上轮 success 的 personal_page URL
node faculty/scripts/discover.js --all --skip-existing

# 分批重跑（断点续跑 + 单批失败不中断后续批次）
bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5 --batch-size 5

# 详细日志
node faculty/scripts/discover.js --all --dry-run --verbose
```

跑完会在 `faculty/data/`（或 `--out` 指定目录）生成：
- `faculty.db` — SQLite（candidates / crawl_log / department_summary / meta）
- `candidates.jsonl` — 候选人追加日志（一行一条，可 `tail -f` 监控）
- `crawl_log.jsonl` — 抓取明细（成功 / 失败 / 状态码 / 耗时 / 错误）
- `html/<school>/<dept>/{list,people/<sha>}/...` — 归档的 HTML

## 校验

```bash
node faculty/scripts/tests/run.js   # 112 个单元测试（v2.3）
node faculty/scripts/validate.js     # 校验跑批产出的数据
```

期望输出末尾：
- `112 tests, 0 failed`
- `VALIDATION OK`
- `school coverage: 50/50 (OK)`

## CLI 选项

| 选项 | 含义 | 默认 |
| --- | --- | --- |
| `--all` | 处理全部 50 校（隐式 `--limit 0`） | off |
| `--schools <ranks>` | 逗号分隔的 rank 列表，如 `1,2,20` | — |
| `--limit <N>` | 每所学校的 *active* 部门上限；`0` 不限 | 3 |
| `--max-profiles <N>` | 每个部门最多抓取的个人主页数 | 200 |
| `--skip-existing` | 跳过 db 中 `candidates.(source_kind, source_url)` 已存在且 `crawl_status='success'` 的 personal_page URL | off |
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

**v2.2 起（BRA-15）显式 hint 优先**：`qs50_departments.json` 的可选字段 `list_url_hint` 会被 `listCandidatesWithHint` 放在探测队列首位（与入口同 host），再 fallback 到上面的常见后缀拼接。hint 尝试的 200/404/超时等会写入 `crawl_log`，便于人工核查"为什么命中 hint 后还能 no_list_page"。

### 2. 个人主页抽取（无定制 selector）

`scripts/lib/extract.js`：
- 读 `<title>` / `<meta name="author|description">` / `<meta property="og:*">` / `<h1>`。
- 邮箱用 `findEmails` 正则抓全部并去重。
- 职位关键词集合：Assistant / Associate / Full Professor、Tenure-Track、Lecturer、Research Scientist、Postdoctoral、PhD Student、Chair Professor、Dean、Director 等。
- CJK 片段提取：对每个连续 CJK run 切 2-4 字窗口，便于中文姓名识别。

**v2.2 起（BRA-15）姓名兜底**：`pickBestName` 按 h1 > og:title > meta author > `parseNameFromTitle(title)` > `nameFromUrlSlug(url)` 顺序选最干净的姓名。`parseNameFromTitle` 会先把 HTML 实体（`&#8211;` 等）解回字符，再去掉 `| / – / —` 之后的后缀；如果清洗结果是 `Not Found / 404 / Page Not Found` 等 WP/404 模板词，返回 `null`。最后 `nameFromUrlSlug` 在 URL 含 `/people/ /person/ /faculty/` 等 token 且末段长度 ≥ 3 时，从 slug 推出 Title-case 姓名（不会把列表页 slug 误投成人名）。

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

## Runbook（BRA-7.3 真实网络抓取操作手册）

> 维护方：后端开发工程师
> 适用版本：v2.3.1（[BRA-7.2](BRA-13) 全量 3892 row 落地后）
> 适用任务：在生产网络环境跑 `--all` 时的限速 / 超时 / UA / 反爬识别 / 重跑决策

本节是 [BRA-7.1](BRA-12) 真实网络冒烟 + [BRA-7.2](BRA-13) `--all` 全量抓取后沉淀下来的可执行手册。
所有限速 / 退避 / UA 模板都以 `scripts/lib/fetch.js` 实际代码为准；如果以后改动代码，请同步更新本节。

数据来源：[BRA-13](mention://issue/e0e1c548-ba3b-46eb-9b8e-2ebfe02ec701) PR #6 落地的 `faculty/data-snapshots/bra-7.2-2026-06-03/crawl_log.jsonl`（3892 row）+ 关联 `faculty.db` / `candidates.jsonl`（1292 row）。下一轮 `--all`（如 v2.4 / v3.0 改 host 限速后）应再跑一次，把本节分布表刷掉。

### 1. 限速档位

| 维度 | 默认值 | 调优建议 |
| --- | --- | --- |
| **host-level 间隔** | `createRateLimiter(1500)`：同一 host 至少间隔 1.5s | 命中 429 / 403 比例 > 5% 时上调到 2500-3000ms；SSR-only 阶段 1500ms 够用 |
| **全局并发** | 单进程串行：1 个 active 部门的所有请求都通过同一个 rate limiter | 不要 `&` 后台跑多个 `discover.js`，会绕过限速 |
| **dry-run** | rate limiter 间隔 = 0（不延迟） | — |

`scripts/lib/fetch.js` 的实现细节：`Map<host, lastHitMs>`，每次请求先 `await sleep(1500 - elapsed)`，对跨 host 的请求不串行（MIT 抓的同时可以抓 Stanford）。

### 2. 重试策略

`fetchWithRetry` 默认参数（在 `discover.js` 实际调用时）：

| 参数 | 调用值 | 含义 |
| --- | --- | --- |
| `retries` | **1** | 最多重试 1 次（即总尝试 2 次） |
| `baseDelayMs` | **300** | 第 1 次重试前等 300ms；指数退避 `300 * 2^attempt` |
| `timeoutMs` | **12000** | 单次请求 12s 超时（fetch.js 函数默认值是 15s；discover.js 显式传 12s） |

实际退避序列（含随机抖动 0-250ms）：
- 第 1 次失败：等 `300 + rand(0..250)` ms
- 第 2 次失败：等 `600 + rand(0..250)` ms

**不重试的状态码**：4xx（`http_error` + status ∈ [400, 500)）。理由：404 / 403 / 410 不会因重试而改变；WAF 拦截 403 重复请求只会让 WAF 更坚决。

**会重试的状态**：timeout / connection_reset / 5xx / dns_error（按"非 4xx 即网络问题"处理）。如果某 host DNS 持续失败，靠重试最多 2 次通常不够，应该去 `crawl_log.jsonl` 看 `error_detail` 决定是否要把 `list_url_hint` 校准到当前 200 路径（参考 v2.2 followup PR #4 做法）。

### 3. UA / Referer / Accept-Language 模板

`fetch.js` 中硬编码的请求头（`DEFAULT_UA` 导出，可在测试中替换）：

```
User-Agent:        brain-bankv3-faculty-crawler/1.0 (+multica; academic-research; +https://github.com/Jiayang-ee/brain-bankv3)
Accept:            text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language:   en-US,en;q=0.8,zh-CN;q=0.6,zh;q=0.4
Accept-Encoding:   gzip, deflate, br
Cache-Control:     no-cache
```

- **不带 Referer**：避免对 Referer 校验产生不必要的耦合。`fetch.js` 未设置 `Referer`，目标站按 Origin 校验时会缺失，可通过 `headers` 注入覆盖（`fetchWithRetry(url, { headers: { Referer: 'https://...' } })`），但 MVP 阶段不带。
- **Accept-Language 顺序**：英文优先、中文次之，匹配 MIT / Stanford / 清华等校双语页面的"英文路径"主流量；不要替换为 `zh-CN` 优先（会被 5% 的英文-only 站直接 404 列表）。
- **UA 含项目身份**：`brain-bankv3-faculty-crawler/1.0` 便于目标站运维在 access log 中识别本项目；如需匿名爬取请改用 `DEFAULT_UA` 之外的 fake UA（**违反 v2.3 runbook，请走 PR review**）。

### 4. 大小 / 超时

| 维度 | 默认 | 触发后行为 |
| --- | --- | --- |
| 响应体上限 | **8 MiB** (`MAX_BYTES = 8 * 1024 * 1024`) | 超过即 `res.destroy()`，`crawl_log.status='too_large'` |
| 请求超时 | **12s**（discover.js 调用值；fetch.js 函数默认 15s） | `req.setTimeout(12s, ...)` → `crawl_log.status='timeout'` |
| 整次（含重试） | 最坏 ≈ 12s + 300ms + 12s + 600ms ≈ 25s | — |
| 跨 host 重定向 | **不允许**（`cross_host_redirect` 错误） | 例如 `mit.edu` → `cloudfront.net` 一律丢弃；想跟的需改 `fetchWithRedirects` 的 host 校验 |

8 MiB 是经验值：MIT 学院页偶尔含 base64 头像大图会顶到 4-5 MiB；12s 超时对北美 50 校在中美跨太平洋链路上 99% 够用（实测 P95 ≈ 4s）。

### 5. 反爬识别（Cloudflare / Akamai / WAF）应对

按 `--all` 全量跑（[BRA-13](mention://issue/e0e1c548-ba3b-46eb-9b8e-2ebfe02ec701)）**最终 3892 条 row** 实测 `crawl_log.status` 分布（PR #6 落地快照 `faculty/data-snapshots/bra-7.2-2026-06-03/crawl_log.jsonl`）：

| `status` | 占比 | row 数 | 含义 / 应对 |
| --- | --- | --- | --- |
| `success` | 39.3% | 1531 | HTTP 2xx/3xx，HTML 已落库 |
| `http_error` | 38.6% | 1502 | 详见下表 HTTP status 分类 |
| `cross_host_redirect` | 8.5% | 330 | 跳到不同 host，丢弃；常见于 MIT → IDSS / Stanford → CDM |
| `dns_error` | 8.0% | 312 | DNS 解析失败；多为境外校 `.ac.uk` / `tsinghua.edu.cn` 解析慢或被墙 |
| `error` | 2.0% | 78 | 其他未分类；看 `error_detail` |
| `connection_refused` | 2.0% | 78 | TCP RST 后无响应；多为目标站临时维护或 IP 黑名单 |
| `timeout` | 1.5% | 57 | 12s 内未完成；集中在清华域 + 部分欧洲校 |
| `connection_reset` | 0.1% | 2 | TCP RST；目标主动断流 |
| `skipped` | 0.1% | 2 | 预期跳过（Caltech suspected_irrelevant），不计入 failure |

`http_error` 内部按 `http_status` 细分（1502 条 row）：

| HTTP status | row 数 | 处置 |
| --- | --- | --- |
| 404 | 900 | 列表候选路径全 404 → `department_summary.last_run_status='no_faculty_page'`，**计 1 次 failure**。常见原因：v2.1 时代 hint URL 已 stale（v2.2 followup PR #4 已校准 3 条）；仍有 ~100 条需要 v2.4 followup 校准 |
| 403 | 507 | **WAF / Cloudflare 拦截**。**不重试**（4xx 跳过重试）。若 `crawl_log.error_detail` 含 `cloudflare` / `akamai` / `access denied`，整部门记 `access_failed` |
| 301 / 302 | 330 | 已尝试跟随 ≤5 次同 host；不计入 failure |
| 500 / 508 | 78 | 服务端错误；**会重试 1 次**（非 4xx）；再失败进 `error` |
| 429 | 17 | **限速**。**当前实现不专门 backoff**——host-level 1.5s 间隔对绝大多数足够；如果跑出 429 > 1% 的 host，把它的 hint 走 `--out` 单 host 重跑并把限速调到 3000ms |

**实战经验**：
- **Stanford 子站（`gsb.stanford.edu` / `mccombs.utexas.edu`）的 403** 不需要重试——直接接受 `no_faculty_page`，把这类部门加 `qs50_departments.json` 的 `notes` 注明"403 WAF"以便人工评估是否走 headless。
- **MIT IDSS WordPress 站**的 200 + 404 模板（`<title>Not Found – IDSS</title>`）当前由 v2.2 起的 `parseNameFromTitle` 兜底，把 name 退到 `nameFromUrlSlug`；不会污染 `name_raw` 字段——[BRA-13](mention://issue/e0e1c548-ba3b-46eb-9b8e-2ebfe02ec701) 最终 3892 row 中确认 0 条 `name_raw='Not Found'` 污染。
- **清华域 DNS 慢/超时**（v2.3 runbook 新增）：`tsinghua.edu.cn` / `tsinghua-dmei` 的 DNS 解析在跨太平洋链路上 P95 > 8s，单部门贡献了 timeout 57 条中的 30+ 条。**应对**：把清华相关 entry 加 `qs50_departments.json` 的 `notes: 'dns_slow; expect timeout; skip on --all'`；下游 BRA-10 人工 review 时直接走 headless。
- **双斜杠 URL 污染**（v2.3 runbook 新增）：少数 entry.url 末段带 `//`（数据录入 bug，非 fetch 引起），导致拼接的 `entry.url + '/people'` 变成 `https://x//people`，触发 404/308 异常。**应对**：BRA-15 (v2.4) followup 会在 loader 层 strip 末尾 `/`；runbook 本期不修代码。
- **connection_refused 78 条**（v2.3 runbook 新增）：多为目标站临时维护或 IP 黑名单，单 host 不重复出现。**应对**：重跑可能恢复；不需要改 host-level 限速。
- **Cloudflare 5 秒盾 / JS challenge** 当前 SSR-only fetcher 无法绕过；如果单部门反复返回 200 + challenge HTML（`cf-chl-bypass` / `__cf_chl_jschl_tk__`），后续要单开 headless issue。

### 6. 增量跑：跳过已有本地 HTML

**`--skip-existing`**（v2.3 起，BRA-7.3）：

- 仅作用于 **personal_page URL**：若 `candidates` 表中 `(source_kind='personal_page', source_url=u)` 的最新 `crawl_status='success'`，跳过本次 `fetchImpl(u)` 调用，**不重写 candidate 行**（`ON CONFLICT` 也不触发），计入输出 JSON 的 `skippedExisting` 字段。
- **不作用于 list_page URL**：list 页面通常 < 100KB，每个部门最多 1-2 次请求；保留重抓是为了发现新增的 profile URL（学校可能在本周加新教师）。如需严格断点续跑 list 页，可手改 `findListPage` 加同款检查。
- **不作用 active 入口选择**：仍会重跑每个 active 入口，读取 `department_summary` 决定状态。
- **退出码语义不变**：`failures=0` → exit 0；`skippedExisting` 只在 JSON 输出中暴露，不影响退出码。

端到端验证（用 `--schools 1,7 --max-profiles 3` 真实网络）：

```text
first run:  { "processed": 4, "withList": 4, "profiles": 9, "skippedExisting": 0, ... }
second run: { "processed": 4, "withList": 4, "profiles": 0, "skippedExisting": 9, ... }
            # candidates 行数从 13 仍是 13（不重复写入）
```

`scripts/tests/discover-flow.test.js` 中 `processDepartment: --skip-existing → 第二轮 personal_page URL 不重抓、不重写` 单测覆盖该行为。

### 7. 分批重跑脚本

`scripts/rerun-by-school.sh` 适合 50 校 `--all` 跑太久（2-3 小时）易被中途 WAF 拦、断网断电、需要分批验收的场景。

```bash
# 跑前 10 校，每批 5 校，断点续跑
bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5,6,7,8,9,10 --batch-size 5

# 跑完全 50 校（10 批 × 5 校）
bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50 --batch-size 5

# 自定义输出目录 + dry-run 演练
bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5 --batch-size 2 --max-profiles 3 --dry-run --out /tmp/faculty-out

# 重跑特定批（断点续跑）
bash faculty/scripts/rerun-by-school.sh --schools 1,2,3,4,5 --batch-size 5
# 第二次执行会自动 --skip-existing 已成功条目
```

行为契约：

- 按 `--batch-size`（默认 5）切分 `--schools` 列表
- 每批调用 `node faculty/scripts/discover.js --schools <batch> --skip-existing --out <out> [其他参数]`
- 单批失败（discover.js 退出码非 0）→ 记录批号到 `failed_batches`、继续下一批
- 每批 stdout/stderr 写到 `<out>/crawl_log.batch-<N>.log`（discover.js 同时也写主 `crawl_log.jsonl`，重复条目因 `--skip-existing` 不会重复落 db）
- 批末打印 summary：`batches: total=N ok=N fail=N` / `totals: processed=N profiles=N skippedExisting=N failures=N`
- 全部成功 exit 0；任何批失败 exit 2（不阻断其他批执行，仅标记总状态）

### 8. 故障排查决策树

```
python://discovery 没有写 candidates
└── 查 crawl_log: status='no_faculty_page'  → list 候选 URL 全 404/403
    └── 看 'http_status' 分布: 404 → hint stale（v2.2 校准 PR）
                          403 → WAF，加 notes 注明
    └── 查 fetch_log: 都没请求 → entry 是 excluded/requires_manual_confirmation

crawl_log: 大批 dns_error
└── 一次性临时网络问题 → 重跑
└── 持续 → 公司出口对该 host 被墙 → 加 host 到 qs50_departments.json status='access_failed'

crawl_log: 429 比例 > 1%
└── 把该 host 的 1.5s 间隔手改到 3000ms（fetch.js createRateLimiter 调用），重跑
└── 或对单 host 走代理

crawl_log: cross_host_redirect 比例 > 15%
└── 单 host 实际可达但被 CDN 301 → 改 listCandidatesWithHint 加 cross_host_follow 选项（需 review）
```



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
- **BRA-10（人工审核）**：直接打开 `faculty.db`，按 `school_rank` / `category` / `chinese_name_probability` / `review_status` 筛选，编辑 `review_status` 与 `review_notes` 即可持久化（DB 已在原表留字段）。

## 已知限制

- dry-run 模式只为冒烟 / 离线验收设计，不反映真实抓取成功率。
- 真实网络跑批时，部分学校（Stanford / Princeton / 清华 等）教师页需要 JS 渲染，已标记 `requires_js`，需另起 headless（puppeteer）任务；本 MVP 走 SSR，仅记录 `requires_js` 状态。
- 华人姓名规则偏向高召回（漏杀成本 >> 误报成本），下游需人工复核或加二次过滤。
- 不下载 / 处理教师照片（属 BRA-8）。
- 不抓取论文 / 出版列表（属 BRA-9）。

## 联系

- 字段 / 数据 / 接口调整 → 继续 mention 后端开发工程师
- 前端 viewer / 人工审核 UI → 移交 BRA-10 前端开发工程师
