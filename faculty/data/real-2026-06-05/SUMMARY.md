# BRA-9 真实全量查询结果 — 2026-06-05

## Run metadata

- **执行命令**：`node faculty/scripts/papers.js --all --out faculty/data/real-2026-06-05 --verbose`
- **数据源**：OpenAlex (primary) + Crossref (fallback)
- **时间范围**：2021-01-01 ~ 2026-06-03
- **期刊清单**：`faculty/data/journals.csv`（51 本：12 中文 + 39 英文）
- **Limit 设置**：未设 `--max-papers` / `--limit`；代码内置 `maxPages: 200 × perPage: 200`（约 40K 篇/刊硬上限）
- **速率**：内置 OpenAlex 1.5s/请求 + 2 次重试 + exponential backoff
- **运行时长**：约 15 分钟（PID 48069，etime 见 stderr log）
- **退出码**：0（无真 failure；0 failures, 11 api_unsupported）

## 汇总

| 维度 | 值 |
| --- | ---: |
| 期刊总数 | 51 |
| `success` | 40 |
| `api_unsupported` | 11 |
| `failed` | 0 |
| `no_results` | 0 |
| `papers` (DB) | 95,960 |
| `papers` (papers.jsonl) | 96,036 |
| `papers` in 2021-2026 范围 | 95,960（100%） |
| `paper_authors` (DB) | 554,900 |
| `paper_authors` (paper_authors.jsonl) | 555,267 |
| `chinese_likely` (prob ≥ 0.4) | 170,567 |
| `target_candidates` | 68,168 |

## 期刊明细（按 papers_kept 降序）

| 期刊 | papers | target_candidates |
| --- | ---: | ---: |
| NATURE | 20,478 | 4,429 |
| PROCEEDINGS OF THE NATIONAL ACADEMY OF SCIENCES OF THE UNITED STATES OF AMERICA | 20,087 | 14,116 |
| SCIENCE | 10,386 | 4,776 |
| RELIABILITY ENGINEERING & SYSTEM SAFETY | 4,609 | 7,523 |
| IEEE TRANSACTIONS ON PATTERN ANALYSIS AND MACHINE INTELLIGENCE | 3,815 | 5,454 |
| ANNALS OF OPERATIONS RESEARCH | 3,289 | 2,060 |
| EUROPEAN JOURNAL OF OPERATIONAL RESEARCH | 3,143 | 2,189 |
| JOURNAL OF THE ASSOCIATION FOR INFORMATION SYSTEMS | 3,061 | 1,226 |
| AUTOMATICA | 2,937 | 3,380 |
| MANAGEMENT SCIENCE | 2,397 | 1,463 |
| TRANSPORTATION RESEARCH PART C-EMERGING TECHNOLOGIES | 2,050 | 2,949 |
| TRANSPORTATION RESEARCH PART E-LOGISTICS AND TRANSPORTATION REVIEW | 2,036 | 3,399 |
| TRANSPORTATION RESEARCH PART A-POLICY AND PRACTICE | 1,628 | 1,450 |
| INTERNATIONAL JOURNAL OF PRODUCTION ECONOMICS | 1,516 | 1,649 |
| PRODUCTION AND OPERATIONS MANAGEMENT | 1,280 | 1,320 |
| JOURNAL OF THE AMERICAN STATISTICAL ASSOCIATION | 1,135 | 1,264 |
| INFORMS JOURNAL ON COMPUTING | 948 | 727 |
| JOURNAL OF THE OPERATIONAL RESEARCH SOCIETY | 891 | 935 |
| OPERATIONS RESEARCH | 856 | 573 |
| OMEGA-INTERNATIONAL JOURNAL OF MANAGEMENT SCIENCE | 808 | 948 |
| TRANSPORTATION RESEARCH PART B-METHODOLOGICAL | 760 | 1,049 |
| DECISION SUPPORT SYSTEMS | 702 | 836 |
| M&SOM-MANUFACTURING & SERVICE OPERATIONS MANAGEMENT | 684 | 572 |
| INFORMATION SYSTEMS RESEARCH | 626 | 560 |
| MATHEMATICS OF OPERATIONS RESEARCH | 591 | 360 |
| ANNALS OF STATISTICS | 561 | 433 |
| ORGANIZATION SCIENCE | 557 | 157 |
| STRATEGIC MANAGEMENT JOURNAL | 518 | 223 |
| IISE TRANSACTIONS | 485 | 639 |
| JOURNAL OF INTERNATIONAL BUSINESS STUDIES | 458 | 276 |
| MIS QUARTERLY | 433 | 306 |
| TRANSPORTATION SCIENCE | 396 | 226 |
| JOURNAL OF MARKETING RESEARCH | 343 | 168 |
| JOURNAL OF MARKETING | 329 | 128 |
| ACADEMY OF MANAGEMENT JOURNAL | 323 | 103 |
| ADMINISTRATIVE SCIENCE QUARTERLY | 294 | 48 |
| ACADEMY OF MANAGEMENT REVIEW | 289 | 57 |
| JOURNAL OF OPERATIONS MANAGEMENT | 257 | 176 |
| JOURNAL OF MACHINE LEARNING RESEARCH | 79 | 51 |
| 自动化学报 | 1 | 1 |

## api_unsupported（11 本 CN-only 中文刊）

管理世界, 管理科学学报, 南开管理评论, 中国软科学, 公共管理学报, 科研管理,
中国行政管理, 中国管理科学, 中国科学：信息科学, 中国科学：数学, 统计研究

OpenAlex 与 Crossref 都按 ISSN 解析，CN 号无法直接 resolve；按 PR #9 验收约定记 `api_unsupported`。

## validate.js 检查结果

```
- BRA-9 journals table: 51 rows
  status: {"success":40,"api_unsupported":11}
  papers: 95960 total, 95960 in 2021-2026 range
  paper_authors: 554900 total, 170567 chinese_likely, 68168 target_candidates
- journals.jsonl: 102 rows valid
- papers.jsonl: 96036 rows valid
- paper_authors.jsonl: 555267 rows valid
```

BRA-9 段全部 PASS（孤儿引用 = 0、target_candidate 一致性 = OK、年份范围 = OK、no-ISSN ↔ api_unsupported 一致 = OK）。

`validate.js` 整体脚本另有两项 `[FAIL]`：`department_summary covers only 0/50 schools` 和 `schools covered = 0/50`。
这两条属于 BRA-7 部门/候选人种子的检查，本目录是 BRA-9 真实数据专用、不带 BRA-7 种子数据，与 PR #9 验收 dry-run 时同样的预期行为。

## JSONL 与 SQLite 行数差异

- `papers.jsonl` 96,036 行 vs `papers` 表 95,960 行（多 76 行）
- `paper_authors.jsonl` 555,267 行 vs `paper_authors` 表 554,900 行（多 367 行）
- `journals.jsonl` 102 行 = 51 × 2（`recordJournal` 在 `pending` 写一次、`final` 写一次，符合预期）

**`faculty.db` 是 source of truth**。JSONL 是 append-only 流水日志（`storage.js` 的 `appendJsonl` 每次都新写一行），极少数 paper 在分页回执边界上重复（OpenAlex cursor 在快速翻页时偶发回吐），DB 的 `INSERT OR REPLACE` + UNIQUE 约束做了去重；下游一切 join / 校验 / 联调都应以 `faculty.db` 为准，JSONL 仅供审计/重放。

## 文件清单（本目录）

| 文件 | 大小 | 用途 |
| --- | ---: | --- |
| `faculty.db` | 304 MB | SQLite 主库（journals / papers / paper_authors / crawl_log 四张表） |
| `papers.jsonl` | 60 MB | paper 行（按时间序） |
| `paper_authors.jsonl` | 336 MB | author 行 |
| `journals.jsonl` | 132 KB | journal 行（含 pending/final 两次写入） |
| `crawl_log.jsonl` | 12 KB | 每次期刊抓取的元数据 |
| `SUMMARY.md` | — | 本文件 |

## 已知边界

- **CN-only 11 本**：需要后续接 CNKI/万方/CSCD 或人工补源（PR #9 列为非目标）
- **`自动化学报` 仅 1 篇**：OpenAlex 对该刊的收录疑似不全（不像 NATURE / PNAS / 顶刊管理类动辄数千篇），如需完整中文期刊数据请改走 CNKI
- **Crossref 无通讯作者字段**：按 PR #9 约定"末位作者 = potential corresponding"
- **OpenAlex/Crossref 自身数据缺失**：部分 paper 缺 authorships / affiliation；无法在数据层兜底
- **下游联调**：`paper_authors.chinese_name_probability >= 0.4` 的华人作者可与 `candidates` 表 fuzzy match 联调（同人可能既在系里任课又发顶刊）

## 下载 / 持久交付（GitHub Release）

~700 MB 数据**不**入 git 仓（参 `faculty/.gitignore` 的 `data/real-*/` 规则）。
durable artifact 走 GitHub Release：

- **Release**: <https://github.com/Jiayang-ee/brain-bankv3/releases/tag/bra-9-real-2026-06-05>
- **5 个 asset**：`faculty.db`（304 MB，主数据源）、`paper_authors.jsonl`（336 MB）、`papers.jsonl`（60 MB）、`journals.jsonl`（132 KB）、`crawl_log.jsonl`（12 KB）
- **校验方式**：每个 asset 的 sha256 摘要列在 Release 正文里；下载后用 `shasum -a 256 <file>` 校验
- **复用方法**：解压到任意目录 `data/real-2026-06-05/`，再 `node faculty/scripts/validate.js --out data/real-2026-06-05`

## 复现命令

```bash
# 推荐：仓库自带的 launcher（repo-relative，支持 OUT_DIR / LOG_DIR / SYSTEMS_FILTER 覆盖）
scripts/run_bra9_real.sh

# 等价于（手动跑也行）：
cd <repo>
mkdir -p faculty/data/real-$(date +%Y-%m-%d)
node faculty/scripts/papers.js --all \
  --out faculty/data/real-$(date +%Y-%m-%d) \
  --verbose

# 校验
node faculty/scripts/validate.js --out faculty/data/real-$(date +%Y-%m-%d)
```
