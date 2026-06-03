# Schema 定义 (v2.1)

## qs50_schools.json

顶层结构：

```jsonc
{
  "meta":   { /* Metadata，见下 */ },
  "schools": [ /* SchoolEntry[]，长度 50 */ ]
}
```

### `meta` 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | string (semver) | ✅ | 数据文件版本 |
| `ranking_edition` | string | ✅ | 榜单版本号，如 `"QS World University Rankings 2026"` |
| `ranking_release_date` | string (date) | ✅ | 榜单发布日期，ISO `YYYY-MM-DD` |
| `source_url` | string (URL) | ✅ | 榜单发布 URL |
| `source_publisher` | string | ✅ | 数据发布方 |
| `collection_date` | string (date) | ✅ | 本快照采集日期，ISO `YYYY-MM-DD` |
| `collector` | string | ✅ | 采集者（agent id + 角色） |
| `schema_version` | string | ✅ | schema 文件版本 |
| `notes` | string | ❌ | 备注 |

### `schools[]` 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `rank` | integer (1..50) | ✅ | 唯一，1-50 |
| `name_en` | string | ✅ | 英文/罗马字母校名 |
| `name_local` | string \| null | ❌ | 本地语校名（中日韩等可填写） |
| `country` | string | ✅ | 国家/地区（人类可读） |
| `country_code` | string (ISO 3166-1 alpha-2 / HK / SG) | ✅ | 国家/地区代码 |
| `city` | string | ✅ | 主校区城市 |

## qs50_departments.json

顶层结构：

```jsonc
{
  "meta":    { /* Metadata + status_legend + category_legend */ },
  "entries": [ /* DepartmentEntry[]，长度 >= 50 */ ]
}
```

### `meta` 字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | string (semver) | ✅ | 数据文件版本 |
| `ranking_edition` | string | ✅ | 与 schools 文件保持一致 |
| `source_url` | string (URL) | ✅ | 榜单来源 URL |
| `collection_date` | string (date) | ✅ | 本快照采集日期 |
| `collector` | string | ✅ | 采集者 |
| `schema_version` | string | ✅ | schema 文件版本 |
| `status_legend` | object | ✅ | 各 `status` 含义说明 |
| `category_legend` | object | ✅ | 各 `category` 含义说明 |
| `notes` | string | ❌ | 备注 |

### `entries[]` 字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `school_rank` | integer (1..50) | ✅ | 引用 schools.rank | 所属 QS 排名 |
| `school_name_en` | string | ✅ | 冗余自 schools | 便于脱链消费 |
| `department_id` | string (slug) | ✅ | 与 school_rank 共同唯一 | 形如 `<school-slug>-<dept-slug>`，小写连字符 |
| `department_name_en` | string | ✅ | — | 院系英文/罗马名 |
| `url` | string (URL) | ✅ | http(s):// | 入口 URL（首页 / 院系页 / 教师索引页之一） |
| `category` | enum | ✅ | 见下方枚举 | 院系方向分类 |
| `status` | enum | ✅ | 见下方枚举 | 入口当前状态 |
| `needs_js_hint` | boolean | ✅ | — | 是否需要 headless 渲染 |
| `notes` | string | ❌ | — | 自由备注 |
| `last_validated_at` | string (RFC3339) \| null | ✅ | 爬虫/人工回写 | 最近一次主动校验时间 |
| `validated_by` | string \| null | ✅ | 爬虫/人工回写 | 校验方标识（agent / 人工） |

### `category` 枚举

```
business_school | management_school
| engineering_management | industrial_engineering | systems_engineering
| operations_research | decision_science | information_systems
| business_analytics | public_policy
```

### `status` 枚举

```
valid | requires_js | access_failed | suspected_irrelevant | requires_manual_confirmation
```

## 一致性约束

1. `entries[].school_rank` 必须是 `schools[].rank` 的子集（即必须是 1..50 之一）。
2. `(school_rank, department_id)` 唯一。
3. 同一 `school_rank` 的 `status="valid"` 入口数量建议 1-3 条；过多会被人工 review 标记。
4. `url` 必须以 `http://` 或 `https://` 开头；不允许根相对路径与 `javascript:`。
5. 任何修改 `url` / `department_id` 的操作都必须 bump `meta.version` 并在 PR/评论中说明原因。
6. **（v2.1 起，PR #1 review fix）`category` 必须覆盖下方枚举全部 10 个值**——即 `entries[].category` 的 `Set` 必须包含 `REQUIRED_CATEGORIES = { business_school, management_school, engineering_management, industrial_engineering, systems_engineering, operations_research, decision_science, information_systems, business_analytics, public_policy }`。`validate.js` 在 CI/PR 流程中作为硬约束；新增/删除 category 必须同步更新本文件与 `validate.js`。

## 后续可扩展字段

爬虫层如果需要，建议新增以下字段而非复用 `notes`：

- `http_status` (int) — 最近一次主动校验的 HTTP 状态码
- `etag` / `last_modified` (string) — 缓存指纹
- `crawl_pace_hint` (string) — 例如 `daily` / `weekly`
- `related_urls` (string[]) — 同院系其他入口（如教师索引、子院系）

新增字段必须先更新本 `schema.md` 的版本号再写入数据。
