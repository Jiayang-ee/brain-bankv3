# BRA-9.3 (3a spike) 1,000 真实样本查询结果 — 2026-06-07

## 目的

BRA-9.3 (BRA-18) 决策二「email 路径 3 候选」中的 3a 方向：Crossref / OpenAIRE 元数据镜像。
目标：跑 1,000 个 chinese_first/corresponding 作者关联的真实 paper DOI，对比
Crossref `/works/{doi}` 与 OpenAIRE `/search/researchProducts?doi={doi}` 端点
返回节点是否暴露 author email，给出 ROI 决策（进/不进一期放量）。

## Run metadata

- **执行命令**：
  - `node faculty/scripts/crossref_email_enrich.js --all --out /tmp/bra93-real-2026-06-07 --verbose`（1000 DOI 灌入数据）
  - `node faculty/scripts/openaire_email_enrich.js --all --out /tmp/bra93-real-2026-06-07 --verbose`
- **数据源**：
  - Crossref REST API `https://api.crossref.org/works/{doi}`（公共匿名 GET）
  - OpenAIRE REST API `https://api.openaire.eu/search/researchProducts?doi={doi}&format=json`
- **DOI 池**：`faculty/data/real-2026-06-07/bra93-dois-1000.txt`（1,000 真实 DOI，来自 13 本经管/管理学类期刊 2023-2025 年最新 100 篇，跨 publisher：Springer / Elsevier / Wiley / IEEE / MDPI / Frontiers）
- **期刊清单**（13 本）：
  - Management Science / J Optim Theory Appl / Ann Oper Res / Eur J Oper Res / Comput Oper Res
  - J Econ Dyn Control / Entropy / Admin Sci / Sustainability / J Mark Res / J Mark / M&SOM
- **速率**：
  - Crossref 限速 20 req/sec（公共 50 req/sec，公平使用降到 20）；实测 6.65 req/sec（HTTP 延迟 + gzip 解析）
  - OpenAIRE 限速 5 req/sec（公共 10 req/sec，公平使用降到 5）；实测 4.06 req/sec（响应体 ~270 KB/请求）
- **运行时长**：
  - Crossref 1,000 DOI：150.4 秒（6.65 req/sec）
  - OpenAIRE 1,000 DOI：246.3 秒（4.06 req/sec，响应体大）
- **退出码**：
  - Crossref：0（0 真 failure / 1000 200）
  - OpenAIRE：0（0 真 failure / 1000 200）

## 汇总

| 维度 | Crossref | OpenAIRE |
| --- | ---: | ---: |
| **已查询 DOI** | 1,000 | 1,000 |
| **有 email** | 0 | 4 |
| **无 email** | 1,000 | 996 |
| **404** | 0 | 0 |
| **真失败** (4xx/5xx/网络) | 0 | 0 |
| **命中率 (raw)** | **0.0%** | **0.4%** |
| **命中率 (去噪)** | 0.0% | **0.2%** (4 → 2，github.com / academia.edu 黑名单) |
| **响应体大小** | ~10 KB/请求 | ~270 KB/请求（XML 描述被压成 JSON） |

## Crossref 详情

```
source:        crossref
processed:     1,000
with_email:    0
no_email:      1,000
by_status:     { '200': 1,000 }
by_source_field: {}   ← 0 命中
failures:      0
hit_rate:      0.0
duration_sec:  150.4
rate_per_sec:  6.65
```

**结论**：Crossref `/works/{doi}` 端点**结构上不暴露 author email**。
我们扫了 5 个可能的塞邮箱位置：

| 字段 | 命中数 |
| --- | ---: |
| `author[].affiliation[].name` | 0 |
| `author[].name` | 0 |
| `author[].role[].role` | 0 |
| `assertion[].value` / `assertion[].name` | 0 |
| `license[].URL` | 0 |

出版商（Springer / Elsevier / Wiley / IEEE / MDPI / Frontiers）都不在 Crossref deposited metadata 里塞邮箱。
这与 ORCID 公共 API「匿名 `/read-public` scope 不返回 email」是同源问题：
**Crossref / ORCID 公共 metadata 都不是 email 通道**。

## OpenAIRE 详情

```
source:        openaire
processed:     1,000
with_email:    4
no_email:      996
by_status:     { '200': 1,000 }
by_source_field: { 'openaire': 5 }   ← 5 个邮箱散落在 4 个 DOI
failures:      0
hit_rate:      0.4
duration_sec:  246.3
rate_per_sec:  4.06
```

**实际命中明细**（4 个 DOI / 5 个邮箱）：

| DOI | 邮箱 | 噪声？ |
| --- | --- | --- |
| `10.1007/s10957-024-02514-2` | `alessandro.milazzo@math.uu.se` | ✓ 真实（Uppsala Univ 数学系） |
| `10.3390/e25111557` | `ihorv2@g.uky.edu` | ✓ 真实（Kentucky 大） |
| `10.3390/e25111557` | `peter.markos@fmph.uniba.sk` | ✓ 真实（Bratislava Comenius Univ） |
| `10.3390/e25060854` | `prgpascal@Github.com` | ✗ 噪声（github.com） |
| `10.3390/su151914426` | `dr.eng.mukabi@academia.edu` | ✗ 噪声（academia.edu） |

**结论**：OpenAIRE 极少把 author 邮箱塞进 creator block 字符串（命中率 0.2-0.4%）。
即便命中，2/5 是用户填的平台邮箱（github / academia.edu）而非机构邮箱，
真实可用命中率约 0.3%。

## ROI 决策

| 候选 | 命中率 | 反爬风险 | 实施成本 | 决策 |
| --- | ---: | --- | --- | --- |
| **3a Crossref** | **0%** | 低 | 低 | **❌ 关停** |
| **3a OpenAIRE** | **0.2%** (raw 0.4% 去噪后) | 低 | 低 | **❌ 关停** |
| BRA-9.1 path A OpenAlex regex（基线） | 2.18% | — | — | ✅ 保留 |

**对照 BRA-9.3 issue 风险段**：

> 风险 - 3a 也低命中率：3-5% 是中位估计，0-1% 也可能；如实际 < 0.5%，
> 应承认 email 路径天花板就是 2-3%，接受现状关停新方向

实测 Crossref 0% / OpenAIRE 0.2% 都 < 0.5% 门槛，符合 issue 预设的关停路径。

**最终结论**：

1. **email 路径天花板即现状**：OpenAlex path A 2.18% 是当前唯一稳定来源；Crossref / OpenAIRE 元数据镜像实测 < 0.5%，不足以 ROI 放量。
2. **不再投入 3b / 3c spike**：3b（单位主页爬虫）反爬风险与 BRA-7.3 同质，前置评估不能省但优先级降为「仅在有真用户反馈缺邮件时再做」；3c（arXiv 5xxx 脚注）覆盖度 < 5% 论文，绝对增量小，**直接关停**。
3. **ORCID 路径 KPI 切换**：从 email 命中率（已证伪 0%）改为 profile 覆盖率（affiliations / 跳槽识别高价值，PR #12 已合入）。
4. **现状可接受**：2.18% OpenAlex regex 覆盖率是 email 路径硬天花板，不再加新 spike。

## 文件清单 + sha256 校验

| 文件 | 大小 | sha256 |
| --- | ---: | --- |
| `bra93-dois-1000.txt` | 25,142 B | `6d894bd860b13bd20447afe1ca34338b8d7aae562588e99ab49d29868b87fad6` |
| `crossref_email_summary.json` | 295 B | `e7f2cc4cb407a89b1bdf6fd9c2d4cdb4cd03148e6971feb83f8df8a7e2170a31` |
| `crossref_email_query_log.jsonl` | 194,583 B | `1eebb8ceffb2b91d388f78b350b23a8976661befa4ca319a172ad622123fc32e` |
| `openaire_email_summary.json` | 317 B | `7b8d6832fcaf765336f38538f76c3c24973a08d733c41f777803b1f0b73e81e3` |
| `openaire_email_query_log.jsonl` | 194,474 B | `a98f8d0608f247e5832f417d58738ee9535be1db03383aebc2d6e12dac9fcdaf` |

## 下载 / 校验命令

```bash
# 校验（macOS / Linux）
cd faculty/data/real-2026-06-07
for f in bra93-dois-1000.txt crossref_email_summary.json crossref_email_query_log.jsonl openaire_email_summary.json openaire_email_query_log.jsonl; do
  echo "=== $f ==="
  shasum -a 256 "$f"
done
```

## 复现命令

```bash
# 1. 跑 Crossref spike
node faculty/scripts/crossref_email_enrich.js --all \
  --out faculty/data/real-2026-06-07 --verbose

# 2. 跑 OpenAIRE spike
node faculty/scripts/openaire_email_enrich.js --all \
  --out faculty/data/real-2026-06-07 --verbose

# 3. 单 DOI 验证
node faculty/scripts/crossref_email_enrich.js --doi 10.1038/s41586-021-03819-2 --verbose
node faculty/scripts/openaire_email_enrich.js --doi 10.1038/s41586-021-03819-2 --verbose
```

## 关联

- 父 issue：[BRA-9.3 (BRA-18)](mention://issue/43cebb17-9e6a-4a30-92d6-8e252733f09c)
- 父 issue：[BRA-9.1 (BRA-16)](mention://issue/c9fa87f9-5ef3-454c-b589-04ea7d39d392) — done（OpenAlex path A 2.18% 基线）
- 兄弟：[BRA-9.2 (BRA-17)](mention://issue/f2775a4d-63c5-42ed-8662-a8877e1531bf) — ORCID 路径（已合入 PR #12）
- 关联 PR（待开）：feat/bra-9.3-orcid-kpi-switch（KPI 切换）、feat/bra-9.3-crossref-3a-spike（本 spike）
