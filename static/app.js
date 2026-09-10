(function () {
  'use strict';

  const state = {
    servers: [],
    currentServer: null,
    currentDate: '',
    leases: [],
    page: 1,
    pageSize: 50,
    sortBy: 'IPAddress',
    sortDir: 'asc',
    search: '',
    stateFilter: '',
    timer: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    serverSelect: $('server-select'),
    dateSelect: $('date-select'),
    refreshInterval: $('refresh-interval'),
    refreshNow: $('refresh-now'),
    openNamemap: $('open-namemap'),
    namemapModal: $('namemap-modal'),
    namemapClose: $('namemap-close'),
    nmKey: $('nm-key'),
    nmName: $('nm-name'),
    nmAdd: $('nm-add'),
    nmTbody: $('nm-tbody'),
    nmFile: $('nm-file'),
    nmImport: $('nm-import'),
    nmTemplate: $('nm-template'),
    nmImportResult: $('nm-import-result'),
    exportCsv: $('export-csv'),
    exportXlsx: $('export-xlsx'),
    searchInput: $('search-input'),
    stateFilter: $('state-filter'),
    pageSize: $('page-size'),
    prevPage: $('prev-page'),
    nextPage: $('next-page'),
    pageInfo: $('page-info'),
    dataInfo: $('data-info'),
    tbody: $('lease-tbody'),
    thead: document.querySelector('.data-table thead'),
    toast: $('toast'),
  };

  function showToast(msg, kind = '') {
    els.toast.textContent = msg;
    els.toast.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.add('hidden'), 3000);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  function ipNum(ip) {
    return String(ip || '').split('.').reduce((a, p) => a * 256 + (parseInt(p, 10) || 0), 0);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function classifyState(s) {
    const x = (s || '').toLowerCase();
    if (x === 'active') return 'Active';
    if (x === 'inactive' || x === 'declined') return x.charAt(0).toUpperCase() + x.slice(1);
    if (x === 'reserved') return 'Reserved';
    return 'Other';
  }

  // ---------- 服务器与日期 ----------
  async function loadServers() {
    const data = await api('/api/servers');
    state.servers = data.servers || [];
    els.serverSelect.innerHTML = '';
    if (!state.servers.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(暂无数据,等待 DHCP 服务器推送)';
      els.serverSelect.appendChild(opt);
      els.dataInfo.textContent = '尚未收到任何数据。请确认 DHCP 服务器上的定时脚本已部署并执行。';
      return;
    }
    for (const s of state.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const t = s.collectedAt || s.receivedAt || '';
      opt.textContent = `${s.displayName} (${s.count} 条${t ? ' · ' + t : ''})`;
      els.serverSelect.appendChild(opt);
    }
    const saved = localStorage.getItem('dhcp.server');
    const target = state.servers.find((s) => s.id === saved) || state.servers[0];
    els.serverSelect.value = target.id;
    state.currentServer = target.id;
    await loadDates();
  }

  async function loadDates() {
    els.dateSelect.innerHTML = '<option value="">最新</option>';
    state.currentDate = '';
    if (!state.currentServer) return;
    try {
      const d = await api(`/api/dates?server=${encodeURIComponent(state.currentServer)}`);
      for (const day of d.dates || []) {
        const opt = document.createElement('option');
        opt.value = day;
        opt.textContent = `${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}`;
        els.dateSelect.appendChild(opt);
      }
    } catch (_) { /* 忽略 */ }
  }

  // ---------- 数据 ----------
  async function fetchLeases() {
    if (!state.currentServer) return;
    try {
      const p = new URLSearchParams({
        server: state.currentServer,
        page: '1',
        page_size: '10000',
        sort_by: state.sortBy,
        sort_dir: state.sortDir,
      });
      if (state.currentDate) p.set('date', state.currentDate);
      const data = await api('/api/leases?' + p.toString());
      state.leases = data.items || [];
      state.page = 1;
      els.dataInfo.textContent =
        `共 ${data.total} 条 · 采集时间 ${data.collectedAt || '-'} · 接收时间 ${data.receivedAt || '-'}`;
      applyFilter();
    } catch (err) {
      showToast('加载失败: ' + err.message, 'error');
    }
  }

  // ---------- 过滤 / 渲染 ----------
  function applyFilter() {
    const q = state.search.trim().toLowerCase();
    let arr = state.leases;
    if (state.stateFilter) arr = arr.filter((l) => l.AddressState === state.stateFilter);
    if (q) {
      arr = arr.filter((l) =>
        (l.HostName || '').toLowerCase().includes(q) ||
        (l.Name || '').toLowerCase().includes(q) ||
        (l.IPAddress || '').toLowerCase().includes(q) ||
        (l.ClientId || '').toLowerCase().includes(q));
    }
    arr.sort((a, b) => {
      const va = a[state.sortBy] || '';
      const vb = b[state.sortBy] || '';
      let cmp = state.sortBy === 'IPAddress' ? ipNum(va) - ipNum(vb) : String(va).localeCompare(String(vb));
      return state.sortDir === 'asc' ? cmp : -cmp;
    });
    state.filtered = arr;
    renderTable();
    updateSortIndicators();
  }

  function renderTable() {
    const total = state.filtered.length;
    const lastPage = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > lastPage) state.page = lastPage;
    const slice = state.filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    els.tbody.innerHTML = '';
    if (!slice.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;color:#94a3b8;padding:30px">无匹配记录</td>';
      els.tbody.appendChild(tr);
    }
    for (const l of slice) {
      const tr = document.createElement('tr');
      if ((l.AddressState || '').toLowerCase() === 'inactive') tr.classList.add('inactive');
      tr.innerHTML = `
        <td>${escapeHtml(l.HostName || '-')}</td>
        <td><span class="state-badge state-${classifyState(l.AddressState)}">${escapeHtml(l.AddressState || '-')}</span></td>
        <td>${escapeHtml(l.LeaseExpiryTime || '-')}</td>
        <td>${escapeHtml(l.ClientId || '-')}</td>
        <td>${escapeHtml(l.IPAddress || '-')}</td>
        <td>${escapeHtml(l.Name || '')}</td>`;
      els.tbody.appendChild(tr);
    }
    els.pageInfo.textContent = `第 ${state.page} / ${lastPage} 页`;
    els.prevPage.disabled = state.page <= 1;
    els.nextPage.disabled = state.page >= lastPage;
  }

  function updateSortIndicators() {
    els.thead.querySelectorAll('th').forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === state.sortBy) {
        th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });
  }

  // ---------- 姓名映射 ----------
  async function loadNamemap() {
    const data = await api('/api/namemap');
    els.nmTbody.innerHTML = '';
    if (!data.items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="3" style="text-align:center;color:#94a3b8">暂无映射,请在上方添加</td>';
      els.nmTbody.appendChild(tr);
      return;
    }
    for (const it of data.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(it.key)}</td>
        <td>${escapeHtml(it.name)}</td>
        <td><button class="btn btn-sm nm-del" data-key="${escapeHtml(it.key)}">删除</button></td>`;
      tr.querySelector('.nm-del').addEventListener('click', async () => {
        try {
          await api(`/api/namemap/${encodeURIComponent(it.key)}`, { method: 'DELETE' });
          loadNamemap();
          fetchLeases();
        } catch (err) { showToast('删除失败: ' + err.message, 'error'); }
      });
      els.nmTbody.appendChild(tr);
    }
  }

  els.openNamemap.addEventListener('click', () => {
    els.namemapModal.classList.remove('hidden');
    loadNamemap();
  });
  els.namemapClose.addEventListener('click', () => els.namemapModal.classList.add('hidden'));
  els.namemapModal.addEventListener('click', (e) => {
    if (e.target === els.namemapModal) els.namemapModal.classList.add('hidden');
  });
  els.nmAdd.addEventListener('click', async () => {
    const key = els.nmKey.value.trim();
    const name = els.nmName.value.trim();
    if (!key || !name) { showToast('键和姓名都不能为空', 'error'); return; }
    try {
      await api('/api/namemap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, name }),
      });
      els.nmKey.value = ''; els.nmName.value = '';
      showToast('已添加', 'success');
      loadNamemap();
      fetchLeases();
    } catch (err) { showToast('添加失败: ' + err.message, 'error'); }
  });

  // 批量导入
  els.nmImport.addEventListener('click', () => els.nmFile.click());
  els.nmFile.addEventListener('change', async () => {
    const f = els.nmFile.files[0];
    if (!f) return;
    els.nmImportResult.textContent = '导入中…';
    els.nmImportResult.className = 'import-result';
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch('/api/namemap/import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.statusText);
      els.nmImportResult.textContent = `✓ 新增 ${j.added} · 更新 ${j.updated}${j.skipped ? ' · 跳过 ' + j.skipped : ''}`;
      els.nmImportResult.className = 'import-result ok';
      showToast('导入完成', 'success');
      loadNamemap();
      fetchLeases();
    } catch (err) {
      els.nmImportResult.textContent = '✗ ' + err.message;
      els.nmImportResult.className = 'import-result fail';
      showToast('导入失败: ' + err.message, 'error');
    }
    els.nmFile.value = '';
  });
  els.nmTemplate.addEventListener('click', () => { window.location.href = '/api/namemap/template'; });

  // ---------- 事件 ----------
  els.serverSelect.addEventListener('change', async () => {
    state.currentServer = els.serverSelect.value;
    localStorage.setItem('dhcp.server', state.currentServer);
    await loadDates();
    await fetchLeases();
  });
  els.dateSelect.addEventListener('change', () => { state.currentDate = els.dateSelect.value; fetchLeases(); });
  els.refreshNow.addEventListener('click', async () => { await loadServers(); await fetchLeases(); });

  els.refreshInterval.addEventListener('change', () => {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    const sec = parseInt(els.refreshInterval.value, 10);
    if (sec > 0) state.timer = setInterval(() => fetchLeases(), sec * 1000);
  });

  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = els.searchInput.value; applyFilter(); }, 250);
  });
  els.stateFilter.addEventListener('change', () => { state.stateFilter = els.stateFilter.value; applyFilter(); });

  els.thead.addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th || !th.dataset.sort) return;
    if (state.sortBy === th.dataset.sort) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortBy = th.dataset.sort; state.sortDir = 'asc'; }
    applyFilter();
  });

  els.pageSize.addEventListener('change', () => { state.pageSize = parseInt(els.pageSize.value, 10); renderTable(); });
  els.prevPage.addEventListener('click', () => { if (state.page > 1) { state.page--; renderTable(); } });
  els.nextPage.addEventListener('click', () => {
    const last = Math.max(1, Math.ceil((state.filtered || []).length / state.pageSize));
    if (state.page < last) { state.page++; renderTable(); }
  });

  function exportUrl(fmt) {
    const p = new URLSearchParams({ server: state.currentServer, fmt });
    if (state.currentDate) p.set('date', state.currentDate);
    if (state.search) p.set('q', state.search);
    if (state.stateFilter) p.set('state', state.stateFilter);
    return '/api/export?' + p.toString();
  }
  els.exportCsv.addEventListener('click', () => { if (state.currentServer) window.location.href = exportUrl('csv'); });
  els.exportXlsx.addEventListener('click', () => { if (state.currentServer) window.location.href = exportUrl('xlsx'); });

  // ---------- 启动 ----------
  (async () => {
    try {
      await loadServers();
      await fetchLeases();
      const sec = parseInt(els.refreshInterval.value, 10);
      if (sec > 0) state.timer = setInterval(() => fetchLeases(), sec * 1000);
    } catch (err) {
      showToast('初始化失败: ' + err.message, 'error');
    }
  })();
})();
