# BRA-9 真实全量查询数据 — 2026-06-05

对应仓库 PR：[#10](https://github.com/Jiayang-ee/brain-bankv3/pull/10) / commit `7b69e82`，
父 issue [BRA-9](mention://issue/19aacb05-064e-408f-bfde-63976fa27817)。
**数据本身不在 git 仓内**（~700 MB，会污染仓库），通过本 Release 提供可重复下载的 durable artifact。

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
| `papers` | 95,960（DB）/ 96,036（JSONL，含极少量 cursor 重复） |
| `paper_authors` | 554,900（DB）/ 555,267（JSONL） |
| `chinese_likely` (prob ≥ 0.4) | 170,567 |
| `target_candidates` | 68,168 |

每本期刊的明细见 `SUMMARY.md`（与本 Release 一同提交到 PR #10 的 `faculty/data/real-2026-06-05/SUMMARY.md`）。

## 文件清单 + sha256 校验

| 文件 | 大小 | sha256 |
| --- | ---: | --- |
| `faculty.db` | 304 MB | `5e52f647f85597fdaa6578ec277ee0eef9980872367aa800a421dadea84acfb0` |
| `paper_authors.jsonl` | 336 MB | `9d60beff700b7cf3e8eed011459d0bf4860a4077ce5b2fde02ec667656c86b33` |
| `papers.jsonl` | 60 MB | `4450c4186094ec27843b47288e10c5016c711bf9aa40ef56a855592fb05bde8d` |
| `journals.jsonl` | 132 KB | `e1955e46ead2b58c93000d0264b787d2d1a5a391f5a1f2155a07cf7dc90657de` |
| `crawl_log.jsonl` | 12 KB | `21b44d4e07efb941d7236e2cb761cfc73352c1005bdaaa911faa72143d180b36` |

`faculty.db` 是 source of truth：JSONL 是 append-only 流水日志，
极少数 paper 在分页回执边界上重复，DB 的 `INSERT OR REPLACE` + UNIQUE 约束已去重。

## 下载 / 校验命令

```bash
# 解压后请用 shasum / sha256sum 校验每个文件
for f in faculty.db paper_authors.jsonl papers.jsonl journals.jsonl crawl_log.jsonl; do
  shasum -a 256 "$f"
done

# SQLite 直接读
sqlite3 faculty.db "SELECT query_status, COUNT(*) FROM journals GROUP BY query_status;"

# 跑仓库的 validate.js（需要 checkout PR #10 后的 brain-bankv3 仓）
node faculty/scripts/validate.js --out faculty/data/real-2026-06-05
```

## 已知边界

- 11 本 CN-only 中文期刊只能记 `api_unsupported`（OpenAlex / Crossref 按 ISSN 解析，CN 号无法 resolve）
- `自动化学报` 在 OpenAlex 上只收录到 1 篇 paper，疑似库收录不全
- Crossref 不暴露通讯作者字段，按 PR #9 约定取末位作者当 potential corresponding
- 部分 paper 在 OpenAlex/Crossref 缺 authorships / affiliation，无法在数据层兜底
