# BRA-9.1 真实全量查询数据 — 2026-06-06

对应仓库 PR：[#11](https://github.com/Jiayang-ee/brain-bankv3/pull/11) / commit `dfa5fa2`，
父 issue [BRA-9.1 (BRA-16)](mention://issue/c9fa87f9-5ef3-454c-b589-04ea7d39d392)，
祖父 [BRA-9](mention://issue/19aacb05-064e-408f-bfde-63976fa27817) (PR #10)。
**数据本身不在 git 仓内**（~910 MB，会污染仓库），通过本 Release 提供可重复下载的 durable artifact。

## 跑出来的数字

- 期刊清单：`faculty/data/journals.csv`（51 本：12 中文 CN-only + 39 英文 ISSN）
- 数据源：OpenAlex (primary) + Crossref (fallback)
- 时间范围：2021-01-01 ~ 2026-06-03
- 退出码：0（无真 failure）

| 维度 | 值 |
| --- | ---: |
| `success` 期刊 | 40 |
| `api_unsupported` 期刊 | 11 |
| `failed` 期刊 | 0 |
| `papers` (DB) | 95,960 |
| `papers` (papers.jsonl) | 96,036 |
| `papers` in 2021-2026 范围 | 95,960 (100%) |
| `paper_authors` (DB) | 554,900 |
| `paper_authors` (paper_authors.jsonl) | 555,267 |
| `chinese_likely` (prob ≥ 0.4) | 170,567 |
| `target_candidates` | 68,168 |
| **`emails` (email_raw 非空)** | **12,077** |
| **`email coverage`** | **2.18% (≥ 1% OK)** |
| `email_source` 分布 | `{"openalex_regex": 12077}` (path A 兜底；path B 0 命中) |
| distinct emails | 9,563 |

> 详见 `SUMMARY.md` 的"路径 A 覆盖率分析（实测 vs 假设）"段。

## 路径 A 覆盖率（实测）

- 假设（issue 预测）：< 5%
- **实测：2.18% (12,077 / 554,900) — 达到 ≥ 1% 目标**
- 来源：100% `openalex_regex`（path A 兜底从 `raw_affiliation_strings`（OpenAlex string[]，原 BRA-9 代码误用 `raw_affiliation_string` 单数字段，PR #11 commit `dfa5fa2` 已修）抽邮箱）
- 0% 命中时建议：path B (publisher-side adapter) spike 在 BRA-9.2 重新评估

## 文件清单 + sha256 校验

| 文件 | 大小 | sha256 |
| --- | ---: | --- |
| `faculty.db` | 396,926,976 (397 MB) | `c96e03e571fff8e6185b9e7e7bf21d7e14b76d8d26a5d71c9f75ba05b5886c0e` |
| `paper_authors.jsonl` | 450,399,231 (450 MB) | `c5e93225df5346e8fedd8a55c8618a01bab6aa6c64f381cac51e5834b2912b20` |
| `papers.jsonl` | 62,616,947 (63 MB) | `9b5eefe77f96986d7fb5ab791d0417e87db438e6cb46e5689835cf99ddd9d240` |
| `journals.jsonl` | 82,682 (82 KB) | `edfc222bc73a10cd1452803dfaa0da7b3ca0dc87006d6909cd226e71bec86176` |
| `crawl_log.jsonl` | 11,569 (12 KB) | `5d936b56802e58de8d75d742e7ede4238724b14f6b9350da545b5261c0b65967` |

> `faculty.db` 是 source of truth：JSONL 是 append-only 流水日志，
> 极少数 paper 在分页回执边界上重复，DB 的 `INSERT OR REPLACE` + UNIQUE 约束已去重。

## 下载 / 校验命令

```bash
# 解压后请用 shasum / sha256sum 校验每个文件
for f in faculty.db paper_authors.jsonl papers.jsonl journals.jsonl crawl_log.jsonl; do
  shasum -a 256 "$f"
done

# SQLite 直接读
sqlite3 faculty.db "SELECT query_status, COUNT(*) FROM journals GROUP BY query_status;"
sqlite3 faculty.db "SELECT 'emails:', COUNT(*) FROM paper_authors WHERE email_raw IS NOT NULL;"
sqlite3 faculty.db "SELECT 'coverage %:', ROUND(100.0*SUM(CASE WHEN email_raw IS NOT NULL THEN 1 ELSE 0 END)/COUNT(*), 2) FROM paper_authors;"

# 跑仓库的 validate.js
node faculty/scripts/validate.js --out faculty/data/real-2026-06-06
```

## Schema 变更（v1.2 → v1.3）

`paper_authors` 表新增 3 个 nullable 列（幂等 `ensureColumn` 迁移；老 DB 兼容）：

- `email_raw TEXT` — 抽到的邮箱原文
- `email_source TEXT` — `'openalex_regex'` / `'publisher_wiley'` / `'publisher_elsevier'` / `'manual'` / NULL
- `email_match_context TEXT` — 命中哪条 affiliation 字符串（截断 500 字符）

新增索引 `idx_pa_email_source ON paper_authors(email_source)`，便于按来源筛选。

`paper_authors.jsonl` 流水同步增加 3 个字段（向后兼容：未命中作者三件套都是 null）。

## 已知边界

- 11 本 CN-only 中文期刊只能记 `api_unsupported`（OpenAlex / Crossref 按 ISSN 解析，CN 号无法 resolve）
- 路径 A 在 51 期刊全量 re-run 上实测 2.18% 覆盖率（≥ 1% OK；issue 预测 < 5%）
- 路径 A 字段名修复：PR #11 commit `dfa5fa2`，把 BRA-9 沿用的 `raw_affiliation_string` (单数) 改为 OpenAlex 实际的 `raw_affiliation_strings` (string[]) 后 join
- 路径 B（publisher-side adapter）按 issue 描述需要 spike + 逐 publisher 适配器，不在 BRA-9.1 范围
- NATURE 单一来源贡献 94.8% 邮箱命中（11,453 / 12,077），是覆盖率达标的关键；其他 49 本期刊平均仅 0.0x%
- `自动化学报` 在 OpenAlex 上只收录到 1 篇 paper，疑似库收录不全（沿用 BRA-9 结论）
- Crossref 不暴露通讯作者字段，按 PR #9 约定取末位作者当 potential corresponding
- 部分 paper 在 OpenAlex/Crossref 缺 authorships / affiliation，无法在数据层兜底
- validate.js 中 `department_summary` / `schools covered` FAIL 是 BRA-9 时代遗留 gap（personal_page / photos.js 未跑），非 BRA-9.1 regression
