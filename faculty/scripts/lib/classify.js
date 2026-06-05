// classify.js — 教师列表页识别。
//
// 思路：
//   1. URL 启发式：列表页 URL 通常包含 people/faculty/staff/directory/researchers/team/people-list 等
//   2. HTML 启发式：页内含 ≥ N 个 profile 链接，且与 entry URL 同 host 且同子树
//   3. 综合打分；>= 阈值视为 list_page
//
// 注：本模块不发起网络请求，只评估 URL 与已抓取的 HTML。

'use strict';

const { URL } = require('node:url');

// 列表页 URL 关键词（按子串匹配，忽略大小写）
const LIST_URL_TOKENS = [
  '/faculty',
  '/people',
  '/staff',
  '/directory',
  '/researchers',
  '/phd-students',
  '/phd_students',
  '/postdocs',
  '/postdoc',
  '/team',
  '/members',
  '/academic-staff',
  '/academic_staff',
  '/our-people',
  '/our-team',
  '/profiles',
  '/person',
  'faculty-list',
  'people-list',
];

// 列表页 HTML 关键词（出现在 title/h1/h2/strong/em 内）
const LIST_HTML_TOKENS = [
  'faculty', 'people', 'staff', 'directory', 'researchers',
  'phd students', 'postdocs', 'our team', 'our people', 'academic staff',
  'faculty members', 'people directory',
];

// 个人主页 URL 启发式（用于从列表页提取链接）
const PROFILE_URL_TOKENS = [
  '/people/', '/person/', '/profile/', '/faculty/',
  '/team/', '/staff/', '/users/', '/member/',
  '/researcher/', '/scholar/',
];

// 给定入口 URL，列出可能命中教师列表的候选 URL（同 host）
function listUrlCandidates(entryUrl) {
  let url;
  try {
    url = new URL(entryUrl);
  } catch (err) {
    return [];
  }
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const candidates = new Set();
  // 1. 入口 URL 本身（很多时候本身就是 list）
  candidates.add(entryUrl);
  // 2. 拼到当前 path 末尾的常见后缀
  const suffixList = [
    '/people', '/people/faculty', '/faculty', '/faculty-and-staff',
    '/staff', '/staff-directory', '/directory', '/team',
    '/research/people', '/our-people', '/our-team', '/our-faculty',
    '/about/people', '/about-us/people', '/people-list', '/phd-students',
    '/postdocs', '/members', '/academic-staff',
  ];
  for (const s of suffixList) {
    candidates.add(`${origin}${path}${s}`);
  }
  // 3. 入口的父目录 + 列表名
  const parent = path.split('/').slice(0, -1).join('/') || '';
  for (const s of suffixList) {
    candidates.add(`${origin}${parent}${s}`);
  }
  // 4. 入口去掉尾段后的 root + 列表名
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const head = '/' + segments.slice(0, i).join('/');
    const headFixed = head === '/' ? '' : head;
    for (const s of suffixList) {
      candidates.add(`${origin}${headFixed}${s}`);
    }
  }
  return [...candidates];
}

function urlHasListToken(rawUrl) {
  const lc = String(rawUrl).toLowerCase();
  return LIST_URL_TOKENS.some((t) => lc.includes(t));
}

// 从 HTML 提取内链（仅 a 标签的 href，去重 + 同 host）
function extractInternalLinks(html, entryUrl) {
  let base;
  try {
    base = new URL(entryUrl);
  } catch (err) {
    return [];
  }
  const out = new Set();
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('#')) continue;
    let abs;
    try {
      abs = new URL(raw, entryUrl).toString();
    } catch (err) {
      continue;
    }
    let absUrl;
    try {
      absUrl = new URL(abs);
    } catch (err) {
      continue;
    }
    if (absUrl.host !== base.host) continue;
    if (!/^https?:$/.test(absUrl.protocol)) continue;
    out.add(abs);
  }
  return [...out];
}

// 给定 HTML，评估它作为教师列表页的分数 [0..1]
function scoreListPage({ html, entryUrl, profileLinkCount }) {
  let score = 0;
  const reasons = [];
  if (urlHasListToken(entryUrl)) {
    score += 0.35;
    reasons.push('url_has_list_token');
  }
  const lc = html.toLowerCase();
  // title / h1
  const titleMatch = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  const h1Matches = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
  const headText = (titleMatch + ' ' + h1Matches.join(' ')).toLowerCase();
  if (LIST_HTML_TOKENS.some((t) => headText.includes(t))) {
    score += 0.2;
    reasons.push('head_has_list_token');
  }
  // 内部链接数
  const internalLinks = extractInternalLinks(html, entryUrl);
  if (internalLinks.length >= 5) {
    score += 0.1;
    reasons.push(`internal_links>=5(${internalLinks.length})`);
  }
  if (profileLinkCount !== undefined && profileLinkCount >= 3) {
    score += 0.3;
    reasons.push(`profile_links>=3(${profileLinkCount})`);
  } else if (profileLinkCount !== undefined && profileLinkCount >= 1) {
    score += 0.1;
    reasons.push(`profile_links>=1(${profileLinkCount})`);
  }
  // 列表视觉：grid/list 容器
  if (/<(ul|ol|div|section)[^>]*class=["'][^"']*(grid|list|directory|people|faculty|card)/i.test(html)) {
    score += 0.05;
    reasons.push('list_layout_class');
  }
  if (score > 1) score = 1;
  return { score, reasons, internalLinks };
}

// 从 list 候选链接中筛出个人主页
function extractProfileLinks(listHtml, listUrl) {
  const links = extractInternalLinks(listHtml, listUrl);
  // 同时考虑 URL token + 列表视觉上下文
  return links.filter((u) => {
    const lc = u.toLowerCase();
    if (PROFILE_URL_TOKENS.some((t) => lc.includes(t))) return true;
    // 链接文本里包含职称/姓名且链接本身是相对短路径
    return false;
  });
}

function isProfileUrl(u) {
  const lc = String(u).toLowerCase();
  return PROFILE_URL_TOKENS.some((t) => lc.includes(t));
}

module.exports = {
  listUrlCandidates,
  urlHasListToken,
  extractInternalLinks,
  scoreListPage,
  extractProfileLinks,
  isProfileUrl,
  LIST_URL_TOKENS,
  PROFILE_URL_TOKENS,
  LIST_HTML_TOKENS,
};
