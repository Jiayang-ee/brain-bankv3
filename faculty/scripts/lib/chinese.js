// chinese.js — 疑似华人姓名初筛（高召回）。
//
// 设计目标：误杀（漏掉真华人）的成本 >> 误报（把非华人标为疑似）的成本。
// 因此规则偏向宽松，输出 score ∈ [0,1] + reasons[]，由人工/下游系统决定阈值。
//
// 信号来源（按权重）：
//   1. CJK 汉字直接出现在姓名中（CJK 命中：强信号）
//   2. 拼音姓名结构：常见华人姓氏命中
//   3. 拼音姓名长度：华人姓名通常 2-4 音节
//   4. 音节组合：华人 given name 通常 1-2 个音节，每个音节首字母大写（"XiaoMing" / "Xiao-Ming" / "Xiao Ming"）
//   5. 反向信号：典型西方 given name（John / David / Michael / ...）作为第一音节 → 降权
//   6. 否定信号：明显的非华人结构（如 "van", "von", "de la", 西班牙/葡语/俄语姓氏后缀）→ 降权
//
// 阈值：默认 score >= 0.4 视为"疑似华人"，但调用方可覆盖。

'use strict';

// 100+ 常见华人姓氏（罗马拼音）。覆盖大陆 / 港澳台 / 新马 / 常见变体拼写。
const COMMON_SURNAMES = new Set([
  'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou',
  'xu', 'sun', 'ma', 'zhu', 'hu', 'lin', 'guo', 'he', 'gao', 'liang',
  'song', 'zheng', 'luo', 'xie', 'tang', 'han', 'feng', 'deng', 'cao', 'peng',
  'zeng', 'xiao', 'tian', 'dong', 'yuan', 'pan', 'yu', 'du', 'ye', 'cheng',
  'su', 'lu', 'jiang', 'cai', 'jia', 'ding', 'wei', 'lv', 'lu', 'shi',
  'yan', 'cui', 'mao', 'qiu', 'hou', 'long', 'wan', 'duan', 'lei', 'shen',
  'lu', 'qian', 'qin', 'dai', 'fANG'.toLowerCase(), 'fang', 'ren', 'yao', 'liao', 'tan',
  'zou', 'bai', 'lan', 'ou', 'jin', 'tao', 'shi', 'an', 'mu', 'ji',
  'nie', 'geng', 'lian', 'sang', 'pu', 'qi', 'sha', 'shawn',
  'chu', 'gan', 'niu', 'pang', 'qiu', 'shan', 'shu', 'teng', 'xin', 'yun',
  'zang', 'zhan', 'ai', 'bao', 'bI'.toLowerCase(), 'bi', 'che', 'chi', 'chu',
  'cong', 'dian', 'die', 'dou', 'e', 'fei', 'fen', 'fu', 'gai', 'geng',
  'gong', 'gu', 'hai', 'hang', 'heng', 'huo', 'ji', 'jia', 'jie', 'jing',
  'ke', 'kui', 'kun', 'lai', 'lao', 'lei', 'lin', 'liu', 'lou', 'lu',
  'mao', 'mei', 'meng', 'miao', 'na', 'nan', 'ning', 'niu', 'ou', 'pi',
  'qi', 'qia', 'qian', 'qin', 'qing', 'qu', 'que', 'rui', 'ruo', 'sang',
  'sha', 'shan', 'shang', 'shao', 'shen', 'sheng', 'shi', 'shu', 'shui', 'si',
  'song', 'sui', 'tai', 'tan', 'tang', 'tao', 'teng', 'tian', 'tiao', 'ting',
  'tong', 'tou', 'tu', 'wan', 'wang', 'wei', 'wen', 'wo', 'xi', 'xia',
  'xian', 'xiang', 'xiao', 'xie', 'xin', 'xing', 'xiong', 'xiu', 'xu', 'xuan',
  'xue', 'xun', 'yan', 'yang', 'yao', 'ye', 'yi', 'yin', 'ying', 'yong',
  'you', 'yu', 'yuan', 'yue', 'yun', 'zang', 'zan', 'zeng', 'zha', 'zhai',
  'zhan', 'zhang', 'zhao', 'zhe', 'zhen', 'zheng', 'zhi', 'zhong', 'zhou', 'zhu',
  'zhuo', 'zi', 'zong', 'zou', 'zu', 'zui', 'zuo',
  // 港澳台 / 海外拼写变体
  'cheung', 'wong', 'leung', 'chan', 'lam', 'ho', 'kwok', 'lau', 'lee', 'tse',
  'ng', 'au', 'mok', 'pang', 'szeto', 'tsang', 'wan', 'yeung', 'chow', 'ip',
  'kuo', 'lin', 'tsai', 'hsieh', 'hsu', 'chang', 'kuo', 'kung', 'luo',
  'soo', 'chia', 'goh', 'ong', 'khoo', 'neo', 'wee', 'lim',
  'tan', 'teoh', 'toh', 'wee', 'wong',
  'chin', 'heng', 'kong', 'soon', 'wee', 'yuan',
  // 韩裔常见 (Romanized Chinese + Korean pinyin)
  'chung', 'kim', 'park',
]);

// 否定信号：明显不是华人姓名的西语 / 葡语 / 俄语 / 阿拉伯语 / 北欧前缀
const FOREIGN_PREFIXES = [
  'van ', 'von ', 'de la ', 'de los ', 'del ', 'la ', 'le ', 'di ',
  'el ', 'al ', 'bin ', 'ibn ', 'mac ', 'mc ', "o'", 'fitz',
];
const FOREIGN_SUFFIXES = [
  'oglu', 'ov', 'ova', 'ev', 'eva', 'ski', 'sky', 'sen', 'son',
  'opoulos', 'akis', 'idis', 'ou', 'as', 'es',
];

// 西方常见 given name（首词为这些且姓氏不在华人常见集中 → 降权）
const WESTERN_GIVEN_NAMES = new Set([
  'john', 'james', 'robert', 'michael', 'william', 'david', 'richard', 'joseph',
  'thomas', 'charles', 'christopher', 'daniel', 'matthew', 'anthony', 'mark',
  'donald', 'steven', 'stephen', 'paul', 'andrew', 'joshua', 'kenneth', 'kevin',
  'brian', 'george', 'edward', 'ronald', 'timothy', 'jason', 'jeffrey', 'ryan',
  'jacob', 'gary', 'nicholas', 'eric', 'jonathan', 'stephen', 'larry', 'justin',
  'scott', 'brandon', 'benjamin', 'samuel', 'raymond', 'gregory', 'frank', 'alexander',
  'patrick', 'jack', 'dennis', 'jerry', 'tyler', 'aaron', 'henry', 'douglas', 'peter',
  'adam', 'nathan', 'zachary', 'harry', 'martin', 'alex', 'mary', 'patricia', 'jennifer',
  'linda', 'elizabeth', 'barbara', 'susan', 'jessica', 'sarah', 'karen', 'nancy',
  'lisa', 'betty', 'margaret', 'sandra', 'ashley', 'emily', 'donna', 'michelle',
  'dorothy', 'carol', 'amanda', 'melissa', 'deborah', 'stephanie', 'rebecca', 'sharon',
  'laura', 'cynthia', 'kathleen', 'amy', 'angela', 'shirley', 'anna', 'brenda',
  'pamela', 'emma', 'nicole', 'helen', 'samantha', 'katherine', 'christine', 'debra',
  'rachel', 'carolyn', 'janet', 'catherine', 'maria', 'heather', 'diane', 'ruth',
  'julie', 'olivia', 'joyce', 'virginia', 'victoria', 'kelly', 'lauren', 'christina',
  'joan', 'evelyn', 'judith', 'megan', 'andrea', 'cheryl', 'hannah', 'jacqueline',
  'martha', 'gloria', 'teresa', 'ann', 'sara', 'madison', 'frances', 'kathryn',
  'janice', 'jean', 'abigail', 'alice', 'judy', 'sophia', 'grace', 'denise',
  'amber', 'doris', 'marilyn', 'danielle', 'beverly', 'isabella', 'theresa', 'diana',
  'natalie', 'brittany', 'charlotte', 'marie', 'kayla', 'alexis', 'lori', 'tiffany',
  'mark', 'matt', 'mike', 'dan', 'chris', 'tom', 'rob', 'bob', 'jim', 'joe', 'sam', 'ben',
  'pierre', 'jean', 'michel', 'philippe', 'henri', 'louis', 'jacques', 'andre',
  'hans', 'klaus', 'wolfgang', 'dieter', 'juergen', 'jürgen', 'michael',
  'gianni', 'marco', 'andrea', 'giovanni', 'giuseppe', 'francesco',
  'carlos', 'jose', 'juan', 'luis', 'miguel', 'javier', 'manuel',
  'igor', 'sergei', 'alexei', 'andrei', 'boris', 'viktor',
  'yuki', 'takeshi', 'hiroshi', 'akira', 'kenji', 'makoto',
  'arjun', 'rajesh', 'amit', 'pradeep', 'vijay',
]);

// 给定字符串，返回 { parts, subTokens, tokens } 三种切分：
//   - parts: 按空白切分（保留 "Wei-Li" 整体）— 用于 hyphen / camelCase 检测
//   - subTokens: 按空白 + 连字符切分（'wei', 'li', 'wang'）— 用于姓氏匹配
//   - tokens: 默认指向 subTokens（向后兼容）
function tokenizeName(raw) {
  if (!raw) return { parts: [], subTokens: [], tokens: [] };
  let s = String(raw).trim();
  s = s.replace(/\b(prof(?:essor)?|dr|mr|mrs|ms|miss|sir|madam|phd|ph\.d\.?)\b\.?/gi, ' ').trim();
  s = s.replace(/[|,;()]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  const subTokens = [];
  for (const part of parts) {
    for (const sub of part.split('-')) {
      if (sub) subTokens.push(sub);
    }
  }
  return { parts, subTokens, tokens: subTokens };
}

function isCjkString(s) {
  return /[\u4e00-\u9fff]/.test(s);
}

function capitalizeFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// 1 token → 单姓 + 单字名 / 或单字
// 2 token → 姓 + 名 / 名 + 姓
// 3 token → 名 + 姓 (东亚顺序) 或 姓 + 名 (西方顺序)
// ≥ 4 token → 西方顺序可能性高
function assess({ name, cjkFragments = [] }) {
  const { parts, subTokens, tokens } = tokenizeName(name);
  if (tokens.length === 0) {
    return { score: 0, matches: [], negatives: [], detail: 'empty' };
  }
  const matches = [];
  const negatives = [];
  let score = 0;

  // 信号 1：CJK 字符（最强）
  if (isCjkString(name) || cjkFragments.length > 0) {
    score += 0.6;
    matches.push({ rule: 'cjk_chars_present', detail: (cjkFragments[0] || name).slice(0, 8) });
  }

  // 归一化 token：小写、去掉非字母
  const norm = subTokens.map((t) => t.toLowerCase().replace(/[^a-z'\-]/g, ''));
  if (norm.every((t) => !t)) {
    return { score: Math.min(1, score), matches, negatives, detail: 'no_alpha_tokens' };
  }

  // 信号 2：姓氏在华人常见集
  let surnameHit = null;
  for (const t of norm) {
    if (COMMON_SURNAMES.has(t)) { surnameHit = t; break; }
  }
  // 也允许 surname 是首字母大写的版本（覆盖 "Wang"）
  if (!surnameHit) {
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (COMMON_SURNAMES.has(lower)) { surnameHit = lower; break; }
    }
  }
  if (surnameHit) {
    score += 0.35;
    matches.push({ rule: 'surname_known', detail: surnameHit });
  }

  // 信号 3：given name 音节形状
  // 华人名通常 given name 1-2 音节；每个音节长度 2-8 字母
  // 注意：东 / 西方顺序都可能出现：
  //   - "Wang Xiaoming"（姓在前）：given = surname 之后的 token
  //   - "Xiaoming Wang"（姓在后 / 中文姓名顺序）：given = surname 之前的 token
  //   - "Han Han"（同字）：given = surname 之后的 token
  let givenNameTokens;
  if (!surnameHit) {
    givenNameTokens = norm;
  } else {
    const idx = norm.findIndex((t) => t === surnameHit);
    if (idx === 0) {
      givenNameTokens = norm.slice(1);          // 姓在前
    } else if (idx === norm.length - 1) {
      givenNameTokens = norm.slice(0, -1);       // 姓在后
    } else {
      // 姓氏在中间（少见），按出现位置二选一：取较长一侧
      const left = norm.slice(0, idx);
      const right = norm.slice(idx + 1);
      givenNameTokens = left.length >= right.length ? left : right;
    }
  }
  if (surnameHit && givenNameTokens.length >= 1 && givenNameTokens.length <= 3) {
    const allShortPinyin = givenNameTokens.every((t) => /^[a-z]{1,8}$/.test(t));
    if (allShortPinyin) {
      score += 0.15;
      matches.push({ rule: 'given_name_shape', detail: `${givenNameTokens.length}-syllable pinyin` });
    }
  }

  // 信号 4：首字母大写驼峰 "XiaoMing Wang" → 中文名常见（基于 parts，保留连字符整体）
  if (surnameHit) {
    for (const orig of parts) {
      if (/^[A-Z][a-z]+[A-Z][a-z]+$/.test(orig)) {
        score += 0.1;
        matches.push({ rule: 'camel_case_token', detail: orig });
        break;
      }
    }
  }

  // 信号 5：hyphen 名 "Xiao-Ming"（基于 parts）
  if (surnameHit) {
    for (const orig of parts) {
      if (/^[A-Z][a-z]+-[A-Z][a-z]+$/.test(orig)) {
        score += 0.1;
        matches.push({ rule: 'hyphenated_given_name', detail: orig });
        break;
      }
    }
  }

  // 否定信号 1：明显非华人前缀
  const lower = ' ' + name.toLowerCase() + ' ';
  for (const p of FOREIGN_PREFIXES) {
    if (lower.includes(p)) {
      score -= 0.3;
      negatives.push({ rule: 'foreign_prefix', detail: p.trim() });
      break;
    }
  }
  for (const s of FOREIGN_SUFFIXES) {
    if (lower.trimEnd().endsWith(' ' + s)) {
      score -= 0.3;
      negatives.push({ rule: 'foreign_suffix', detail: s });
      break;
    }
  }

  // 否定信号 2：典型西方 given name 在第一位且姓氏不在华人集中
  if (!surnameHit && norm.length >= 2) {
    const first = norm[0];
    if (WESTERN_GIVEN_NAMES.has(first)) {
      score -= 0.2;
      negatives.push({ rule: 'western_given_name', detail: first });
    }
  }

  // 否定信号 3：明显拉丁语系 given name (io, ia 收尾) + 西方姓氏
  if (!surnameHit && /^[a-z]+(io|ia|ius)$/.test(norm[norm.length - 1])) {
    score -= 0.1;
    negatives.push({ rule: 'latin_ending', detail: norm[norm.length - 1] });
  }

  // 信号 6：纯单 token 且是常见华人姓氏 → 仍可能
  if (norm.length === 1 && surnameHit) {
    score += 0.05;
    matches.push({ rule: 'single_token_surname', detail: surnameHit });
  }

  // 强制裁剪
  if (score > 1) score = 1;
  if (score < 0) score = 0;

  return { score, matches, negatives, detail: `${norm.length}-token` };
}

function looksChinese({ name, cjkFragments = [], threshold = 0.4 } = {}) {
  const result = assess({ name, cjkFragments });
  return {
    probability: Number(result.score.toFixed(3)),
    isLikely: result.score >= threshold,
    reasons: result.matches,
    negatives: result.negatives,
    detail: result.detail,
  };
}

module.exports = { looksChinese, assess, tokenizeName, COMMON_SURNAMES, WESTERN_GIVEN_NAMES };
