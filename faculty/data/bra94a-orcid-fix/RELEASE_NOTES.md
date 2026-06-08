# Release Notes — bra-9.4.A-2026-06-08

## 摘要

BRA-9.4 partial run critical finding 的修复 PR：

1. 修 `extractExternalIds` / `extractCreditName` 双形态兼容（裸字符串 + `{value: ...}`）
2. 加严 `validate.js` ORCID profile KPI（拆 profile/raw + useful-derived 两口径）
3. 加 `--re-extract` CLI 模式（不发 API，从已存 `orcid_profile_json` 重算派生列）
4. 14 个新单测覆盖真实 ORCID v3 /person shape
5. 246 / 246 单测通过

不在本 PR 范围：

- 不查询剩余 29,028 个 ORCID iD（属于 BRA-9.4 full resume）
- 不加 `/employments` `/educations` 端点（属于 PR B 中期）
- 不动 `orcid_profile_json` / `orcid_last_fetched`（重提取只刷派生列）

## Before / After 指标（100 行合成 fixture）

| 指标 | 修复前 | 修复后 | 增量 |
| --- | ---: | ---: | ---: |
| `orcid_credit_name` 非空 | 0 / 100 (0%) | 95 / 100 (95%) | +95 |
| `orcid_external_ids_json` 非空数组 | 0 / 100 (0%) | 50 / 100 (50%) | +50 |
| `orcid_external_ids_json` 总元素数 | 0 | 150 | +150 |
| `orcid_affiliations_json` 非空数组 | 0 / 100 (0%) | 0 / 100 (0%) | 0 |
| `validate.js` profile 覆盖率（旧口径） | 100.0% | 100.0% | 0 |
| `validate.js` useful-derived 覆盖率（新口径） | 0.0% | 67.2% | +67.2pp |

外推到 13,820 行 partial run（基于 100 行合成 fixture 比例）：

| 指标 | 修复前 | 修复后预期 |
| --- | ---: | ---: |
| `orcid_credit_name` 非空 | 0 (0%) | ~13,129 (~95%) |
| `orcid_external_ids_json` 非空数组 | 0 (0%) | ~6,910 (~50%) |
| `orcid_affiliations_json` 非空数组 | 0 (0%) | 0 (0%) — 已知（/person 不返回 employments/educations） |

## 单测增量

```
原 232 / 232 → 现 246 / 246
+14 new tests:
  unwrapField: 裸字符串
  unwrapField: {value: "..."} 嵌套对象
  unwrapField: 边界 — null / undefined / 数字 / 空对象 / 未知 shape
  extractCreditName: 真实 v3 /person shape（裸字符串 given/family）
  extractCreditName: 真实 v3 /person shape（裸 credit-name）
  extractCreditName: 混合形态
  extractExternalIds: 真实 v3 /person shape（裸字符串 type/value/url/relationship）
  extractExternalIds: 缺 type/value 的行被过滤（裸字符串形态）
  extractExternalIds: 单条 external-identifier（非数组）兼容
  processAuthor: 真实 v3 /person shape — 端到端
  reextractFromPersonJson: 真实 v3 /person shape — 解析出非零派生列
  reextractFromPersonJson: 无 external-identifier
  reextractFromPersonJson: 空字符串 / null / 非法 JSON
  reextractFromPersonJson: 对比修复前/后 capture 行为
```

## 复现命令

```bash
# 单测
node faculty/scripts/tests/run.js

# 修复后行为对比（修复前 vs 修复后）
node -e "const {extractExternalIds, extractCreditName} = require('./faculty/scripts/lib/orcid_enrich.js');
  const p = {name: {'given-names': 'Wang', 'family-name': 'Xiaoming'},
             'external-identifiers': {'external-identifier': [
               {'external-id-type': 'Scopus Author ID', 'external-id-value': '57196466208'}]}};
  console.log('credit_name:', extractCreditName(p));
  console.log('external_ids:', JSON.stringify(extractExternalIds(p)));
"

# 真实 DB 重提取（13,820 行）
node faculty/scripts/orcid_enrich.js --re-extract --out /path/to/data

# 跑 validate.js 看新 KPI
node faculty/scripts/validate.js --out /path/to/data
```

## 关联

- 父 issue：[BRA-9.4 (BRA-19)](https://github.com/Jiayang-ee/brain-bankv3/issues/19)
- 本 issue：[BRA-20 (BRA-9.4.A)](https://github.com/Jiayang-ee/brain-bankv3/issues/20)
- 上游：partial run SUMMARY 在 [docs/bra-9.4-orcid-full-run](https://github.com/Jiayang-ee/brain-bankv3/tree/docs/bra-9.4-orcid-full-run/faculty/data/bra94-orcid-full)
