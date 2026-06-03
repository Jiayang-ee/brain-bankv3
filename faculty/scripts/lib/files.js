// files.js — 本地 HTML 归档与命名。
//
// 目录布局（相对 faculty/data/）：
//   html/<school-slug>/<dept-id>/list/<index>.html
//   html/<school-slug>/<dept-id>/people/<slug>/index.html
//
// school-slug 由 school_rank 派生：qs-<rank-padded>-<slugified-name>
// department-id 直接复用 qs50_departments.json。
// people slug 由 sha1(source_url) 前 12 位生成，避免不同学校/同名教师冲突。

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function schoolSlug(rank, name) {
  return `qs-${String(rank).padStart(2, '0')}-${slugify(name)}`;
}

function urlHash(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
}

function htmlRelPath({ schoolRank, schoolName, departmentId, kind, sourceUrl, indexHint }) {
  const school = schoolSlug(schoolRank, schoolName);
  if (kind === 'list_page') {
    const idx = Number.isInteger(indexHint) ? String(indexHint).padStart(2, '0') : '00';
    return path.posix.join('html', school, departmentId, 'list', `${idx}.html`);
  }
  if (kind === 'personal_page') {
    return path.posix.join('html', school, departmentId, 'people', urlHash(sourceUrl), 'index.html');
  }
  throw new Error(`unknown file kind: ${kind}`);
}

function ensureDir(fs, absDir) {
  fs.mkdirSync(absDir, { recursive: true });
}

function writeArchive({ fs, dataDir, schoolRank, schoolName, departmentId, kind, sourceUrl, body, indexHint }) {
  const rel = htmlRelPath({ schoolRank, schoolName, departmentId, kind, sourceUrl, indexHint });
  const abs = path.join(dataDir, rel);
  ensureDir(fs, path.dirname(abs));
  fs.writeFileSync(abs, body);
  return { relPath: rel, absPath: abs };
}

function relToPosix(p) {
  return p.split(path.sep).join('/');
}

module.exports = { slugify, schoolSlug, urlHash, htmlRelPath, writeArchive, relToPosix };
