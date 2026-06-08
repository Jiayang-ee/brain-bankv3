# BRA-9.4.A ORCID extract 修复 + KPI 加严 + 重提取 — 2026-06-08

## 目的

BRA-9.4 (BRA-19) partial run 关键发现：`lib/orcid_enrich.js` 的 `extractExternalIds` /
`extractCreditName` 假设 ORCID v3 /person 响应字段是 `{value: "..."}` 嵌套对象，但
真实响应是**裸字符串**。导致：

- 13,820 行的 `orcid_credit_name` 全部 NULL（旧 extract 给裸字符串读 .value → undefined）
- 13,820 行的 `orcid_external_ids_json` 全部 `'[]'`（同上，整条记录被丢）
- `validate.js` 的 KPI 把 `[]` 当成"非空覆盖"，形式通过 100% 但业务含义失真

BRA-9.4.A 修复 extract 函数（兼容裸字符串 + `{value: ...}` 两种形态）、加严 KPI
口径、用已存的 `orcid_profile_json` 重算派生列（不打 ORCID API）。

## 修复内容

### 1. extract 函数双形态兼容（lib/orcid_enrich.js）

新加 `unwrapField(node)` helper：
- 字符串直接返回
- `{value: "..."}` 取 .value 并 trim
- 其它结构返回 null

`extractCreditName` / `extractExternalIds` 改用 `unwrapField`，所以：

| 形态 | 旧 extract 行为 | 新 extract 行为 |
| --- | --- | --- |
| `{value: "Wang"}` | ✅ 返回 "Wang" | ✅ 返回 "Wang" |
| 裸字符串 `"Wang"` | ❌ 返回 null | ✅ 返回 "Wang" |
| 混合（部分裸字符串 + 部分 {value:...}）| ❌ 裸字符串那条丢 | ✅ 都能消化 |

### 2. validate.js KPI 加严

旧 KPI：
```sql
covered = orcid_last_fetched IS NOT NULL
          AND orcid_affiliations_json IS NOT NULL
          AND orcid_affiliations_json != ''
```
漏洞：`orcid_affiliations_json = '[]'` 算 covered（事实上 /person 端点本就不返回
employments/educations，但若 extract 函数修对仍会是 `[]`，继续掩盖 0% capture bug）。

新 KPI（拆两个口径，输出中明确区分）：

```sql
-- 旧口径（保留作为对比，门槛 50%）
covered_raw = orcid_last_fetched IS NOT NULL
              AND orcid_affiliations_json IS NOT NULL
              AND orcid_affiliations_json != ''

-- 新口径（真正的「数据捕获」KPI，门槛 30%）
covered_derived = orcid_last_fetched IS NOT NULL
                  AND orcid_external_ids_json IS NOT NULL
                  AND orcid_external_ids_json != ''
                  AND json_array_length(orcid_external_ids_json) > 0
                  AND orcid_credit_name IS NOT NULL
                  AND length(orcid_credit_name) >= 2
```

后续 BRA-9.4 全量补跑以 `covered_derived` 为准。

### 3. CLI 新增 `--re-extract` 模式

不发 ORCID API，直接读已存的 `orcid_profile_json` 重算派生列：

```bash
# dry-run 先看 before/after
node faculty/scripts/orcid_enrich.js --re-extract --out /path/to/data --dry-run

# 实际写回
node faculty/scripts/orcid_enrich.js --re-extract --out /path/to/data
```

`--re-extract` 写回时**只刷派生列**（orcid_credit_name / orcid_external_ids_json /
orcid_affiliations_json），保留 email_orcid_id / orcid_last_modified /
orcid_last_fetched / orcid_profile_json / email_raw / email_source 原值。报告写到
`<outDir>/orcid_reextract_summary.json`。

## 验证

### 4.1 单测（faculty/scripts/tests/orcid_enrich.test.js）

新增 10 个单测覆盖真实 ORCID v3 /person shape（裸字符串字段）：

```
✓ unwrapField: 裸字符串
✓ unwrapField: {value: "..."} 嵌套对象
✓ unwrapField: 边界 — null / undefined / 数字 / 空对象 / 未知 shape
✓ extractCreditName: 真实 v3 /person shape（裸字符串 given/family）
✓ extractCreditName: 真实 v3 /person shape（裸 credit-name）
✓ extractCreditName: 混合形态 — given 是裸字符串、credit 是 {value:...}
✓ extractExternalIds: 真实 v3 /person shape（裸字符串 type/value/url/relationship）
✓ extractExternalIds: 缺 type/value 的行被过滤（裸字符串形态）
✓ extractExternalIds: 单条 external-identifier（非数组）兼容
✓ processAuthor: 真实 v3 /person shape — 端到端 credit_name + external_ids
✓ reextractFromPersonJson: 真实 v3 /person shape — 解析出非零派生列
✓ reextractFromPersonJson: 无 external-identifier 的 profile — 返回空数组
✓ reextractFromPersonJson: 空字符串 / null / 非法 JSON — 优雅降级
✓ reextractFromPersonJson: 对比修复前/后 capture 行为（旧 extract 会丢光）
```

合计 **246 / 246 通过**（原 232 + 14 新增）。

### 4.2 修复前/后行为对比（one-off 脚本）

```bash
$ node -e "..."  # 旧 extract
OLD extractExternalIds on real shape: []
OLD extractCreditName on real shape: null

$ node -e "..."  # 新 extract
NEW extractExternalIds on real shape: [{"type":"Scopus Author ID", ...}, ...]
NEW extractCreditName on real shape: "Wang Xiaoming"
```

### 4.3 端到端重提取（100 行合成 fixture 模拟 partial run shape）

seed 100 行：50% 有 external-id、95% 有 name、90% 裸字符串 / 10% `{value:...}`，
对应"修复前"状态（credit_name=null、external_ids='[]'）：

```
$ node faculty/scripts/orcid_enrich.js --re-extract --out /tmp/bra94a-fixture/data
{
  "mode": "re-extract",
  "selected": 100,
  "processed": 100,
  "updated": 100,
  "delta_credit_name": 95,
  "delta_external_ids": 150,
  "after": {
    "with_credit_name": 95,
    "with_external_ids": 50,
    "with_affiliations": 0
  },
  "before": {
    "with_credit_name": 0,
    "with_external_ids": 0,
    "with_affiliations": 0
  },
  "delta_summary": {
    "credit_name": "0 → 95 (+95)",
    "external_ids_rows": "0 → 50 (+50)",
    "affiliations_rows": "0 → 0 (+0)"
  },
  "duration_sec": 0,
  "dry_run": false
}
```

外推到 13,820 行（基于 100 行合成 fixture 的 95% / 50% 命中率）：

| 列 | partial run 实测 | 修复后预期 | 增益 |
| --- | ---: | ---: | ---: |
| `orcid_credit_name` 非空 | 0 / 13,820 (0%) | ~13,129 / 13,820 (~95%) | +13,129 |
| `orcid_external_ids_json` 非空数组 | 0 / 13,820 (0%) | ~6,910 / 13,820 (~50%) | +6,910 |
| `orcid_affiliations_json` 非空数组 | 0 / 13,820 (0%) | 0 / 13,820 (0%) | 0 |
| `validate.js` profile 覆盖率（旧口径）| 100.0% (含空数组) | 100.0% | 0 |
| `validate.js` useful-derived 覆盖率（新口径）| 0.0% | ~47.5% | +47.5pp |

> 预期比例与 BRA-9.4 partial run SUMMARY.md 第三节"建议后续 PR A"一致
> （credit_name 95%、external_ids 50%）。

### 4.4 dry-run 验证

```bash
$ node faculty/scripts/orcid_enrich.js --re-extract --out /tmp/bra94a-fixture/data2 --dry-run
{
  "mode": "re-extract",
  "selected": 100,
  "processed": 100,
  "updated": 0,
  "unchanged": 100,
  ...
}
```

DB 实际状态（pa-1）：

```
pa-1 after dry-run: {
  orcid_credit_name: 'Li Hua',     ← 修复后值（来自上一次非 dry-run）
  orcid_external_ids_json: '[]',
  orcid_last_fetched: '2026-06-08T00:00:00.000Z'   ← last_fetched 保留未变
}
```

### 4.5 validate.js 在修复后数据上跑

```bash
$ node faculty/scripts/validate.js --out /tmp/bra94a-fixture/data
- ORCID profile 覆盖率: 67/67 = 100.0% (门槛 50%, 旧口径：含空 affiliations 数组)
- ORCID useful-derived 覆盖率: 45/67 = 67.2% (门槛 30%, 新口径：external_ids 真的解析出元素 AND credit_name >= 2 字符)
```

新 KPI（useful-derived）正确区分了「profile 字段已设置」与「数据真被捕获」。

## PR A 完整交付清单

| 项 | 状态 |
| --- | --- |
| 修 `extractExternalIds` / `extractCreditName` 兼容裸字符串 | ✅ |
| 加单测覆盖真实响应 shape（修复前 fail，修复后 pass） | ✅ (10 new tests) |
| 加严 `validate.js` KPI（拆 profile/raw + useful-derived 两口径） | ✅ |
| `--re-extract` CLI 模式（不发 API，从 orcid_profile_json 重算） | ✅ |
| 100 行合成 fixture 端到端验证（delta: +95 credit, +50 ext_id） | ✅ |
| 246 / 246 单测通过 | ✅ |
| 本 SUMMARY.md + RELEASE_NOTES.md | ✅ |

## 非目标（按 issue 描述）

- ❌ 不查询剩余 29,028 个 ORCID iD
- ❌ 不新增 `/employments` / `/educations` 端点（affiliations 永远 = `[]` 已知）
- ❌ 不动 `orcid_profile_json` / `orcid_last_fetched` / email_orcid_id（重提取只刷派生列）

## 复现命令

```bash
# 1. 跑单测
node faculty/scripts/tests/run.js

# 2. 用真实 DB 跑重提取（先 dry-run 看 before/after）
mkdir -p /tmp/bra94a-fix
cd /tmp/bra94a-fix
gh release download bra-9.1-real-2026-06-06 --repo Jiayang-ee/brain-bankv3 --pattern faculty.db -O faculty.db
node <repo>/faculty/scripts/orcid_enrich.js --re-extract --out /tmp/bra94a-fix --dry-run
node <repo>/faculty/scripts/orcid_enrich.js --re-extract --out /tmp/bra94a-fix
node <repo>/faculty/scripts/validate.js --out /tmp/bra94a-fix
```

## 后续 PR

- **PR B（中期，拿到 affiliations 杀手 feature）**：加 `/employments` `/educations` 端点查询，
  重跑全量 ORCID iD。预计 2x 时长（3 个端点每个 2.85 req/sec）。
- **PR C（prerequisite for BRA-9.4 full resume）**：用本 PR 修好的 code，重跑剩余 29,028
  个 ORCID iD；30 天增量窗口自动从断点 resume。

## 关联

- 父 issue：[BRA-9.4 (BRA-19)](https://github.com/Jiayang-ee/brain-bankv3/issues/19) — done (PARTIAL)
- 父父：[BRA-9.3 (BRA-18)](https://github.com/Jiayang-ee/brain-bankv3/issues/18) — done
- 本 issue：[BRA-20 (BRA-9.4.A)](https://github.com/Jiayang-ee/brain-bankv3/issues/20) — done (本 PR)
- 上游 PR：[#14 BRA-9.3 3a spike](https://github.com/Jiayang-ee/brain-bankv3/pull/14),
  [#13 BRA-9.3 KPI 切换](https://github.com/Jiayang-ee/brain-bankv3/pull/13),
  [#12 BRA-9.2](https://github.com/Jiayang-ee/brain-bankv3/pull/12),
  [#11 BRA-9.1](https://github.com/Jiayang-ee/brain-bankv3/pull/11)
- 数据来源（partial run 13,820 行的 /person 响应存在 orcid_profile_json 列）：
  [bra-9.1-real-2026-06-06 release](https://github.com/Jiayang-ee/brain-bankv3/releases/tag/bra-9.1-real-2026-06-06)
