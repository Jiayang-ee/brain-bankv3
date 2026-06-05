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

module.exports = { extractPersonalInfo, readMeta, stripTags, findEmails, findCjkNames, findTitle };
