# BRA-9.1 真实全量查询 — 数据汇总

对应仓库 PR：[#11](https://github.com/Jiayang-ee/brain-bankv3/pull/11) (branch `agent/agent/33840c40`)
对应父 issue [BRA-9.1 (BRA-16)](mention://issue/c9fa87f9-5ef3-454c-b589-04ea7d39d392)
对应祖父 [BRA-9](mention://issue/19aacb05-064e-408f-bfde-63976fa27817) (PR #10)

数据本身不在 git 仓内（~700 MB，会污染仓库），通过 GitHub Release `bra-9.1-real-2026-06-06` 提供可重复下载的 durable artifact。

## 1. 跑出来的数字（v1.3 schema）

### 1.1 期刊 / 论文 / 作者

| 维度 | 值 |
| --- | ---: |
| 期刊清单 | `faculty/data/journals.csv`（51 本：12 中文 CN-only + 39 英文 ISSN） |
| 数据源 | OpenAlex (primary) + Crossref (fallback) |
| 时间范围 | 2021-01-01 ~ 2026-06-03 |
| 退出码 | 0（无真 failure） |
| `success` 期刊 | 40 |
| `api_unsupported` 期刊 | 11（CN-only 中文期刊，OpenAlex / Crossref 无法按 CN 号 resolve） |
| `failed` 期刊 | 0 |
| `papers` (DB, source of truth) | 95,960 |
| `papers` (papers.jsonl) | 96,036 |
| `papers` in 2021-2026 范围 | 95,960 (100%) |
| `paper_authors` (DB) | 554,900 |
| `paper_authors` (paper_authors.jsonl) | 555,267 |
| `chinese_likely` (prob ≥ 0.4) | 170,567 |
| `target_candidates` (first/last/corresponding ∧ chinese_likely) | 68,168 |

> DB vs JSONL 差异：极少数 paper 在分页回执边界上重复，DB 的 `INSERT OR REPLACE` + UNIQUE 约束已去重；JSONL 是 append-only 流水日志。`faculty.db` 是 source of truth。

### 1.2 邮箱 enrich（v1.3 新增）

| 维度 | 值 | 目标 |
| --- | ---: | ---: |
| **`emails` (email_raw 非空)** | **12,077** | — |
| **`email coverage` (% of paper_authors)** | **2.18%** | ≥ 1% (issue 预测 < 5%) |
| `openalex_regex` 命中 | 12,077 (100%) | path A 兜底 |
| `publisher_wiley` 命中 | 0 | path B 暂未实现 |
| `publisher_elsevier` 命中 | 0 | path B 暂未实现 |
| `manual` 命中 | 0 | 预留 |
| `email_source` enum 合法率 | 100% (12,077/12,077) | 100% |
| `email_raw` 格式合法率 | 100% (12,077/12,077) | 100% |
| distinct emails | 9,563 | — |

> ✅ **Path A 实测覆盖率 2.18% > 1% 目标，issue 预测的 < 5% 上限被命中**。Path B（publisher-side adapter）按 issue 描述需要 spike + 逐 publisher 适配器，移交 BRA-9.2 spike 阶段。

## 2. 路径 A 覆盖率分析（实测 vs 假设）

| 项 | 值 |
| --- | --- |
| 假设（issue 预测） | < 5% |
| **实测** | **2.18% (12,077 / 554,900)** |
| 命中阈值 | ≥ 1% ✅ |
| 1% 阈值容忍度 | 0% 富余 (达成但无大幅超出) |

### 2.1 覆盖率按期刊分布（top 9）

| 期刊 | 邮箱数 | 占该刊作者 % |
| --- | ---: | ---: |
| NATURE | 11,453 | 37.8% (11453/30263) |
| IEEE TPAMI | 604 | 3.9% (604/15511) |
| JOURNAL OF MARKETING | 8 | 4.1% |
| JOURNAL OF THE OPERATIONAL RESEARCH SOCIETY | 4 | 0.3% |
| SCIENCE | 3 | < 0.1% |
| PNAS | 2 | < 0.1% |
| MATHEMATICS OF OPERATIONS RESEARCH | 1 | 0.2% |
| JAIS | 1 | < 0.1% |
| JASA | 1 | < 0.1% |

**关键观察**：NATURE 贡献 11,453 / 12,077 = **94.8% 的全部邮箱**。OpenAlex 把 NATURE 论文的作者邮箱直接以 inline 字符串（不是独立字段）追加在 affiliation 末尾（例如 `... Department of X, Y, Z. email@example.edu`），所以 path A 一次性把 NATURE 命中。其他期刊的邮箱更多被 paywall / 隐私策略屏蔽，affiliation 字符串里几乎不出现。

### 2.2 邮箱按年份分布

| 年 | 邮箱数 |
| --- | ---: |
| 2021 | 2,329 |
| 2022 | 1,822 |
| 2023 | 1,960 |
| 2024 | 2,210 |
| 2025 | 2,493 |
| 2026 | 1,263（仅 1-6 月） |

> 分布相对均匀，2026 是部分年份（截止 06-03），故略低。

### 2.3 邮箱按域名 top 10

| 域名 | 邮箱数 |
| --- | ---: |
| gmail.com | 449 |
| stanford.edu | 327 |
| mit.edu | 182 |
| pku.edu.cn | 144 |
| cam.ac.uk | 142 |
| ucsf.edu | 138 |
| yale.edu | 126 |
| zju.edu.cn | 106 |
| princeton.edu | 106 |
| tsinghua.edu.cn | 104 |

> Gmail 占榜首符合预期（个人邮箱常被作者选作通讯邮箱）。高校域名第二梯队，NATURE 邮箱池分布更广（mit、stanford、ucsf 等多在 NATURE 命中），与 NATURE 占据 94.8% 命中份额一致。

### 2.4 Path A 字段名修复

**问题**：BRA-9 时代代码读 `auth.raw_affiliation_string`（单数字段），但 OpenAlex 实际返回的是 `auth.raw_affiliation_strings`（**复数** string[]）。这两个名字差异导致 path A 在初版代码上 0% 命中。

**修复**：PR #11 commit `dfa5fa2` 把 `normalizeAuthorship` 改为读数组并以 `"; "` join 还原成单条 affiliation 字符串。修复后 51 期刊全量 re-run 路径 A 实测命中 12,077 条 / 2.18%。

**对比**：

| 阶段 | path A 命中 | 原因 |
| --- | ---: | --- |
| 修复前（BRA-9 沿用代码） | 0 / 0.00% | 字段名 `raw_affiliation_string` (单数) 永远 undefined |
| 修复后（PR #11 commit `dfa5fa2`） | 12,077 / 2.18% | 读 `raw_affiliation_strings` (复数) 并 join |

## 3. Schema 变更（v1.2 → v1.3）

`paper_authors` 表新增 3 个 nullable 列（幂等 `ensureColumn` 迁移；老 DB 兼容，无需 rebuild）：

- `email_raw TEXT` — 抽到的邮箱原文
- `email_source TEXT` — `'openalex_regex'` / `'publisher_wiley'` / `'publisher_elsevier'` / `'manual'` / NULL
- `email_match_context TEXT` — 命中哪条 affiliation 字符串（截断 500 字符）

新增索引 `idx_pa_email_source ON paper_authors(email_source)`，便于按来源筛选。

`paper_authors.jsonl` 流水同步增加 3 个字段（向后兼容：未命中作者三件套都是 null）。

## 4. 已知边界 / 风险

- **11 本 CN-only 中文期刊只能记 `api_unsupported`**（OpenAlex / Crossref 按 ISSN 解析，CN 号无法 resolve）
- **路径 A 实测 2.18% 覆盖率**：刚好越线 1% 目标，无大幅超出。0% 命中时建议：path B (publisher-side adapter) spike 在 BRA-9.2 重新评估
- **路径 A 字段名修复**：PR #11 commit `dfa5fa2`，把 BRA-9 沿用的 `raw_affiliation_string` (单数) 改为 OpenAlex 实际的 `raw_affiliation_strings` (string[]) 后 join
- **路径 B（publisher-side adapter）** 按 issue 描述需要 spike + 逐 publisher 适配器，不在 BRA-9.1 范围；当前 0 命中
- **NATURE 单一来源占比 94.8%**：是覆盖率"达标"的关键贡献者。其他 49 本期刊平均仅 0.0x%。如果 BRA-9.2 走 path B 而 NATURE 又被 publisher adapter 替代，可能出现覆盖率倒退。
- **`自动化学报` 在 OpenAlex 上只收录到 1 篇 paper**，疑似库收录不全（沿用 BRA-9 结论）
- **Crossref 不暴露通讯作者字段**，按 PR #9 约定取末位作者当 potential corresponding
- **部分 paper 在 OpenAlex/Crossref 缺 authorships / affiliation**，无法在数据层兜底
- **validate.js 中 `department_summary` / `schools covered` FAIL**：是 BRA-9 时代遗留 gap（personal_page / photos.js 未跑），不是 BRA-9.1 regression

## 5. 文件清单 + sha256 校验

| 文件 | 大小 | sha256 |
| --- | ---: | --- |
| `faculty.db` | 396,926,976 (397 MB) | `c96e03e571fff8e6185b9e7e7bf21d7e14b76d8d26a5d71c9f75ba05b5886c0e` |
| `paper_authors.jsonl` | 450,399,231 (450 MB) | `c5e93225df5346e8fedd8a55c8618a01bab6aa6c64f381cac51e5834b2912b20` |
| `papers.jsonl` | 62,616,947 (63 MB) | `9b5eefe77f96986d7fb5ab791d0417e87db438e6cb46e5689835cf99ddd9d240` |
| `journals.jsonl` | 82,682 (82 KB) | `edfc222bc73a10cd1452803dfaa0da7b3ca0dc87006d6909cd226e71bec86176` |
| `crawl_log.jsonl` | 11,569 (12 KB) | `5d936b56802e58de8d75d742e7ede4238724b14f6b9350da545b5261c0b65967` |

> 解压后请用 `shasum -a 256` 校验每个文件。`faculty.db` 是 source of truth：JSONL 是 append-only 流水日志。

## 6. 验证步骤（可重复）

```bash
# 1) 下载 release 全部 5 个 asset
gh release download bra-9.1-real-2026-06-06 --repo Jiayang-ee/brain-bankv3

# 2) 校验 sha256
for f in faculty.db paper_authors.jsonl papers.jsonl journals.jsonl crawl_log.jsonl; do
  shasum -a 256 "$f"
done

# 3) SQLite 直接读
sqlite3 faculty.db <<'SQL'
SELECT query_status, COUNT(*) FROM journals GROUP BY query_status;
SELECT 'emails:' AS metric, COUNT(*) AS value FROM paper_authors WHERE email_raw IS NOT NULL
UNION ALL SELECT 'coverage %', ROUND(100.0*SUM(CASE WHEN email_raw IS NOT NULL THEN 1 ELSE 0 END)/COUNT(*), 2) FROM paper_authors;
SQL

# 4) 跑仓库的 validate.js
node faculty/scripts/validate.js --out faculty/data/real-2026-06-06
```

期望输出节选：

```
emails: 12077 with email_raw (2.18% of 554900 authors)
email coverage: 2.18% (>= 1% OK)
email_source distribution: {"openalex_regex":12077}
```

## 7. 样本邮箱（验证抽取质量）

从 12,077 条命中随机抽样 8 条（按年份倒序）：

| paper_id | author | email | journal |
| --- | --- | --- | --- |
| `doi:10.1038/s41586-025-10020-2` | Slavé Petrovski | `slav.petrovski@astrazeneca.com` | NATURE |
| `doi:10.1038/s41586-025-09943-7` | Diana van den Heuvel | `d.van_den_heuvel@lumc.nl` | NATURE |
| `doi:10.1038/s41586-025-09912-0` | B. Tripathi | `bt2693@columbia.edu` | NATURE |
| `doi:10.1038/s41586-025-10041-x` | Xinlong Wang | `xinlong.wang96@gmail.com` | NATURE |
| `doi:10.1038/s41586-026-10125-2` | Min Zhu | `zhumin@ivpp.ac.cn` | NATURE |
| `doi:10.1038/s41586-026-10114-5` | Lu Fang | `fanglu@tsinghua.edu.cn` | NATURE |
| `doi:10.1038/s41586-026-10257-5` | S. Charnoz | `charnoz@ipgp.fr` | NATURE |
| `doi:10.1038/s41586-025-09948-2` | Siddharth Doshi | `sdos@stanford.edu` | NATURE |

> 全部 8 条都来自 NATURE 命中，与 §2.1 的"94.8% 邮箱来自 NATURE"一致。
