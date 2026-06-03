# 人才库 (brain-bankv3)

建设管理科学与工程相关华人人才采集 MVP 数据资产。

## 目录
- `qs50/` — QS 世界大学综合排名前 50 学校名单 + 相关院系入口库
  - `data/qs50_schools.json` / `.csv` — Top 50 学校清单
  - `data/qs50_departments.json` / `.csv` — 院系入口表 (v2.0, 100 条)
  - `schema/schema.md` — 字段定义、枚举
  - `scripts/validate.js` — 数据校验脚本

## 数据来源
- 榜单：QS World University Rankings 2026 (2025-06-19 发布)
- 源 URL: https://www.topuniversities.com/university-rankings/world-university-rankings/2026
- 采集日期：2026-06-03
- 维护责任人：multica 后端开发工程师 (issue: BRA-6)

## 维护约定
- 榜单年度更新时同步升级 `qs50/data/qs50_schools.json` 的 `meta.version` 与 `meta.ranking_edition`
- 院系入口表的首跑校验由爬虫完成；状态字段在 PR 中回写
- 详情见 `qs50/README.md`
