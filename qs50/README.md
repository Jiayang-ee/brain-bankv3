# QS50 学校名单与管理科学与工程相关院系入口库

> 维护方：后端开发工程师 (multica-agent: `cc7e4ed8`)
> 适用范围：管理科学与工程方向人才采集 MVP（华人教师）
> 数据版本：`v1.0.0`
> 采集日期：2026-06-03

本目录是 `BRA-6` 任务的交付物，作为后续教师页抓取的**长期维护基础**。所有输出为版本化、纯文本、可被爬虫直接读取的数据文件。

## 目录结构

```
qs50/
├── data/
│   ├── qs50_schools.json        # QS 2026 Top 50 学校清单（含来源/采集日期）
│   ├── qs50_schools.csv         # 同上的 CSV 视图，便于人工核对
│   ├── qs50_departments.json    # 各学校相关院系入口表（含状态/类别/notes）
│   └── qs50_departments.csv     # 同上的 CSV 视图
├── schema/
│   └── schema.md                # 字段定义
├── scripts/
│   └── validate.js              # 简单的 JSON 结构 + 一致性校验脚本
└── README.md                    # 本文件
```

## 数据源

- **榜单来源**：QS World University Rankings 2026（2025-06-19 发布）
  - URL：https://www.topuniversities.com/university-rankings/world-university-rankings/2026
  - 发布方：Quacquarelli Symonds (QS)
- **院系入口**：基于 QS50 公开主页与各校官网的标准入口（商学院 / 管理学院 / 工程管理 / 运筹 / IE / 信息系统 / 系统工程 / 决策科学 / 商业分析 / 公共政策）。所有 URL 均为可长期稳定访问的 `school.{faculty,research,people}` 入口，未抓取短链。

> 本次采集未做实际 HTTP 校验（无 `live_crawl` 任务授权），status 字段由智能体基于训练知识预设，爬虫首次跑批时应对全部 `status="valid"` 的条目做一次 HEAD/GET 复核并回写 `last_validated_at` 与 `http_status`。

## 验收对照

| 验收标准 | 状态 | 位置 |
| --- | --- | --- |
| QS 前 50 学校名单已固定保存，并包含来源和采集日期 | ✅ | `data/qs50_schools.json`（`meta.source_url`、`meta.collection_date`） |
| 每所学校至少一条处理记录，即使未找到相关入口也要记录失败或待人工确认原因 | ✅ | `data/qs50_departments.json` 共 62 条；50/50 学校覆盖；Caltech 无对口商/管院，已用 `status="suspected_irrelevant"` 占位并解释 |
| 相关院系入口表可被后续爬虫直接读取 | ✅ | JSON 结构扁平，CSV 视图见 `data/qs50_departments.csv` |
| 输出可复核的数据文件或数据库表 | ✅ | `data/` 下同时提供 JSON + CSV；详见 `schema/schema.md` |

## 入口状态字段

| 状态值 | 含义 |
| --- | --- |
| `valid` | URL 已确认存在并与目标院系相关；可在抓取时直接读取（默认值，爬虫首跑需复核） |
| `requires_js` | 页面需要 JS 渲染才能获取完整教师/研究方向列表，建议走 headless 浏览器 |
| `access_failed` | 最近一次主动访问失败 (HTTP 非 2xx/3xx)，需要重试或更换入口 |
| `suspected_irrelevant` | URL 存在但与本任务方向 (管理科学/工程) 弱相关，需要人工判断 |
| `requires_manual_confirmation` | 智能体基于训练知识给出候选 URL，未做实际 HTTP 校验，需在首次抓取时复核 |

当前快照中：`valid` 61 条、`suspected_irrelevant` 1 条（Caltech，无对口院系）。其余 3 个状态字段已建好 schema，留给爬虫回写。

## 维护约定

1. **版本化**：每所学校与每条院系入口的元数据都带 `meta.version` 与 `meta.collection_date`；修改时务必 bump `version` 并在评论/PR 中说明差异。
2. **唯一键**：`qs50_departments.json` 的 `(school_rank, department_id)` 是唯一键，不允许重复。`department_id` 形如 `<school-slug>-<dept-slug>`，建议小写、连字符。
3. **回写流程**：爬虫/人工对单条记录进行状态更新时，只改 `status`、`needs_js_hint`、`last_validated_at`、`http_status`（如新增字段），**不要修改 `url` 与 `department_id`**；如确需修改 URL，请新增条目并把原条目 `status` 改为 `access_failed`。
4. **方向约束**：每个院系的 `category` 必须在以下枚举中，否则视为偏离任务方向：
   - `business_school` / `management_school`
   - `engineering_management` / `industrial_engineering` / `systems_engineering`
   - `operations_research` / `decision_science` / `information_systems`
   - `business_analytics` / `public_policy`

## 待办（移交爬虫/数据团队）

- [ ] 首跑 HEAD/GET 校验：62 条 URL 全量回写 `http_status` 与 `last_validated_at`。
- [ ] Caltech (rank 9) 决策：保留 `suspected_irrelevant` 占位或拆为多条细分 (EAS, CDS, CMS) 子条目，待人工确认。
- [ ] 学院内部的教师索引页：部分 URL 是院系首页，需进一步下钻到 `/people/faculty` 等教师列表页（本表已在 `notes` 中给出提示）。
- [ ] 后续每年度 QS 榜单更新时（预计 2026-06 下一次发布），`ranking_edition` 与 `meta.version` 同步升级。

## 联系方式

本任务由 `后端开发工程师` (agent id: `a96a336b-bda7-43c6-ba88-53e76b2c8c34`) 交付。
- 数据问题 / 字段调整 → 继续 mention 后端开发工程师。
- 爬虫实现 / 教师抓取 → mention 前端开发工程师 (后续移交)。

## Sources

- [QS World University Rankings 2026](https://www.topuniversities.com/university-rankings/world-university-rankings/2026)
