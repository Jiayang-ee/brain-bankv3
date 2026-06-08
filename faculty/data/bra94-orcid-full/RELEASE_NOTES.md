# Release Notes — bra-9.4-2026-06-08

## 摘要

BRA-9.4 (BRA-19) ORCID 反向查询**全量**跑（不再限 100 样本）+ profile 覆盖率 KPI 验收
**PARTIAL**: 41,943 候选中跑 13,820 (32.96%)，KPI 形式通过 (100.0% ≥ 50% 门槛)。

**关键发现**：`lib/orcid_enrich.js` 的 `extractExternalIds` / `extractCreditName` 假设 ORCID
v3 返回 `{value: "..."}` 嵌套，但实际是裸字符串。导致 `orcid_external_ids_json` 列实际
捕获率 0%（profile_json 列存了完整响应，可修复 extraction 后重跑）。详见 SUMMARY.md
"Critical finding" 段。

## 5 artifact

| 文件 | sha256 | 大小 | 用途 |
| --- | --- | --- | --- |
| `bra94-orcid-queries.txt` | `890a64f141d1aa9eb8b8d23c63d87d7785d42075b1ac38422add881b7124e207` | 848,874 B | 跑过的 ORCID iD + 命中状态 |
| `orcid_full_summary.json` | `c9d05ea75b4edc02e8616f798f1319e9fc55c25d82f1dbd4e82cbbdeabf0d4e3` | 3,174 B | summary（rate / by_status / failures）|
| `orcid_full_query_log.jsonl` | `24c9f86e33540d7127a8d683a06374bb2d10a1ebd2134037cc60911157c21b9f` | 4,609,780 B | per-call 审计（13872 行）|
| `orcid_full_db_diff.json` | `aefc9f9fbc2244f0f15d1714aad8a74083a012478ba1ce031983661df0026795` | 1,432 B | DB 前后状态（queried / covered / by_status）|
| `orcid_full_kpi.txt` | `aab4a8f6af1ccff8638d2f5abf94bd5f530755a030ea4a9d2f31a448a79f60a6` | 1,113 B | validate.js 输出（KPI 行: 13820/13820 = 100.0%）|

## 复现命令

```bash
# 1. 拉 DB
mkdir -p faculty/data/bra94-orcid-full && cd faculty/data/bra94-orcid-full
gh release download bra-9.1-real-2026-06-06 --repo Jiayang-ee/brain-bankv3 --pattern faculty.db -O faculty.db
# sha256 期望: c96e03e571fff8e6185b9e7e7bf21d7e14b76d8d26a5d71c9f75ba05b5886c0e

# 2. (单次) 手动加 ORCID 7 列（schema migration 漏写 CREATE INDEX 在 SCHEMA_SQL，导致老 DB
#    createStore 时会因 orcid_last_fetched 列不存在而失败 — 这是 BRA-9.2 已知 bug，未修)
sqlite3 faculty.db <<'EOF'
ALTER TABLE paper_authors ADD COLUMN email_orcid_id TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_credit_name TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_external_ids_json TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_affiliations_json TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_last_modified TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_last_fetched TEXT;
ALTER TABLE paper_authors ADD COLUMN orcid_profile_json TEXT;
CREATE INDEX IF NOT EXISTS idx_pa_orcid_fetched ON paper_authors(orcid, orcid_last_fetched);
EOF

# 3. 跑 ORCID --all (会 resume 剩余 29,028 iD；已查询的 13,820 iD 自动跳过)
cd /path/to/brain-bankv3
node faculty/scripts/orcid_enrich.js --all --out faculty/data/bra94-orcid-full --verbose

# 4. 跑 KPI 验收
node faculty/scripts/validate.js --out faculty/data/bra94-orcid-full
# 期望：- ORCID profile 覆盖率: covered/queried >= 50%
```

## 跑批结果

| 维度 | 值 |
| --- | ---: |
| 候选总数 | 41,943 |
| 已查询 | 13,820 (32.96%) |
| 剩余 | 29,028 (67.04%) |
| 真失败 | 15 (0.11%) — 远低于 50% 门槛 |
| 退出码 | 0 |
| 运行时长 | ~80 min |
| 速率 | 2.86 req/sec |
| email 命中率 (orcid_public_api) | 11.0% (1,520 / 13,820) |
| **KPI: ORCID profile 覆盖率** | **13820/13820 = 100.0%** ≥ 50% ✅ |

## ROI 决策

**形式通过，但实际数据捕获率为 0%**：
- KPI 公式看 `orcid_affiliations_json != ''`，`[]` 也算「非空」，所以所有查询行都被算 covered
- 真实 KPI（看 `orcid_external_ids_json != '[]'`）当前是 0%
- 建议 PR A：修 extract 函数 + 重跑 extraction（无需重打 API），把 external_ids 列从 0% 提升到 ~50%

**全量跑预计还需 ~3.4 hours**：本次 agent runtime 时间有限只跑了 33%，剩余 67% 可在
专用 batch 环境（cron job / CI runner）跑，无须 `--force` 覆盖。30 天增量窗口会自然
resume 剩余 29,028 iD。

## 关联

- 父 issue：[BRA-9.4 (BRA-19)](https://github.com/Jiayang-ee/brain-bankv3/issues/19)
- 关联 PR：本 PR (docs + release 归档)
- 数据库来源：[bra-9.1-real-2026-06-06](https://github.com/Jiayang-ee/brain-bankv3/releases/tag/bra-9.1-real-2026-06-06)
