# BRA-9.3 (3a spike) 数据 — 2026-06-07

对应仓库 PR：[feat/bra-9.3-crossref-3a-spike](https://github.com/Jiayang-ee/brain-bankv3/pull/13)（待开），
父 issue [BRA-9.3 (BRA-18)](mention://issue/43cebb17-9e6a-4a30-92d6-8e252733f09c)。
**数据本身不在 git 仓内**（5 个 artifact 合并 ~580 KB，但 1,000 DOI 灌入时会再生成 jsonl，不入库避免污染），通过本 Release 提供可重复下载的 durable artifact。

## 跑出来的数字

| 维度 | Crossref | OpenAIRE |
| --- | ---: | ---: |
| DOI 池 | 1,000 | 1,000 |
| 命中率（raw） | 0% | 0.4% |
| 命中率（去噪后） | 0% | 0.2% |
| 真失败 | 0 | 0 |
| 退出码 | 0 | 0 |

**ROI 决策**：❌ **关停 3a**（Crossref + OpenAIRE 都 < 0.5% 门槛），接受 email 路径天花板 2-3% 的现状。

详细结果 + 命中明细见 `SUMMARY.md`（与本 Release 一同提交到 PR 的 `faculty/data/real-2026-06-07/SUMMARY.md`）。

## 文件清单 + sha256 校验

| 文件 | 大小 | sha256 |
| --- | ---: | --- |
| `bra93-dois-1000.txt` | 25,142 B | `6d894bd860b13bd20447afe1ca34338b8d7aae562588e99ab49d29868b87fad6` |
| `crossref_email_summary.json` | 295 B | `e7f2cc4cb407a89b1bdf6fd9c2d4cdb4cd03148e6971feb83f8df8a7e2170a31` |
| `crossref_email_query_log.jsonl` | 194,583 B | `1eebb8ceffb2b91d388f78b350b23a8976661befa4ca319a172ad622123fc32e` |
| `openaire_email_summary.json` | 317 B | `7b8d6832fcaf765336f38538f76c3c24973a08d733c41f777803b1f0b73e81e3` |
| `openaire_email_query_log.jsonl` | 194,474 B | `a98f8d0608f247e5832f417d58738ee9535be1db03383aebc2d6e12dac9fcdaf` |

`bra93-dois-1000.txt` 是 1,000 真实 DOI 输入池（来自 13 本经管期刊 2023-2025 最新 100 篇）；
`{crossref,openaire}_email_summary.json` 是最终命中汇总；
`{crossref,openaire}_email_query_log.jsonl` 是每条 HTTP 调用的审计行（ts / doi / http_status / duration_ms / ok / error / emails）。

## 下载 / 校验命令

```bash
# 下载后校验
cd <download-dir>
for f in bra93-dois-1000.txt crossref_email_summary.json crossref_email_query_log.jsonl openaire_email_summary.json openaire_email_query_log.jsonl; do
  echo "=== $f ==="
  shasum -a 256 "$f"
done
```

## 关联

- PR：[feat/bra-9.3-crossref-3a-spike](https://github.com/Jiayang-ee/brain-bankv3/pull/13)（待开）
- 父 issue：[BRA-9.3 (BRA-18)](mention://issue/43cebb17-9e6a-4a30-92d6-8e252733f09c)
- 父父：[BRA-9](mention://issue/19aacb05-064e-408f-bfde-63976fa27817) — done
- 兄弟：[BRA-9.1 (BRA-16)](mention://issue/c9fa87f9-5ef3-454c-b589-04ea7d39d392) — done（OpenAlex path A 2.18%）
- 兄弟：[BRA-9.2 (BRA-17)](mention://issue/f2775a4d-63c5-42ed-8662-a8877e1531bf) — done（ORCID spike, PR #12）
