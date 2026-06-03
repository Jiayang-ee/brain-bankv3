// extract.js — 从个人主页 HTML 中抽取姓名 / 职位 / 邮箱。
//
// 启发式优先，避免对每个学校写定制 selector。返回结构化字段供 chinese.js 二次分析。

'use strict';

const { URL } = require('node:url');

function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// 抽取 <meta name="..."> / <meta property="..."> / <title> / <h1>
function readMeta(html) {
  const out = { __title: null, __h1: null };
  const metaRe = /<meta\s+[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*?>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    out[m[1].toLowerCase()] = decodeEntities(m[2]);
  }
  // 反向顺序（避免 content 在前）
  const metaRe2 = /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:name|property)=["']([^"']+)["'][^>]*?>/gi;
  while ((m = metaRe2.exec(html)) !== null) {
    const k = m[2].toLowerCase();
    if (!out[k]) out[k] = decodeEntities(m[1]);
  }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1];
  out.__title = title ? stripTags(title) : null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  out.__h1 = h1 ? stripTags(h1[1]) : null;
  return out;
}

const TITLE_KEYWORDS = [
  'Professor', 'Associate Professor', 'Assistant Professor', 'Full Professor',
  'Tenure-Track', 'Tenure Track', 'Lecturer', 'Senior Lecturer',
  'Research Scientist', 'Research Associate', 'Research Fellow',
  'Postdoctoral', 'Postdoc', 'PhD Student', 'Ph.D. Student', 'PhD Candidate', 'Doctoral Candidate',
  'Adjunct', 'Emeritus', 'Visiting', 'Chair Professor', 'Distinguished Professor',
  'Instructor', 'Dean', 'Director', 'Chair',
];

// 按长度降序：长 title 优先匹配（避免 'Professor' 先于 'Assistant Professor' 命中）
const TITLE_KEYWORDS_SORTED = [...TITLE_KEYWORDS].sort((a, b) => b.length - a.length);

function findTitle(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  for (const k of TITLE_KEYWORDS_SORTED) {
    const re = new RegExp(`\\b${k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(t)) return k;
  }
  return null;
}

function findEmails(text) {
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  return [...new Set((text.match(re) || []).map((s) => s.toLowerCase()))];
}

function findCjkNames(text) {
  // 抓取 2-4 个连续汉字片段；为了覆盖像 "王晓明" 这种被前后其它 CJK 字符夹住的名字，
  // 先识别所有连续 CJK run，再对每个 run 切出 2-4 字窗口
  const out = new Set();
  const runRe = /[\u4e00-\u9fff]+/g;
  let m;
  while ((m = runRe.exec(text)) !== null) {
    const run = m[0];
    for (let len = 2; len <= Math.min(4, run.length); len += 1) {
      for (let start = 0; start + len <= run.length; start += 1) {
        out.add(run.slice(start, start + len));
      }
    }
  }
  return [...out];
}

// 提取页面中可能的人名（出现在 profile 区域的姓名）
function extractNameCandidate(meta) {
  const cands = [];
  for (const k of ['author', 'profile:first_name', 'og:title', 'twitter:title']) {
    if (meta[k]) cands.push({ source: k, value: stripTags(meta[k]) });
  }
  if (meta.__h1) cands.push({ source: 'h1', value: meta.__h1 });
  if (meta.__title) cands.push({ source: 'title', value: meta.__title });
  return cands;
}

// BRA-15 (v2.2)：姓名兜底。
//  - 不少学校（MIT IDSS 等）的个人主页是 WordPress 渲染，404 模板会返回 HTTP 200 但
//    h1 / og:title / meta author 都缺失，title 直接就是 "Not Found" 或
//    "Page Not Found – IDSS"。原 fallback 在 split 后会把 "Not Found" 当姓名落库。
//  - 解决办法：把 "Not Found" / "404" / "Page Not Found" 这类模板词显式识别为
//    "无姓名"，再退到 URL slug 解析（如 .../people/victor-chernozhukov/ → "Victor Chernozhukov"）。
const NOT_FOUND_NAME_PATTERNS = [
  /^\s*not[\s_\-]*found\s*$/i,
  /^\s*page[\s_\-]*not[\s_\-]*found\s*$/i,
  /^\s*404\s*$/i,
  /^\s*error[\s_\-]*404\s*$/i,
  /^\s*error\s*$/i,
  /^\s*missing\s*$/i,
  /^\s*unknown\s*$/i,
  /^\s*oops[\s_]*!?\s*$/i,
  /^\s*sorry[\s,_]?.*not[\s_\-]*found\s*$/i,
];

function isNotFoundName(name) {
  if (name === null || name === undefined) return true;
  const s = String(name).trim();
  if (!s) return true;
  return NOT_FOUND_NAME_PATTERNS.some((re) => re.test(s));
}

// 把 "Victor Chernozhukov – IDSS" 之类的 title 切成第一段；如果切完是 "Not Found" 等
// 模板词，返回 null（告诉调用方 title 不靠谱）。
function parseNameFromTitle(title) {
  if (title === null || title === undefined) return null;
  // 标题里可能有 HTML 实体（如 &amp; / &#8211; / &quot;），先解一下再切
  let v = decodeEntities(String(title));
  v = v.replace(/\s+/g, ' ').trim();
  if (!v) return null;
  // 去掉 "|" 之后的内容（院系/学校/页面类型后缀）
  v = v.replace(/\s*[|·•–—\-]\s+.*$/, '').trim();
  v = v.replace(/\s*,\s+PhD$/i, '').trim();
  v = v.replace(/\s*,\s+.*Professor.*$/i, '').trim();
  if (isNotFoundName(v)) return null;
  // 太短的不太像姓名（保留 2 字符以上；常见如 "Li" "Wu"）
  if (v.length < 2) return null;
  return v;
}

// 兜底：从 URL 最后一段 slug 推断姓名（"victor-chernozhukov" → "Victor Chernozhukov"）。
// 仅在 URL 看上去是个人页（含 person/people/faculty/member/staff/researcher 等 token）
// 时启用，避免把列表页 slug 误当成姓名。
const PROFILE_SLUG_TOKENS = [
  '/people/', '/person/', '/profile/', '/profiles/',
  '/faculty/', '/staff/', '/users/', '/member/',
  '/team/', '/researcher/', '/scholar/',
  '/our-people/', '/our-team/',
];

function nameFromUrlSlug(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  const lcPath = u.pathname.toLowerCase();
  // 个人页 slug 才解析；纯列表页 / 研究组页面的 slug 不是人名
  if (!PROFILE_SLUG_TOKENS.some((t) => lcPath.includes(t))) return null;
  const lastSegment = u.pathname.split('/').filter(Boolean).pop();
  if (!lastSegment) return null;
  // 去掉常见扩展名与 query 残留
  const cleaned = lastSegment
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3) return null;
  // 列表 token 单独出现不算姓名
  if (/^(people|faculty|staff|directory|researchers|team|members|person|profile|index|default|all)$/i.test(cleaned)) {
    return null;
  }
  // 全数字 / 全是单字符不处理
  if (/^[\d.\- ]+$/.test(cleaned)) return null;
  // 标题化（首字母大写，保留其它字符）
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

// 综合姓名抽取：按 h1 > og:title > meta author > title(smart) > url slug 顺序，
// 任何一层命中即返回；只要检测到 NOT_FOUND 模板词就跳过该层。
// 返回 { value, source }，未命中时 source=null。
function pickBestName({ meta, url }) {
  const tryOne = (value, source) => {
    if (isNotFoundName(value)) return null;
    return { value: String(value).trim(), source };
  };
  const fromH1 = meta.__h1 ? tryOne(meta.__h1, 'h1') : null;
  if (fromH1) return fromH1;
  const ogTitle = meta['og:title'];
  if (ogTitle) {
    const t = tryOne(stripTags(ogTitle), 'og:title');
    if (t) return t;
  }
  const author = meta.author;
  if (author) {
    const t = tryOne(stripTags(author), 'author');
    if (t) return t;
  }
  // 智能 title：先清洗，再判断是不是 NOT_FOUND
  const fromTitle = parseNameFromTitle(meta.__title);
  if (fromTitle) return { value: fromTitle, source: 'title_cleaned' };
  // 最后一档：URL slug
  const fromSlug = nameFromUrlSlug(url);
  if (fromSlug) return { value: fromSlug, source: 'url_slug' };
  return { value: null, source: null };
}

function extractPersonalInfo({ html, url }) {
  const meta = readMeta(html);
  const fullText = stripTags(html);
  // 职位关键词可同时出现在 description meta 中，把 meta 内容并入用于搜索
  const metaText = [meta.description, meta['og:description'], meta.author].filter(Boolean).join(' ');
  const searchText = `${fullText} ${metaText}`;
  const emails = findEmails(fullText);
  const cjk = findCjkNames(fullText);
  const title = findTitle(searchText);
  const names = extractNameCandidate(meta);

  // 标题清洗：去掉 "| 院系名" 之类后缀
  const cleaned = names.map((n) => {
    let v = n.value;
    v = v.replace(/\s*[|·•–—\-]\s+.*$/, '').trim(); // 去掉 "|" 之后的内容
    v = v.replace(/\s*,\s+PhD$/i, '').trim();
    v = v.replace(/\s*,\s+.*Professor.*$/i, '').trim();
    return { ...n, value: v };
  });

  return {
    url,
    title: meta.__title || null,
    h1: meta.__h1 || null,
    meta: {
      author: meta.author || null,
      description: meta.description || null,
      ogTitle: meta['og:title'] || null,
    },
    nameCandidates: cleaned,
    titleKeyword: title,
    emails,
    cjkFragments: cjk,
  };
}

module.exports = {
  extractPersonalInfo,
  readMeta,
  stripTags,
  findEmails,
  findCjkNames,
  findTitle,
  // BRA-15 姓名兜底
  isNotFoundName,
  parseNameFromTitle,
  nameFromUrlSlug,
  pickBestName,
  NOT_FOUND_NAME_PATTERNS,
  PROFILE_SLUG_TOKENS,
};
