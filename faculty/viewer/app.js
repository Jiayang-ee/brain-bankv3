/* 人才库 · 本地查看器 前端 (BRA-10)
 * 零依赖 vanilla JS，与 viewer_server.js + viewer_api.js 配套
 */
(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────
  const state = {
    source: 'faculty',
    filters: { q: '', min_chs: 0, sort: 'chs_desc', school_rank: [], department_id: [], category: [], review_status: [] },
    page: 1,
    pageSize: 50,
    total: 0,
    rows: [],
    selectedId: null,           // "faculty:abc" 或 "paper:sha1..."
    selectedDetail: null,       // { id, source, review_status, review_notes, ... }
    facets: null,
    stats: null,
    schemaWarn: false,          // paper_authors 缺 review_status 字段时为 true
    paperReviewColumns: { review_status: true, review_notes: true },
  };

  // ─── DOM helpers ────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'html') n.innerHTML = v;
      else if (v === true) n.setAttribute(k, '');
      else if (v === false || v == null) {/* skip */}
      else n.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  const esc = (s) => {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  const multiSel = (sel) => Array.from(sel.selectedOptions).map((o) => o.value);
  const setMultiSel = (sel, values) => {
    const set = new Set(values || []);
    for (const opt of sel.options) opt.selected = set.has(opt.value);
  };

  // ─── API ────────────────────────────────────────────────
  async function api(path, init) {
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return j;
  }

  // ─── Toast ──────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  // ─── Stats / Facets ─────────────────────────────────────
  async function loadStats() {
    const j = await api('/api/stats');
    state.stats = j.data;
    $('stat-faculty').textContent = `教师 ${state.stats.faculty.total} · 华人 ${state.stats.faculty.chinese_likely}`;
    $('stat-paper').textContent = `论文 ${state.stats.paper.total} · 华人 ${state.stats.paper.chinese_likely}`;
  }
  async function loadFacets() {
    const j = await api('/api/facets');
    state.facets = j.data;
    // 填充学校 / 院系 / 类别下拉
    const sSchool = $('f-school');
    sSchool.innerHTML = '';
    for (const s of state.facets.schools) {
      const o = document.createElement('option');
      o.value = String(s.rank);
      o.textContent = `#${s.rank} ${s.name_en} (${s.count})`;
      sSchool.appendChild(o);
    }
    const sDept = $('f-dept');
    sDept.innerHTML = '';
    for (const d of state.facets.departments) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `[#${d.school_rank}] ${d.name_en} (${d.count})`;
      sDept.appendChild(o);
    }
    const sCat = $('f-category');
    sCat.innerHTML = '';
    for (const c of state.facets.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.id} (${c.n})`;
      sCat.appendChild(o);
    }
  }

  // ─── List ───────────────────────────────────────────────
  function buildQuery() {
    const f = state.filters;
    const p = new URLSearchParams();
    p.set('source', state.source);
    p.set('page', String(state.page));
    p.set('page_size', String(state.pageSize));
    p.set('sort', f.sort);
    if (f.q) p.set('q', f.q);
    if (f.min_chs > 0) p.set('min_chs', String(f.min_chs));
    for (const v of f.school_rank) p.append('school_rank', v);
    for (const v of f.department_id) p.append('department_id', v);
    for (const v of f.category) p.append('category', v);
    for (const v of f.review_status) p.append('review_status', v);
    return p.toString();
  }
  async function loadList() {
    const j = await api('/api/candidates?' + buildQuery());
    state.rows = j.rows;
    state.total = j.total;
    renderList();
    renderPager();
  }
  function renderList() {
    const list = $('list');
    list.innerHTML = '';
    if (state.rows.length === 0) {
      const e = el('div', { class: 'empty', id: 'list-empty' }, '没有匹配的候选人');
      list.appendChild(e);
    } else {
      for (const r of state.rows) list.appendChild(renderRow(r));
    }
    const start = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.total);
    $('list-count').textContent = `共 ${state.total} 条 · 显示 ${start}–${end}`;
    $('list-hint').textContent = `排序: ${sortLabel(state.filters.sort)} · 概率 ≥ ${state.filters.min_chs}`;
  }
  function renderRow(r) {
    const chs = r.chinese_name_probability || 0;
    const chsCls = chs >= 0.6 ? 'high' : (chs >= 0.4 ? 'mid' : 'low');
    const statusCls = 'status-' + (r.review_status || 'pending');

    const sourceLabel = r.source === 'faculty' ? 'faculty' : 'paper';
    const meta = [];
    if (r.source === 'faculty') {
      if (r.school_name_en) meta.push(esc(r.school_name_en));
      if (r.department_name_en) meta.push(esc(r.department_name_en));
    } else if (r.paper) {
      const p = r.paper;
      const bits = [];
      if (p.publish_year) bits.push(String(p.publish_year));
      if (p.journal_name) bits.push(esc(p.journal_name));
      if (p.is_first_author) bits.push('一作');
      if (p.is_last_author) bits.push('末位');
      if (p.is_corresponding) bits.push('通讯');
      meta.push(bits.join(' · '));
    }

    const isActive = state.selectedId === r.id;
    const item = el('div', {
      class: 'list-item' + (isActive ? ' active' : ''),
      dataset: { id: r.id },
      onclick: () => selectCandidate(r.id),
    });
    item.appendChild(el('div', { class: 'li-row1' },
      el('span', { class: 'li-name' }, r.name || '(unnamed)'),
      el('span', { class: 'li-chs ' + chsCls }, Math.round(chs * 100) + '%'),
    ));
    item.appendChild(el('div', { class: 'li-row2' },
      el('span', { class: 'li-school' }, meta[0] || ''),
      meta[1] ? el('span', { class: 'li-dept' }, meta[1]) : null,
    ));
    if (r.title) item.appendChild(el('div', { class: 'li-row2' }, el('span', { class: 'li-title' }, r.title)));
    item.appendChild(el('div', { class: 'li-row3' },
      el('span', { class: 'li-source' }, sourceLabel),
      el('span', { class: 'status-badge ' + statusCls }, statusLabel(r.review_status || 'pending')),
      r.paper && r.paper.doi ? el('span', {}, 'DOI ' + r.paper.doi) : null,
    ));
    return item;
  }
  function renderPager() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('page-info').textContent = `第 ${state.page} / ${totalPages} 页`;
    $('btn-prev').disabled = state.page <= 1;
    $('btn-next').disabled = state.page >= totalPages;
  }
  function sortLabel(s) {
    return { chs_desc: '华人概率↓', name_asc: '姓名 A→Z', recent_desc: '最近更新↓' }[s] || s;
  }
  function statusLabel(s) {
    return { pending: '待审核', confirmed: '确认相关', excluded: '排除', focus: '重点关注' }[s] || s;
  }

  // ─── Detail ─────────────────────────────────────────────
  async function selectCandidate(id) {
    if (!id) return;
    const source = id.startsWith('paper:') ? 'paper' : 'faculty';
    const origId = id.slice(source.length + 1);
    try {
      const j = await api(`/api/candidates/${encodeURIComponent(id)}?source=${source}`);
      state.selectedId = id;
      state.selectedDetail = j.data;
      renderDetail();
      // highlight in list
      for (const n of $('list').querySelectorAll('.list-item')) n.classList.toggle('active', n.dataset.id === id);
    } catch (e) {
      toast('加载详情失败：' + e.message, 'err');
    }
  }
  function renderDetail() {
    const r = state.selectedDetail;
    if (!r) {
      $('detail-content').hidden = true;
      $('detail-empty').style.display = '';
      return;
    }
    $('detail-empty').style.display = 'none';
    $('detail-content').hidden = false;

    const chs = r.chinese_name_probability || 0;
    const chsCls = chs >= 0.6 ? 'high' : (chs >= 0.4 ? 'mid' : '');
    $('d-name').textContent = r.name || '(unnamed)';
    $('d-source').textContent = r.source;
    $('d-chs').textContent = Math.round(chs * 100) + '%';
    $('d-chs').className = 'chs-pill ' + chsCls;
    $('d-sub').textContent = r.title || '';

    $('d-school-name').innerHTML = r.school_name_en ? esc(r.school_name_en) : '<span class="muted">—</span>';
    $('d-dept-name').innerHTML = r.department_name_en ? esc(r.department_name_en) : '<span class="muted">—</span>';
    $('d-category').innerHTML = r.category ? `<code>${esc(r.category)}</code>` : '<span class="muted">—</span>';

    // 论文证据
    const ps = $('d-paper-section');
    if (r.source === 'paper' && r.paper) {
      ps.hidden = false;
      const p = r.paper;
      $('d-paper-title').innerHTML = p.title ? esc(p.title) : '<span class="muted">—</span>';
      $('d-paper-journal').innerHTML = p.journal_name ? esc(p.journal_name) : '<span class="muted">—</span>';
      $('d-paper-year').innerHTML = p.publish_year ? String(p.publish_year) : '<span class="muted">—</span>';
      const pos = [];
      if (p.is_first_author) pos.push('一作');
      if (p.is_last_author) pos.push('末位');
      if (p.is_corresponding) pos.push('通讯');
      pos.push(`#${p.author_position ?? '?'}`);
      $('d-paper-pos').textContent = pos.join(' · ');
      $('d-paper-aff').innerHTML = p.affiliation_name ? esc(p.affiliation_name) : '<span class="muted">—</span>';
      $('d-paper-doi').innerHTML = p.doi ? `<a href="https://doi.org/${encodeURIComponent(p.doi)}" target="_blank" rel="noopener">${esc(p.doi)}</a>` : '<span class="muted">—</span>';
    } else {
      ps.hidden = true;
    }

    // 证据 / 链接
    if (r.source_url) {
      $('d-source-url').innerHTML = `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source_url)}</a>`;
    } else {
      $('d-source-url').innerHTML = '<span class="muted">—</span>';
    }
    if (r.source === 'faculty' && r.local_path) {
      $('d-local-label').textContent = '本地 HTML';
      $('d-local').innerHTML = `<a href="/html/${encodeURI(r.local_path)}" target="_blank" rel="noopener">${esc(r.local_path)}</a>`;
    } else if (r.source === 'paper' && r.paper) {
      $('d-local-label').textContent = '论文 ID';
      $('d-local').innerHTML = r.paper.id ? `<code>${esc(r.paper.id)}</code>` : '<span class="muted">—</span>';
    } else {
      $('d-local-label').textContent = '本地 HTML';
      $('d-local').innerHTML = '<span class="muted">—</span>';
    }
    if (r.headshot_local_path) {
      $('d-photo').innerHTML = `<a href="/photo/${encodeURI(r.headshot_local_path)}" target="_blank" rel="noopener">${esc(r.headshot_local_path)}</a><br><img src="/photo/${encodeURI(r.headshot_local_path)}" alt="headshot" style="max-width:160px;max-height:200px;margin-top:6px;border:1px solid var(--border);border-radius:4px">`;
    } else if (r.headshot_url) {
      $('d-photo').innerHTML = `<a href="${esc(r.headshot_url)}" target="_blank" rel="noopener">远程 URL</a>`;
    } else {
      $('d-photo').innerHTML = '<span class="muted">—</span>';
    }
    $('d-email').innerHTML = r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '<span class="muted">—</span>';

    // 华人初筛原因
    const reasons = $('d-reasons');
    reasons.innerHTML = '';
    const positives = (r.chinese_name_reasons || []);
    const negatives = (r.chinese_name_negatives || []);
    if (positives.length === 0 && negatives.length === 0) {
      reasons.appendChild(el('span', { class: 'muted' }, '—'));
    } else {
      for (const m of positives) {
        const tag = el('span', { class: 'reason-tag' }, m.rule || '?', el('span', { class: 'detail' }, m.detail || ''));
        reasons.appendChild(tag);
      }
      for (const m of negatives) {
        const tag = el('span', { class: 'reason-tag neg' }, '− ' + (m.rule || '?'), el('span', { class: 'detail' }, m.detail || ''));
        reasons.appendChild(tag);
      }
    }

    // 审核表单
    $('d-status').value = r.review_status || 'pending';
    $('d-notes').value = r.review_notes || '';
    $('save-status').textContent = '';
    $('save-status').className = 'save-status';
  }

  // ─── Save review ────────────────────────────────────────
  async function saveReview() {
    if (!state.selectedId) return;
    const status = $('d-status').value;
    const notes = $('d-notes').value;
    const saveBtn = $('btn-save');
    const statusEl = $('save-status');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    statusEl.className = 'save-status';
    try {
      const r = await fetch(`/api/candidates/${encodeURIComponent(state.selectedId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: status, review_notes: notes || null }),
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
      }
      if (j.data && j.data.persisted === false) {
        statusEl.textContent = '⚠ ' + (j.warning || '未持久化');
        statusEl.className = 'save-status warn';
        toast('未持久化：' + (j.warning || '检查 schema'), 'warn');
      } else {
        statusEl.textContent = '✓ 已保存到 SQLite';
        statusEl.className = 'save-status ok';
        toast('已保存到 SQLite', 'ok');
        // 局部更新 state.rows
        const idx = state.rows.findIndex((x) => x.id === state.selectedId);
        if (idx >= 0) {
          state.rows[idx].review_status = status;
          state.rows[idx].review_notes = notes || null;
          renderList();
        }
        if (state.selectedDetail) {
          state.selectedDetail.review_status = status;
          state.selectedDetail.review_notes = notes || null;
        }
      }
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.className = 'save-status err';
      toast('保存失败：' + e.message, 'err');
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ─── Filter wiring ──────────────────────────────────────
  function readFilters() {
    state.filters = {
      q: $('f-q').value.trim(),
      min_chs: Number($('f-min-chs').value) || 0,
      sort: $('f-sort').value,
      school_rank: multiSel($('f-school')),
      department_id: multiSel($('f-dept')),
      category: multiSel($('f-category')),
      review_status: multiSel($('f-status')),
    };
    state.page = 1;
  }
  function applyFilters() {
    readFilters();
    loadList().catch((e) => toast('加载失败：' + e.message, 'err'));
  }
  function resetFilters() {
    $('f-q').value = '';
    $('f-min-chs').value = 0;
    $('f-sort').value = 'chs_desc';
    setMultiSel($('f-school'), []);
    setMultiSel($('f-dept'), []);
    setMultiSel($('f-category'), []);
    setMultiSel($('f-status'), []);
    applyFilters();
  }
  function changeSource(s) {
    if (state.source === s) return;
    state.source = s;
    state.page = 1;
    state.selectedId = null;
    state.selectedDetail = null;
    renderDetail();
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.source === s);
    loadList().catch((e) => toast('加载失败：' + e.message, 'err'));
  }

  // ─── Init ───────────────────────────────────────────────
  function bind() {
    for (const t of document.querySelectorAll('.tab')) {
      t.addEventListener('click', () => changeSource(t.dataset.source));
    }
    $('btn-apply').addEventListener('click', applyFilters);
    $('btn-reset').addEventListener('click', resetFilters);
    $('btn-prev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
    $('btn-next').addEventListener('click', () => { state.page++; loadList().catch((e) => { state.page--; toast('加载失败：' + e.message, 'err'); }); });
    $('btn-refresh').addEventListener('click', () => {
      loadStats(); loadFacets(); loadList();
      if (state.selectedId) selectCandidate(state.selectedId);
    });
    $('btn-save').addEventListener('click', saveReview);
    // 回车提交
    $('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    $('f-min-chs').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyFilters(); });
    $('f-sort').addEventListener('change', applyFilters);
    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.key === 'j') { state.page++; loadList().catch(() => { state.page--; }); }
      else if (e.key === 'k') { if (state.page > 1) { state.page--; loadList(); } }
      else if (e.key === '/') { e.preventDefault(); $('f-q').focus(); }
      else if (e.key === 'Escape') { state.selectedId = null; state.selectedDetail = null; renderDetail(); }
    });
  }

  async function init() {
    bind();
    // 从 URL 读取初始 source / id（支持直接深链）
    const params = new URLSearchParams(window.location.search);
    const sourceParam = params.get('source');
    if (sourceParam === 'faculty' || sourceParam === 'paper') {
      state.source = sourceParam;
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.source === state.source);
    }
    const idParam = params.get('id');
    try {
      await loadStats();
      await loadFacets();
      await loadList();
      if (idParam && (idParam.startsWith('faculty:') || idParam.startsWith('paper:'))) {
        await selectCandidate(idParam);
      } else {
        renderDetail();
      }
    } catch (e) {
      toast('初始化失败：' + e.message, 'err');
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
