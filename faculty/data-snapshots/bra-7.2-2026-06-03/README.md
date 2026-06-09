# BRA-7.2 全量抓取数据快照 (2026-06-03)

本目录是 BRA-7.2（`--all` 全量真实抓取）issue 的数据快照，issue 与下游消费的完整讨论见 Multica issue tracker。

## 抓取参数

- 命令：`node faculty/scripts/discover.js --all --out ./faculty/data`
- 时间：2026-06-03 17:17 → 19:38 UTC（2:20:43）
- 退出码：2（31 个 active 入口无 list page → 真 failure）
- validate.js：`VALIDATION OK`（50/50 覆盖）

## 文件清单

### inline（直接 commit 在仓库里，~3.3 MB）

| 文件 | 大小 | 说明 |
|---|---:|---|
| `faculty.db` | 1.77 MB | SQLite：candidates (1275) / crawl_log (3892) / department_summary (105, 50 校) |
| `candidates.jsonl` | 1.04 MB | 1292 行 JSON 镜像 |
| `crawl_log.jsonl` | 1.16 MB | 3892 行 JSON 镜像 |
| `snapshot.manifest.json` | 303 KB | 1292 份 HTML 的相对路径 + sha256 + 大小，含 release asset 元信息 |
| `build-manifest.mjs` | 2.8 KB | 复现 manifest 的脚本（读 `html/` 重算 sha256） |

### 外部（不在仓库内，走 GitHub Release）

| 资源 | 大小 | 链接 |
|---|---:|---|
| HTML tarball (`*.tar.gz`) | 34.5 MB（解压 191 MB） | [v0.1.0-faculty-snap-2026-06-03](https://github.com/Jiayang-ee/brain-bankv3/releases/tag/v0.1.0-faculty-snap-2026-06-03) |

为什么不把 HTML 直接 commit：1292 份原始 HTML 191 MB 会让 PR / clone 都很慢；改走 GitHub Release 后，git 部分只剩 ~3.3 MB，且 HTML 仍可被 git tag 锁定到 commit（`manifest.json` 的 `release_tag` 字段）。

## 如何消费本快照（完整复现）

```bash
# 1. 取 inline 产物（PR #6 合并后随 main checkout 即可）
ls faculty/data-snapshots/bra-7.2-2026-06-03/
#   faculty.db  candidates.jsonl  crawl_log.jsonl  snapshot.manifest.json
#   README.md  build-manifest.mjs

# 2. 拉 HTML tarball
curl -L -O https://github.com/Jiayang-ee/brain-bankv3/releases/download/v0.1.0-faculty-snap-2026-06-03/faculty-data-snapshot-2026-06-03-html.tar.gz

# 3. 校验 tarball
shasum -a 256 faculty-data-snapshot-2026-06-03-html.tar.gz
#   应等于 snapshot.manifest.json 的 html_archive.sha256

# 4. 解压到 snapshot 目录
tar -xzf faculty-data-snapshot-2026-06-03-html.tar.gz -C faculty/data-snapshots/bra-7.2-2026-06-03/

# 5. 校验解压后的 1292 份 HTML（用 manifest）
node -e "
import('node:crypto').then(async ({createHash}) => {
  const fs = await import('node:fs/promises');
  const m = JSON.parse(await fs.readFile('faculty/data-snapshots/bra-7.2-2026-06-03/snapshot.manifest.json', 'utf8'));
  let bad = 0;
  for (const f of m.html_archive.files) {
    const buf = await fs.readFile('faculty/data-snapshots/bra-7.2-2026-06-03/' + f.path);
    const h = createHash('sha256').update(buf).digest('hex');
    if (h !== f.sha256) { console.log('MISMATCH', f.path); bad++; }
  }
  console.log('checked', m.html_archive.files.length, 'files,', bad, 'mismatches');
});
"
```

只读 SQL / JSONL 不想拉 HTML 的下游，可以直接用 `faculty.db` / `candidates.jsonl` / `crawl_log.jsonl`，不需要走 release。

## 数量摘要

- 50/50 学校 `department_summary` 覆盖
- candidates: 1275 (DB) / 1292 (JSONL)
- `chinese_likely` (probability ≥ 0.4): **103 行**
- `crawl_log` 状态分布: success 1531 / http_error 1502 / cross_host_redirect 330 / dns_error 312 / connection_refused 78 / error 78 / timeout 57 / connection_reset 2 / skipped 2
- `last_run_status`: ok 45 / no_faculty_page 31 / no_profiles 27 / skipped 2

## 已知遗留

31 个 `no_faculty_page` + 27 个 `no_profiles` + 双斜杠 URL + tsinghua-dmei DNS + WP `name_raw='Not Found'` 全部记录在 BRA-7.2 报告 comment，由 BRA-15 后续复盘和 BRA-7.3 runbook（BRA-14）增量修。

## 复现

```bash
# 重新跑同命令（要 2.5h+ 与联网环境）
node faculty/scripts/discover.js --all --out ./faculty/data

# 校验
node faculty/scripts/validate.js
```

## 关联 issue / PR

- **BRA-7.2** 全量真实抓取 — 本 issue（Multica tracker）
- [PR #6 数据快照](https://github.com/Jiayang-ee/brain-bankv3/pull/6) — 本目录所在 PR（GitHub）
- **BRA-8** 教师照片下载 — 消费方
- **BRA-9** 期刊论文 API + 华人高召回 — 消费方
- **BRA-10** 本地网页查看器 — 消费方
- **BRA-14** BRA-7.3 runbook 化 — 消费 crawl_log.status 真实分布
