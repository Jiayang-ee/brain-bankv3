# BRA-7.2 全量抓取数据快照 (2026-06-03)

本目录是 [BRA-7.2 全量真实抓取（--all）](https://...placeholder.../issues/13) issue 的数据快照。

## 抓取参数

- 命令：`node faculty/scripts/discover.js --all --out ./faculty/data`
- 时间：2026-06-03 17:17 → 19:38 UTC（2:20:43）
- 退出码：2（31 个 active 入口无 list page → 真 failure）
- validate.js：`VALIDATION OK`（50/50 覆盖）

## 文件清单

| 文件 | 大小 | 说明 |
|---|---:|---|
| `faculty.db` | 1.77 MB | SQLite：candidates (1275) / crawl_log (3892) / department_summary (105, 50 校) |
| `candidates.jsonl` | 1.04 MB | 1292 行 JSON 镜像 |
| `crawl_log.jsonl` | 1.16 MB | 3892 行 JSON 镜像 |
| `html/qs-{01..50}-*/` | 191 MB | 1292 份真实 HTML（按学校 / 部门归档） |

## 数量摘要

- 50/50 学校 `department_summary` 覆盖
- candidates: 1275 (DB) / 1292 (JSONL)
- `chinese_likely` (probability ≥ 0.4): **103 行**
- `crawl_log` 状态分布: success 1531 / http_error 1502 / cross_host_redirect 330 / dns_error 312 / connection_refused 78 / error 78 / timeout 57 / connection_reset 2 / skipped 2
- `last_run_status`: ok 45 / no_faculty_page 31 / no_profiles 27 / skipped 2

## 已知遗留

31 个 `no_faculty_page` + 27 个 `no_profiles` + 双斜杠 URL + tsinghua-dmei DNS + WP `name_raw='Not Found'` 全部记录在 [BRA-7.2 报告](https://...placeholder.../issues/13)，由 [BRA-15](BRA-15) 后续复盘和 [BRA-7.3 runbook](BRA-14) 增量修。

## 复现

```bash
# 重新跑同命令
node faculty/scripts/discover.js --all --out ./faculty/data

# 校验
node faculty/scripts/validate.js
```

## 关联 issue

- [BRA-7.2 全量真实抓取](https://...placeholder.../issues/13) - 本 issue
- [BRA-8 教师照片下载](BRA-8) - 消费方
- [BRA-9 期刊论文 API + 华人高召回](BRA-9) - 消费方
- [BRA-10 本地网页查看器](BRA-10) - 消费方
- [BRA-14 BRA-7.3 runbook 化](BRA-14) - 消费 crawl_log.status 真实分布
