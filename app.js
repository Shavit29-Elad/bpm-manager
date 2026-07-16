// app.js — לוגיקת הממשק (SPA פשוט ללא ספריות)
const state = { company: null, companies: [], tab: 'home' };
const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '₪' + Number(n).toLocaleString('he-IL'));
const api = (p) => fetch(p).then(r => r.json());

async function boot() {
  state.companies = await api('/api/companies');
  const sel = $('#companySelect');
  sel.innerHTML = state.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  state.company = state.companies[0]?.id;
  sel.onchange = () => { state.company = sel.value; render(); };

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); state.tab = t.dataset.tab; render();
  });
  setupModal();
  await renderStatus();
  render();
}

async function renderStatus() {
  const h = await api('/api/health');
  $('#statusPills').innerHTML = [
    pill('חשבונית ירוקה', h.greenInvoiceConnected),
    pill('יומן גוגל', h.calendarConnected),
  ].join('');
}
const pill = (label, ok, text) =>
  `<span class="pill ${ok ? 'ok' : 'off'}">${label}: ${ok ? 'מחובר' : (text || 'לא מחובר')}</span>`;

function render() {
  const c = $('#content');
  ({ home: renderHome, events: renderCombined, clients: renderClients, team: renderTeam,
     bank: renderBank, contractors: renderContractors, payroll: renderPayroll, connections: renderConnections }[state.tab])(c);
}

// ---- דף הבית (סקירה חודשית מחשבונית ירוקה) ----
const MONTHS_FULL = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const DOC_TYPE_OPTIONS = [
  { v: '305,320', label: 'חשבוניות (מס + מס-קבלה)' },
  { v: '305', label: 'חשבונית מס' },
  { v: '320', label: 'חשבונית מס-קבלה' },
  { v: '400', label: 'קבלה' },
  { v: '300', label: 'הצעת מחיר' },
  { v: '330', label: 'חשבונית זיכוי' },
  { v: '10', label: 'חשבון עסקה' },
  { v: '305,320,300,400,330,10', label: 'כל המסמכים' },
];
function initPeriod() {
  const now = new Date();
  if (!state.period) state.period = 'year';
  if (!state.dashMonth) state.dashMonth = now.toISOString().slice(0, 7);
  if (!state.dashYear) state.dashYear = now.getFullYear();
  if (!state.rangeFrom) state.rangeFrom = state.dashMonth;
  if (!state.rangeTo) state.rangeTo = state.dashMonth;
  if (!state.docType) state.docType = '305,320';
}
window.setDocType = (v) => { state.docType = v; renderHome($('#content')); };
window.setPeriod = (p) => { state.period = p; renderHome($('#content')); };
window.shiftDashMonth = (delta) => {
  const [y, m] = state.dashMonth.split('-').map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  state.dashMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  renderHome($('#content'));
};
window.shiftDashYear = (delta) => { state.dashYear = Number(state.dashYear) + delta; renderHome($('#content')); };
window.pickDashMonth = (v) => { if (v) { state.dashMonth = v; renderHome($('#content')); } };
window.pickDashMonthPart = (part, val) => {
  let [y, m] = state.dashMonth.split('-').map(Number);
  if (part === 'm') m = Number(val); else y = Number(val);
  state.dashMonth = `${y}-${String(m).padStart(2, '0')}`;
  renderHome($('#content'));
};
window.pickDashYear = (v) => { state.dashYear = Number(v); renderHome($('#content')); };
window.setRangePart = (which, part, val) => {
  const key = which === 'from' ? 'rangeFrom' : 'rangeTo';
  let [y, m] = state[key].split('-').map(Number);
  if (part === 'm') m = Number(val); else y = Number(val);
  state[key] = `${y}-${String(m).padStart(2, '0')}`;
  renderHome($('#content'));
};
window.applyRange = () => {
  state.rangeFrom = $('#rngFrom').value || state.rangeFrom;
  state.rangeTo = $('#rngTo').value || state.rangeTo;
  renderHome($('#content'));
};
function periodQuery() {
  const t = `&types=${encodeURIComponent(state.docType || '305,320')}`;
  if (state.period === 'year') return `from=${state.dashYear}-01&to=${state.dashYear}-12${t}`;
  if (state.period === 'range') return `from=${state.rangeFrom}&to=${state.rangeTo}${t}`;
  return `month=${state.dashMonth}${t}`;
}
function docTypeSelect() {
  const opts = DOC_TYPE_OPTIONS.map(o => `<option value="${o.v}" ${state.docType === o.v ? 'selected' : ''}>${o.label}</option>`).join('');
  return `<select onchange="setDocType(this.value)" style="padding:7px 12px">${opts}</select>`;
}
function periodLabel() {
  if (state.period === 'year') return `שנת ${state.dashYear}`;
  if (state.period === 'range') { const f = state.rangeFrom.split('-'), t = state.rangeTo.split('-'); return `${MONTHS_FULL[+f[1] - 1]} ${f[0]} — ${MONTHS_FULL[+t[1] - 1]} ${t[0]}`; }
  const [y, m] = state.dashMonth.split('-').map(Number); return `${MONTHS_FULL[m - 1]} ${y}`;
}
function periodControls() {
  const seg = (p, label) => `<button class="btn ${state.period === p ? 'primary' : 'ghost'}" style="padding:6px 13px" onclick="setPeriod('${p}')">${label}</button>`;
  const toggle = `<div style="display:flex;gap:3px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px">${seg('month', 'חודשי')}${seg('range', 'טווח')}${seg('year', 'שנתי')}</div>`;
  let nav = '';
  if (state.period === 'month') {
    const [my, mm] = state.dashMonth.split('-').map(Number);
    nav = `<button class="btn ghost" style="padding:6px 12px" onclick="shiftDashMonth(-1)">→</button>
      <select onchange="pickDashMonthPart('m',this.value)" style="padding:7px 10px">${monthOptions(mm)}</select>
      <select onchange="pickDashMonthPart('y',this.value)" style="padding:7px 10px">${yearOptions(my)}</select>
      <button class="btn ghost" style="padding:6px 12px" onclick="shiftDashMonth(1)">←</button>`;
  } else if (state.period === 'year') {
    nav = `<button class="btn ghost" style="padding:6px 12px" onclick="shiftDashYear(-1)">→</button>
      <select onchange="pickDashYear(this.value)" style="padding:7px 10px">${yearOptions(Number(state.dashYear))}</select>
      <button class="btn ghost" style="padding:6px 12px" onclick="shiftDashYear(1)">←</button>`;
  } else {
    const [ff, fm] = state.rangeFrom.split('-').map(Number);
    const [tf, tm] = state.rangeTo.split('-').map(Number);
    nav = `<span class="muted">מ־</span>
      <select onchange="setRangePart('from','m',this.value)" style="padding:7px 10px">${monthOptions(fm)}</select>
      <select onchange="setRangePart('from','y',this.value)" style="padding:7px 10px">${yearOptions(ff)}</select>
      <span class="muted">עד</span>
      <select onchange="setRangePart('to','m',this.value)" style="padding:7px 10px">${monthOptions(tm)}</select>
      <select onchange="setRangePart('to','y',this.value)" style="padding:7px 10px">${yearOptions(tf)}</select>`;
  }
  return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${toggle}${nav}</div>`;
}
function monthOptions(sel) { return MONTHS_FULL.map((n, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${n}</option>`).join(''); }
function yearOptions(sel) { const now = new Date().getFullYear(); let o = ''; for (let y = now + 1; y >= now - 6; y--) o += `<option value="${y}" ${sel === y ? 'selected' : ''}>${y}</option>`; return o; }
function fmtDate(s) { if (!s) return '—'; const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : s; }

// תצוגה מקדימה של מסמך (PDF) בחלון קופץ — מושכים את הקובץ כ-blob ומציגים בתוך המסך (בלי הורדה)
let _previewBlobUrl = null;
window.previewDoc = async (url) => {
  if (!url) return;
  let m = document.getElementById('docPreview');
  if (!m) { m = document.createElement('div'); m.id = 'docPreview'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const shell = (inner) => `<div class="modal-card" style="width:min(920px,95vw);height:90vh;padding:0;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)">
      <b>תצוגה מקדימה של המסמך</b>
      <div style="display:flex;gap:8px;align-items:center">
        <a href="${url}" target="_blank" class="btn ghost" style="padding:6px 13px;text-decoration:none">הורדה ↓</a>
        <button class="btn primary" style="padding:6px 13px" onclick="closePreview()">סגור</button>
      </div>
    </div>${inner}</div>`;
  m.innerHTML = shell(`<div class="empty" style="flex:1;display:flex;align-items:center;justify-content:center">טוען מסמך…</div>`);
  m.onclick = (e) => { if (e.target === m) closePreview(); };
  try {
    const r = await fetch(url);
    const buf = await r.arrayBuffer();
    if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
    _previewBlobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    const cur = document.getElementById('docPreview');
    if (cur && !cur.classList.contains('hidden')) cur.innerHTML = shell(`<iframe src="${_previewBlobUrl}#toolbar=1" style="flex:1;width:100%;border:none;background:#fff"></iframe>`);
  } catch (e) {
    const cur = document.getElementById('docPreview');
    if (cur) cur.innerHTML = shell(`<div class="empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px"><div>לא ניתן להציג את המסמך כאן.</div><a href="${url}" target="_blank" class="btn primary" style="text-decoration:none">פתח בכרטיסייה חדשה ↗</a></div>`);
  }
};
window.closePreview = () => {
  const m = document.getElementById('docPreview'); if (m) m.classList.add('hidden');
  if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
};

// טבלת מסמכים משותפת (עם פירוק מע"מ). opts.showClient מוסיף עמודת לקוח.
function docsTable(docs, opts = {}) {
  if (docs && docs.error) return `<div class="warn-banner">${docs.error}</div>`;
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return `<div class="empty">אין מסמכים.</div>`;
  const totalInc = rows.reduce((s, d) => s + (Number(d.amountIncVat) || 0), 0);
  const totalEx = rows.reduce((s, d) => s + (Number(d.amountExVat) || 0), 0);
  const cc = opts.showClient;
  const s = opts.sort;
  const th = (key, label) => {
    if (!opts.onSort || !key) return `<th>${label}</th>`;
    const on = s && s.key === key;
    const arw = on ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕';
    return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="${opts.onSort}('${key}')">${label}<span class="muted" style="font-size:11px">${arw}</span></th>`;
  };
  return `<table><thead><tr>${th('date', 'תאריך')}${cc ? th('client', 'לקוח') : ''}${th('type', 'סוג')}${th('number', 'מספר')}${th('amount', 'סכום ללא מע"מ')}${th('amount', 'סכום כולל מע"מ')}<th></th></tr></thead>
    <tbody>${rows.map(d => `<tr>
      <td>${fmtDate(d.date)}</td>${cc ? `<td>${d.clientName || '—'}</td>` : ''}
      <td>${DOC_TYPE_NAMES[d.type] || `סוג ${d.type}`}</td>
      <td>${d.number ?? '—'}</td>
      <td>${money(d.amountExVat)}</td>
      <td>${money(d.amountIncVat)}</td>
      <td>${d.url ? `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end"><button class="btn ghost" style="padding:5px 11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button><a href="${d.url}" target="_blank" class="muted" style="white-space:nowrap">הורדה ↓</a></div>` : ''}</td>
    </tr>`).join('')}
    <tr style="background:var(--panel2)"><td colspan="${cc ? 4 : 3}"><b>סה"כ</b></td><td><b>${money(totalEx)}</b></td><td><b>${money(totalInc)}</b></td><td></td></tr>
    </tbody></table>`;
}

async function renderHome(c) {
  initPeriod();
  c.innerHTML = `<div class="panel"><div class="empty">טוען נתונים מחשבונית ירוקה…</div></div>`;
  const d = await api(`/api/dashboard?companyId=${state.company}&${periodQuery()}`);
  const label = periodLabel();
  const err = d.errors || {};
  const kpi = (lbl, val, sub, color) => `<div class="card"><div class="label">${lbl}</div><div class="big" style="color:${color || 'var(--text)'}">${val}</div>${sub ? `<div class="muted" style="font-size:12px;margin-top:5px">${sub}</div>` : ''}</div>`;
  const otherErrs = Object.keys(err).filter(k => k !== 'greenInvoice').map(k => err[k]);
  const docs = d.docs || [];
  const incomeLabel = state.period === 'month' ? 'הכנסה החודש' : 'הכנסה בתקופה';
  c.innerHTML = `
    <div class="panel">
      <div class="row-between">
        <div><h2>דף הבית — ${label}</h2><span class="muted">נתונים חיים מחשבונית ירוקה</span></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${docTypeSelect()}${periodControls()}</div>
      </div>
      ${err.greenInvoice ? `<div class="warn-banner">חשבונית ירוקה לא מחוברת — חבר אותה בלשונית 🔌 חיבורים כדי לראות נתונים.</div>` : ''}
      <div class="cards" style="margin-top:14px">
        ${kpi(incomeLabel, money(d.income), d.monthDocs != null ? `${d.monthDocs} מסמכים` : '', 'var(--accent2)')}
        ${kpi('צפי מע"מ (18%)', money(d.vat), 'מתוך ההכנסה', 'var(--warn)')}
        ${kpi('חשבוניות מס פתוחות', d.openInvoices != null ? d.openInvoices : '—', 'טרם שולמו במלואן', 'var(--danger)')}
        ${kpi('יתרת עו"ש', '—', 'יש לחבר חשבון בנק', 'var(--muted)')}
      </div>
      ${otherErrs.length ? `<div class="warn-banner" style="margin-top:12px">חלק מהנתונים לא נטענו: ${otherErrs.join(' | ')}</div>` : ''}
    </div>
    ${state.period !== 'month' ? `<div class="panel">
      <div class="row-between"><h2>פירוט לפי חודש</h2><span class="muted">${label}</span></div>
      ${monthlyBreakdown(docs)}
    </div>` : ''}
    <div class="panel">
      <div class="row-between"><h2>מסמכים — ${label}</h2><span class="muted">${docs.length} מסמכים · סה"כ ${money(d.income)}</span></div>
      ${docsTable(docs, { showClient: true })}
    </div>`;
}

// פירוט הכנסה לפי חודש (לתצוגה שנתית / טווח)
function monthlyBreakdown(docs) {
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return `<div class="empty">אין נתונים.</div>`;
  const byMonth = {};
  for (const d of rows) {
    const key = (d.date || '').slice(0, 7); if (!key) continue;
    if (!byMonth[key]) byMonth[key] = { ex: 0, inc: 0, n: 0 };
    byMonth[key].ex += Number(d.amountExVat) || 0;
    byMonth[key].inc += Number(d.amountIncVat) || 0;
    byMonth[key].n++;
  }
  const keys = Object.keys(byMonth).sort();
  if (!keys.length) return `<div class="empty">אין נתונים.</div>`;
  const tEx = keys.reduce((s, k) => s + byMonth[k].ex, 0);
  const tInc = keys.reduce((s, k) => s + byMonth[k].inc, 0);
  const tN = keys.reduce((s, k) => s + byMonth[k].n, 0);
  const mName = (k) => { const [y, m] = k.split('-').map(Number); return `${MONTHS_FULL[m - 1]} ${y}`; };
  return `<table><thead><tr><th>חודש</th><th>מסמכים</th><th>סכום ללא מע"מ</th><th>סכום כולל מע"מ</th></tr></thead><tbody>
    ${keys.map(k => `<tr><td>${mName(k)}</td><td>${byMonth[k].n}</td><td>${money(byMonth[k].ex)}</td><td>${money(byMonth[k].inc)}</td></tr>`).join('')}
    <tr style="background:var(--panel2)"><td><b>סה"כ</b></td><td><b>${tN}</b></td><td><b>${money(tEx)}</b></td><td><b>${money(tInc)}</b></td></tr>
  </tbody></table>`;
}

// ---- לקוחות (רשימה עם חיפוש; לחיצה מציגה את כל מסמכי הלקוח) ----
const DOC_TYPE_NAMES = { 10: 'חשבון עסקה', 20: 'הזמנה', 100: 'חשבון', 300: 'הצעת מחיר', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 330: 'חשבונית זיכוי', 400: 'קבלה', 405: 'קבלה על תרומה' };
async function renderClients(c) {
  if (!state.clientsList) {
    c.innerHTML = `<div class="panel"><div class="empty">טוען לקוחות…</div></div>`;
    const list = await api(`/api/clients`);
    state.clientsList = Array.isArray(list) ? list : [];
  }
  c.innerHTML = `<div class="panel">
    <div class="row-between"><div><h2>לקוחות</h2><span class="muted">${state.clientsList.length} לקוחות</span></div></div>
    <div style="display:flex;gap:16px;align-items:stretch;min-height:64vh">
      <div style="flex:0 0 300px;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;overflow:hidden">
        <input id="clientSearch" placeholder="חיפוש לקוח…" style="border:none;border-bottom:1px solid var(--line);border-radius:0"/>
        <div id="clientsList" style="overflow-y:auto;flex:1;max-height:70vh">${clientRows(state.clientsList)}</div>
      </div>
      <div id="clientDetail" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;padding:18px;overflow:auto;max-height:70vh">
        <div class="empty">בחר לקוח כדי לראות את כל המסמכים שלו</div>
      </div>
    </div>
  </div>`;
  const inp = $('#clientSearch');
  inp.oninput = () => { $('#clientsList').innerHTML = clientRows((state.clientsList || []).filter(cl => !inp.value || (cl.name || '').includes(inp.value))); };
  inp.focus();
}
function clientRows(list) {
  if (!list.length) return `<div class="empty">לא נמצאו לקוחות.</div>`;
  return list.map(cl => `
    <div class="chat-item" id="cli-${cl.id}" style="margin:0;border-radius:0;border-bottom:1px solid var(--line)" onclick="selectClient('${cl.id}','${encodeURIComponent(cl.name || '')}')">
      <span style="font-size:15px">🏢</span><div style="font-weight:600;font-size:14px">${cl.name}</div>
      <span class="muted" style="margin-inline-start:auto;font-size:14px">‹</span>
    </div>`).join('');
}
let _clientDocs = [], _clientName = '', _clientSort = { key: 'date', dir: 'desc' }, _clientYear = 'all';
window.selectClient = async (id, name) => {
  name = decodeURIComponent(name);
  document.querySelectorAll('#clientsList .chat-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('cli-' + id); if (item) item.classList.add('active');
  const detail = document.getElementById('clientDetail');
  if (!detail) return;
  detail.innerHTML = `<div class="muted" style="font-size:13px">טוען מסמכים…</div>`;
  const docs = await api(`/api/clients/${id}/documents`);
  _clientDocs = Array.isArray(docs) ? docs : [];
  _clientName = name;
  _clientSort = { key: 'date', dir: 'desc' };
  _clientYear = 'all';
  renderClientDetail();
};
window.setClientYear = (v) => { _clientYear = v; renderClientDetail(); };
function sortClientDocs(docs, s) {
  const dir = s.dir === 'asc' ? 1 : -1;
  return [...docs].sort((a, b) => {
    let av, bv;
    if (s.key === 'number') { av = Number(a.number) || 0; bv = Number(b.number) || 0; }
    else if (s.key === 'amount') { av = Number(a.amountIncVat) || 0; bv = Number(b.amountIncVat) || 0; }
    else if (s.key === 'type') { av = Number(a.type) || 0; bv = Number(b.type) || 0; }
    else if (s.key === 'client') { av = a.clientName || ''; bv = b.clientName || ''; }
    else { av = a.date || ''; bv = b.date || ''; }
    if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
  });
}
function sortBar() {
  const btn = (key, label) => {
    const on = _clientSort.key === key;
    const arw = on ? (_clientSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<button class="btn ${on ? 'primary' : 'ghost'}" style="padding:5px 11px;font-size:13px" onclick="setClientSort('${key}')">${label}${arw}</button>`;
  };
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0"><span class="muted" style="font-size:13px">מיון:</span>${btn('date', 'תאריך')}${btn('number', 'מספר')}${btn('amount', 'סכום')}${btn('type', 'סוג')}</div>`;
}
window.setClientSort = (key) => {
  if (_clientSort.key === key) _clientSort.dir = _clientSort.dir === 'asc' ? 'desc' : 'asc';
  else _clientSort = { key, dir: key === 'date' || key === 'amount' || key === 'number' ? 'desc' : 'asc' };
  renderClientDetail();
};
function renderClientDetail() {
  const detail = document.getElementById('clientDetail');
  if (!detail) return;
  const years = [...new Set(_clientDocs.map(d => (d.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  let docs = _clientDocs;
  if (_clientYear !== 'all') docs = docs.filter(d => (d.date || '').slice(0, 4) === _clientYear);
  docs = sortClientDocs(docs, _clientSort);
  const yearSel = `<select onchange="setClientYear(this.value)" style="padding:6px 10px"><option value="all" ${_clientYear === 'all' ? 'selected' : ''}>כל השנים</option>${years.map(y => `<option value="${y}" ${_clientYear === y ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
  detail.innerHTML = `<div class="row-between"><h2 style="font-size:17px">${_clientName}</h2><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted" style="font-size:13px">שנה:</span>${yearSel}<span class="muted">${docs.length} מסמכים</span></div></div><div class="muted" style="font-size:12.5px;margin:8px 0 2px">לחיצה על כותרת מיינת לפיה (▲ עולה / ▼ יורד)</div>${docsTable(docs, { showClient: false, sort: _clientSort, onSort: 'setClientSort' })}`;
}

// ---- אירועים + אי-התאמות + יומן (לשונית אחת מאוחדת) ----
async function renderCombined(c) {
  const [events, m] = await Promise.all([
    api(`/api/events?companyId=${state.company}`),
    api(`/api/calendar/match?companyId=${state.company}`),
  ]);
  const misses = m.matched.filter(x => !x.calendar);
  c.innerHTML = `
    <div class="panel">
      <div class="row-between">
        <div><h2>אירועים</h2><span class="muted">${events.length} אירועים</span></div>
        <button class="btn primary" id="addEvent">+ הדבק הודעת ווטסאפ</button>
      </div>
      ${events.length ? `<table>
        <thead><tr><th>תאריך</th><th>זמר</th><th>מיקום</th><th>תמחור</th><th>עובדים</th><th>קבלנים</th><th>חיוב</th><th>איכות קליטה</th></tr></thead>
        <tbody>${events.map(rowEvent).join('')}</tbody></table>`
      : `<div class="empty">אין עדיין אירועים. לחץ "הדבק הודעת ווטסאפ" כדי לקלוט את הראשון.</div>`}
    </div>

    <div class="panel">
      <h2>אי-התאמות מול יומן גוגל</h2>
      <p class="muted">אירועים שנקלטו בווטסאפ אך חסרים ביומן (או להיפך). כאן נגדיר בהמשך את הטיפול בכל אחד.</p>
      <div class="cards" style="margin:14px 0">
        <div class="card"><div class="label">חסר ביומן (יש בווטסאפ)</div><div class="big" style="color:var(--danger)">${m.missingInCalendar.length}</div></div>
        <div class="card"><div class="label">חסר בווטסאפ (יש ביומן)</div><div class="big" style="color:var(--warn)">${m.missingInWhatsappCount ?? (m.missingInWhatsapp?.length || 0)}</div></div>
        <div class="card"><div class="label">הותאמו</div><div class="big" style="color:var(--accent2)">${m.matched.filter(x => x.calendar).length}</div></div>
      </div>
      ${misses.length ? `<table><thead><tr><th>תאריך</th><th>אירוע (ווטסאפ)</th><th>סטטוס</th></tr></thead>
      <tbody>${misses.map(x => `<tr>
        <td>${x.whatsapp.date || '—'}</td>
        <td>${x.whatsapp.artist || '—'} / ${x.whatsapp.location || ''}</td>
        <td><span class="tag miss">חסר ביומן</span></td>
      </tr>`).join('')}</tbody></table>`
      : `<div class="empty">אין אי-התאמות כרגע 👌</div>`}
    </div>

    <div class="panel" id="calWrap"><div class="empty">טוען יומן…</div></div>`;
  $('#addEvent').onclick = () => $('#ingestModal').classList.remove('hidden');
  renderCalView();
}

// ---- תצוגת יומן: שבועית (ברירת מחדל) או חודשית, עם מתג ----
const DAYS_FULL = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DAYS_HE = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => isoDate(new Date());

function viewToggle() {
  const week = state.calView !== 'month';
  return `<div style="display:flex;gap:3px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px">
    <button class="btn ${week ? 'primary' : 'ghost'}" style="padding:5px 13px" onclick="setCalView('week')">שבועי</button>
    <button class="btn ${!week ? 'primary' : 'ghost'}" style="padding:5px 13px" onclick="setCalView('month')">חודשי</button>
  </div>`;
}
function setCalView(v) { state.calView = v; renderCalView(); }
window.setCalView = setCalView;
function renderCalView() { (state.calView === 'month' ? renderMonthCalendar : renderWeekCalendar)(); }
function initWeek() {
  if (state.weekStart) return;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - t.getDay()); // חזרה ליום ראשון
  state.weekStart = isoDate(t);
}
function shiftWeek(delta) {
  const d = new Date(state.weekStart + 'T00:00:00');
  d.setDate(d.getDate() + delta * 7);
  state.weekStart = isoDate(d);
  renderWeekCalendar();
}
window.shiftWeek = shiftWeek;

async function renderWeekCalendar() {
  const wrap = $('#calWrap'); if (!wrap) return;
  initWeek();
  const start = new Date(state.weekStart + 'T00:00:00');
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const from = isoDate(days[0]), to = isoDate(days[6]);
  const data = await api(`/api/calendar/events?companyId=${state.company}&from=${from}&to=${to}`);
  const byDay = {};
  const add = (ev, cls) => { if (!ev.date) return; (byDay[ev.date] = byDay[ev.date] || []).push({ ...ev, cls }); };
  (data.calendar || []).forEach(e => add(e, 'cal'));
  (data.whatsapp || []).forEach(e => add(e, 'wa'));

  const today = todayIso();
  const cols = days.map((d, i) => {
    const iso = isoDate(d);
    const isToday = iso === today;
    const evs = byDay[iso] || [];
    const items = evs.length ? evs.map(e =>
      `<div style="font-size:12px;padding:4px 7px;margin-top:4px;border-radius:6px;line-height:1.3;background:${e.cls === 'wa' ? 'rgba(91,140,255,.22)' : 'rgba(56,211,159,.18)'};color:${e.cls === 'wa' ? '#bcd0ff' : '#7ff0cf'}">${e.title || 'אירוע'}${e.location ? `<div style="font-size:10px;opacity:.75">${e.location}</div>` : ''}</div>`).join('')
      : `<div class="muted" style="font-size:11px;margin-top:8px">—</div>`;
    return `<div style="border:${isToday ? '2px solid var(--accent)' : '1px solid var(--line)'};border-radius:10px;padding:9px;min-height:230px;background:${isToday ? 'rgba(91,140,255,.10)' : 'var(--panel2)'}">
      <div style="font-weight:600;font-size:13px;border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:2px">
        ${DAYS_FULL[i]} <span class="muted" style="font-weight:400">${d.getDate()}/${d.getMonth() + 1}</span>
        ${isToday ? '<span style="color:var(--accent);font-size:11px;font-weight:700">· היום</span>' : ''}
        ${evs.length ? `<span class="muted" style="font-size:11px">· ${evs.length}</span>` : ''}
      </div>${items}</div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="row-between" style="margin-bottom:12px">
      <h2>יומן שבועי — ${days[0].getDate()}/${days[0].getMonth() + 1} עד ${days[6].getDate()}/${days[6].getMonth() + 1}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${viewToggle()}
        <span style="font-size:12px" class="muted"><span style="color:#7ff0cf">●</span> יומן גוגל &nbsp; <span style="color:#bcd0ff">●</span> ווטסאפ</span>
        <button class="btn ghost" onclick="shiftWeek(-1)">שבוע קודם →</button>
        <button class="btn ghost" onclick="shiftWeek(1)">← שבוע הבא</button>
      </div>
    </div>
    ${data.calendarError ? `<div class="warn-banner">${data.calendarError}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px">${cols}</div>`;
}

// תצוגה חודשית (תמונה גדולה)
function shiftMonth(delta) {
  if (!state.calMonth) state.calMonth = new Date().toISOString().slice(0, 7);
  const [y, m] = state.calMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderMonthCalendar();
}
window.shiftMonth = shiftMonth;

async function renderMonthCalendar() {
  const wrap = $('#calWrap'); if (!wrap) return;
  if (!state.calMonth) state.calMonth = new Date().toISOString().slice(0, 7);
  const month = state.calMonth;
  const data = await api(`/api/calendar/events?companyId=${state.company}&month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startDow = new Date(y, m - 1, 1).getDay();
  const byDay = {};
  const add = (ev, cls) => { if (!ev.date) return; (byDay[ev.date] = byDay[ev.date] || []).push({ ...ev, cls }); };
  (data.calendar || []).forEach(e => add(e, 'cal'));
  (data.whatsapp || []).forEach(e => add(e, 'wa'));

  const today = todayIso();
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div style="min-height:88px"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${month}-${String(day).padStart(2, '0')}`;
    const isToday = iso === today;
    const evs = byDay[iso] || [];
    const items = evs.slice(0, 4).map(e =>
      `<div title="${(e.title || '').replace(/"/g, '')} ${e.location || ''}" style="font-size:11px;padding:1px 5px;margin-top:2px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:${e.cls === 'wa' ? 'rgba(91,140,255,.25)' : 'rgba(56,211,159,.2)'};color:${e.cls === 'wa' ? '#bcd0ff' : '#7ff0cf'}">${e.title || 'אירוע'}</div>`).join('');
    const more = evs.length > 4 ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">+${evs.length - 4} עוד</div>` : '';
    cells += `<div style="min-height:88px;border:${isToday ? '2px solid var(--accent)' : '1px solid var(--line)'};border-radius:8px;padding:5px;background:${isToday ? 'rgba(91,140,255,.10)' : (evs.length ? 'var(--panel2)' : 'transparent')}">
      <div style="font-size:12px;color:${isToday ? 'var(--accent)' : 'var(--muted)'};font-weight:${isToday ? '700' : '400'}">${day}${isToday ? ' • היום' : ''}</div>${items}${more}</div>`;
  }

  wrap.innerHTML = `
    <div class="row-between" style="margin-bottom:12px">
      <h2>יומן חודשי — ${MONTHS_HE[m - 1]} ${y}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${viewToggle()}
        <span style="font-size:12px" class="muted"><span style="color:#7ff0cf">●</span> יומן גוגל &nbsp; <span style="color:#bcd0ff">●</span> ווטסאפ</span>
        <button class="btn ghost" onclick="shiftMonth(-1)">חודש קודם →</button>
        <button class="btn ghost" onclick="shiftMonth(1)">← חודש הבא</button>
      </div>
    </div>
    ${data.calendarError ? `<div class="warn-banner">${data.calendarError}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">
      ${DAYS_HE.map(d => `<div style="text-align:center;color:var(--muted);font-size:12px;font-weight:600;padding-bottom:4px">${d}</div>`).join('')}
      ${cells}
    </div>`;
}
function rowEvent(e) {
  const miss = e.missingFields?.length ? `<span class="tag miss">חסר: ${e.missingFields.join(', ')}</span>` : `<span class="tag match">מלא</span>`;
  return `<tr>
    <td>${e.date || e.dateRaw || '—'}</td>
    <td>${e.artist || '—'}</td>
    <td>${e.location || '—'}</td>
    <td>${money(e.price)}</td>
    <td>${(e.employees || []).map(n => `<span class="chip">${n}</span>`).join('') || '—'}</td>
    <td>${(e.contractors || []).map(n => `<span class="chip">${n}</span>`).join('') || '—'}</td>
    <td><span class="tag ${e.invoiceStatus === 'invoiced' ? 'invoiced' : 'pending'}">${e.invoiceStatus === 'invoiced' ? 'חויב' : 'ממתין'}</span></td>
    <td>${miss}</td></tr>`;
}

// ---- יומן והתאמות (למעלה אי-התאמות, מתחת יומן) ----
async function renderCalendar(c) {
  const m = await api(`/api/calendar/match?companyId=${state.company}`);
  const misses = m.matched.filter(x => !x.calendar);
  c.innerHTML = `<div class="panel">
    <h2>אי-התאמות מול יומן גוגל</h2>
    <p class="muted">אירועים שנקלטו בווטסאפ אך חסרים ביומן (או להיפך). כאן נגדיר בהמשך את הטיפול בכל אחד.</p>
    <div class="cards" style="margin:14px 0">
      <div class="card"><div class="label">חסר ביומן (יש בווטסאפ)</div><div class="big" style="color:var(--danger)">${m.missingInCalendar.length}</div></div>
      <div class="card"><div class="label">חסר בווטסאפ (יש ביומן)</div><div class="big" style="color:var(--warn)">${m.missingInWhatsappCount ?? (m.missingInWhatsapp?.length || 0)}</div></div>
      <div class="card"><div class="label">הותאמו</div><div class="big" style="color:var(--accent2)">${m.matched.filter(x => x.calendar).length}</div></div>
    </div>
    ${misses.length ? `<table><thead><tr><th>תאריך</th><th>אירוע (ווטסאפ)</th><th>סטטוס</th></tr></thead>
    <tbody>${misses.map(x => `<tr>
      <td>${x.whatsapp.date || '—'}</td>
      <td>${x.whatsapp.artist || '—'} / ${x.whatsapp.location || ''}</td>
      <td><span class="tag miss">חסר ביומן</span></td>
    </tr>`).join('')}</tbody></table>`
    : `<div class="empty">אין אי-התאמות כרגע 👌</div>`}
  </div>
  <div class="panel" id="calWrap"><div class="empty">טוען יומן…</div></div>`;
  renderCalView();
}

// ---- חיוב ----
async function renderInvoicing(c) {
  const groups = await api(`/api/invoicing/pending?companyId=${state.company}`);
  c.innerHTML = `<div class="panel">
    <h2>חיוב לקוחות — חשבונית חודשית מקובצת</h2>
    <p class="muted">כל האירועים של אותו לקוח באותו חודש מקובצים לחשבונית אחת.</p>
    ${groups.length ? groups.map(g => `
      <div class="card" style="margin-top:12px">
        <div class="row-between" style="margin:0">
          <div><b>${g.client}</b> · חודש ${g.month} · ${g.events.length} אירועים</div>
          <div><span class="big">${money(g.total)}</span>
            <button class="btn success" onclick="createInvoice('${g.client}','${g.month}')">הפק חשבונית</button></div>
        </div>
      </div>`).join('') : `<div class="empty">אין אירועים ממתינים לחיוב.</div>`}
  </div>`;
}
window.createInvoice = async (client, month) => {
  const r = await fetch('/api/invoicing/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: state.company, client, month }) }).then(r => r.json());
  if (r.ok) { alert('חשבונית הופקה בהצלחה'); render(); }
  else alert('תצוגה מקדימה (חסרים מפתחות חשבונית ירוקה):\n' + JSON.stringify(r.preview || r.error, null, 2));
};

// ---- קבלנים ----
async function renderContractors(c) {
  const list = await api(`/api/contractors/payables?companyId=${state.company}`);
  c.innerHTML = `<div class="panel"><h2>קבלנים לתשלום</h2>
    <p class="muted">כמה אנחנו אמורים לשלם לכל קבלן, ולמעקב אחר חשבוניות שהם צריכים להוציא לנו.</p>
    ${list.length ? `<table><thead><tr><th>קבלן</th><th>מס' אירועים</th><th>סכום לתשלום</th></tr></thead>
      <tbody>${list.map(x => `<tr><td>${x.name}</td><td>${x.events.length}</td><td>${money(x.total)}</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">אין קבלנים משויכים עם סכומים עדיין. הוסף סכום לכל קבלן באירוע.</div>`}</div>`;
}

// ---- שכר ----
async function renderPayroll(c) {
  const month = new Date().toISOString().slice(0, 7);
  const list = await api(`/api/payroll?companyId=${state.company}&month=${month}`);
  c.innerHTML = `<div class="panel">
    <div class="warn-banner">מסך פנימי — נתוני שכר של עובד אינם נחשפים לעובדים אחרים.</div>
    <h2>שכר עובדים — ${month}</h2>
    ${list.length ? `<table><thead><tr><th>עובד</th><th>משמרות</th><th>בסיס</th><th>תוספת</th><th>סה"כ</th></tr></thead>
      <tbody>${list.map(e => `<tr><td>${e.name}</td><td>${e.shifts.length}</td><td>${money(e.base)}</td><td>${money(e.bonus)}</td><td><b>${money(e.total)}</b></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">אין נתוני שכר לחודש זה. שייך תעריף לכל עובד באירוע.</div>`}</div>`;
}

// ---- מרכז חיבורים ----
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const STATUS_META = {
  connected: { txt: 'מחובר', cls: 'match', dot: 'var(--accent2)' },
  error: { txt: 'שגיאת חיבור', cls: 'miss', dot: 'var(--danger)' },
  disconnected: { txt: 'לא מחובר', cls: 'pending', dot: 'var(--muted)' },
  soon: { txt: 'בקרוב', cls: 'pending', dot: 'var(--warn)' },
};

async function renderConnections(c) {
  const conns = await api('/api/connections');
  c.innerHTML = `<div class="panel">
    <div class="warn-banner">המפתחות נשמרים מקומית בלבד (קובץ .env אצלך) ולא נשלחים לשום מקום חיצוני. כל חיבור עובר אימות אמיתי מול השירות.</div>
    <h2>מרכז חיבורים</h2>
    <p class="muted">חבר כל שירות, וראה כאן מה מחובר ומתי התחבר.</p>
    <div style="display:grid;gap:14px;margin-top:14px">
      ${conns.map(connCard).join('')}
    </div>
  </div>`;
  conns.forEach(wireCard);
}

function connCard(x) {
  const m = STATUS_META[x.status] || STATUS_META.disconnected;
  const inputs = x.soon ? '' : (x.toggle
    ? `<label style="display:flex;gap:8px;align-items:center;margin-top:10px">
         <input type="checkbox" id="tg_${x.key}" ${x.toggleOn ? 'checked' : ''}/> הפעל גשר (דורש התקנה וסריקת QR)
       </label>`
    : x.fields.map(f => `
        <div style="margin-top:10px">
          <label class="muted" style="font-size:13px;display:block;margin-bottom:4px">${f.label} ${f.set ? `<span class="tag invoiced">מוגדר (${f.hint})</span>` : ''}</label>
          <input type="password" id="in_${x.key}_${f.env}" placeholder="${f.set ? 'השאר ריק כדי לא לשנות' : 'הדבק כאן'}" style="width:100%"/>
        </div>`).join(''));

  const actions = x.soon ? `<span class="muted">בפיתוח — שלב הבא</span>` : `
    <button class="btn primary" data-connect="${x.key}">${x.status === 'connected' ? 'עדכן וחבר מחדש' : 'חבר'}</button>
    ${x.status !== 'disconnected' ? `<button class="btn ghost" data-test="${x.key}">בדוק חיבור</button>` : ''}
    ${x.status === 'connected' || x.status === 'error' ? `<button class="btn ghost" data-disc="${x.key}">נתק</button>` : ''}
    <span class="muted" id="msg_${x.key}" style="margin-inline-start:8px"></span>`;

  return `<div class="card">
    <div class="row-between" style="margin:0">
      <div style="font-size:16px;font-weight:700">${x.icon} ${x.name}
        <span class="tag ${m.cls}" style="margin-inline-start:8px">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${m.dot};margin-inline-end:5px"></span>${m.txt}</span>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:4px">${x.help}</div>
    ${x.status === 'connected' ? `<div style="margin-top:8px;font-size:13px">🟢 התחבר: <b>${fmtTime(x.connectedAt)}</b> · בדיקה אחרונה: ${fmtTime(x.lastCheckedAt)}</div>` : ''}
    ${x.status === 'error' ? `<div style="margin-top:8px;font-size:13px;color:var(--danger)">שגיאה: ${x.message || ''} (נבדק ${fmtTime(x.lastCheckedAt)})</div>` : ''}
    ${inputs}
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${actions}</div>
  </div>`;
}

function wireCard(x) {
  if (x.soon) return;
  const msg = (t) => { const el = $(`#msg_${x.key}`); if (el) el.textContent = t; };
  const collect = () => {
    const values = {};
    if (x.toggle) values[x.toggle] = $(`#tg_${x.key}`).checked ? 'on' : 'off';
    else x.fields.forEach(f => { const v = $(`#in_${x.key}_${f.env}`).value.trim(); if (v) values[f.env] = v; });
    return values;
  };
  const post = async (path, extra) => {
    msg('בודק…');
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: x.key, ...extra }) }).then(r => r.json());
    await renderStatus();
    if (r.error) { msg('❌ ' + r.error); return; }
    renderConnections($('#content'));
  };
  const b = (sel, fn) => { const el = document.querySelector(sel); if (el) el.onclick = fn; };
  b(`[data-connect="${x.key}"]`, () => post('/api/connections/connect', { values: collect() }));
  b(`[data-test="${x.key}"]`, () => post('/api/connections/test', {}));
  b(`[data-disc="${x.key}"]`, () => { if (confirm('לנתק חיבור זה?')) post('/api/connections/disconnect', {}); });
}

// ---- הצוות (עובדים וירטואליים) + צ'אט ----
const escapeHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
window.openChat = (id) => { state.activeChat = id; renderTeam($('#content')); };

async function renderTeam(c) {
  const data = await api('/api/team');
  if (!state.activeChat) state.activeChat = 'group';
  const members = data.members || [];
  state.members = members;
  const item = (id, emoji, name, sub, active) => `
    <div class="chat-item ${active ? 'active' : ''}" onclick="openChat('${id}')">
      <span style="font-size:20px">${emoji}</span>
      <div style="min-width:0"><div style="font-weight:600">${name}</div><div class="muted" style="font-size:12px">${sub}</div></div>
    </div>`;
  const sidebar = `<div class="panel" style="width:250px;flex:none">
      <h2 style="margin-bottom:14px">הצוות</h2>
      ${item('group', '👥', 'כל הצוות', `${members.length} עובדים`, state.activeChat === 'group')}
      <div style="height:1px;background:var(--line);margin:8px 0"></div>
      ${members.map(m => item(m.id, m.emoji, m.name, m.role, state.activeChat === m.id)).join('')}
      <div style="height:1px;background:var(--line);margin:8px 0"></div>
      ${item('requests', '📋', 'בקשות פיתוח', 'המשימות שאספנו', state.activeChat === 'requests')}
    </div>`;
  let main;
  if (state.activeChat === 'requests') {
    main = `<div class="panel" style="flex:1;min-width:320px" id="requestsBody"><div class="empty">טוען…</div></div>`;
  } else {
    const activeName = state.activeChat === 'group' ? 'כל הצוות' : (members.find(m => m.id === state.activeChat)?.name || '');
    const notice = data.configured ? '' : `<div class="warn-banner">כדי שהצוות יענה צריך מפתח AI. הכי קל וחינמי: מפתח Google Gemini — הוסף <b>GEMINI_API_KEY</b> כמשתנה סביבה ב-Render (משיגים חינם ב-aistudio.google.com/apikey).</div>`;
    main = `<div class="panel" style="flex:1;min-width:320px;display:flex;flex-direction:column;height:600px">
      <div class="row-between" style="margin-bottom:12px"><h2>${activeName}</h2>
        ${data.configured ? `<button class="btn ghost" style="padding:6px 12px" onclick="summarizeRequest(this)">📋 סכם כבקשת פיתוח</button>` : ''}
      </div>
      ${notice}
      <div id="chatMsgs" style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:4px"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <input id="chatInput" placeholder="כתוב הודעה..." style="flex:1" ${data.configured ? '' : 'disabled'} onkeydown="if(event.key==='Enter')sendChat()"/>
        <button class="btn primary" onclick="sendChat()" ${data.configured ? '' : 'disabled'}>שלח</button>
      </div>
    </div>`;
  }
  c.innerHTML = `<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">${sidebar}${main}</div>`;
  if (state.activeChat === 'requests') renderRequestsBody($('#requestsBody'));
  else loadChat();
}

async function loadChat() {
  const msgs = await api(`/api/team/${state.activeChat}/messages`);
  renderMsgs(msgs);
}

function bubble(m) {
  const mine = m.role === 'user';
  // בצ'אט אישי אין name בהודעה — נשלים משם החבר הפעיל (תקף גם לעובדים עתידיים)
  const mem = (state.members || []).find(x => x.id === state.activeChat);
  const who = mine ? 'אתה' : `${m.emoji || mem?.emoji || '🤖'} ${m.name || mem?.name || 'עוזר'}`;
  return `<div style="align-self:${mine ? 'flex-start' : 'flex-end'};max-width:80%;background:${mine ? 'var(--panel2)' : 'var(--grad-soft)'};border:1px solid var(--line);border-radius:14px;padding:10px 14px">
    <div class="muted" style="font-size:11px;margin-bottom:4px">${who}</div>
    <div style="white-space:pre-wrap;line-height:1.55">${escapeHtml(m.content)}</div></div>`;
}
function renderMsgs(msgs, typing) {
  const box = $('#chatMsgs'); if (!box) return;
  const list = (msgs || []).map(bubble).join('');
  const typingBubble = typing ? `<div style="align-self:flex-end;background:var(--grad-soft);border:1px solid var(--line);border-radius:14px;padding:10px 14px" class="muted">כותב…</div>` : '';
  box.innerHTML = (list || (typing ? '' : `<div class="empty">התחל שיחה 👋</div>`)) + typingBubble;
  box.scrollTop = box.scrollHeight;
}

window.sendChat = async () => {
  const inp = $('#chatInput'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  inp.value = ''; inp.disabled = true;
  const existing = await api(`/api/team/${state.activeChat}/messages`);
  renderMsgs([...existing, { role: 'user', content: text }], true);
  const r = await fetch(`/api/team/${state.activeChat}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }).then(r => r.json());
  inp.disabled = false;
  renderMsgs(r.messages || existing);
  if (r.error) { const b = $('#chatMsgs'); if (b) b.innerHTML += `<div class="warn-banner">${r.error}</div>`; }
  inp.focus();
};

// ---- בקשות פיתוח (בתוך אזור הצוות) ----
window.summarizeRequest = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'מסכם…'; }
  const r = await fetch(`/api/team/${state.activeChat}/summarize-request`, { method: 'POST' }).then(x => x.json());
  if (r.error) { if (btn) { btn.disabled = false; btn.textContent = '📋 סכם כבקשת פיתוח'; } alert(r.error); return; }
  state.activeChat = 'requests';
  renderTeam($('#content'));
};

const REQ_STATUS = { open: { t: 'פתוח', cls: 'pending' }, 'in-progress': { t: 'בעבודה', cls: 'invoiced' }, done: { t: 'הושלם', cls: 'match' } };
const REQ_PRIORITY = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };

async function renderRequestsBody(box) {
  if (!box) return;
  const list = await api('/api/requests');
  const open = list.filter(r => r.status !== 'done').length;
  box.innerHTML = `<div class="row-between"><div><h2>📋 בקשות פיתוח</h2><span class="muted">${list.length} בקשות · ${open} פתוחות</span></div></div>
    <p class="muted" style="font-size:13px;margin-top:4px">בצ'אט עם הצוות, אחרי שסיכמתם מה צריך — לחץ "📋 סכם כבקשת פיתוח" והבקשה תופיע כאן.</p>
    <div style="margin-top:14px">${list.length ? list.map(reqCard).join('') : `<div class="empty">אין בקשות עדיין.</div>`}</div>`;
}
function reqCard(r) {
  const s = REQ_STATUS[r.status] || REQ_STATUS.open;
  const sbtn = (st, label) => `<button class="btn ${r.status === st ? 'primary' : 'ghost'}" style="padding:5px 11px;font-size:13px" onclick="setReqStatus('${r.id}','${st}')">${label}</button>`;
  return `<div class="card" style="margin-bottom:12px">
    <div class="row-between" style="margin:0">
      <div style="font-weight:700;font-size:15px">${escapeHtml(r.title)}</div>
      <span class="tag ${s.cls}">${s.t}</span>
    </div>
    <div class="muted" style="font-size:12px;margin-top:3px">${escapeHtml(r.memberName || '')} · ${fmtTime(r.createdAt)} · עדיפות ${REQ_PRIORITY[r.priority] || ''}</div>
    ${r.summary ? `<div style="margin-top:8px;line-height:1.5">${escapeHtml(r.summary)}</div>` : ''}
    ${(r.details && r.details.length) ? `<ul style="margin:8px 0 0;padding-inline-start:18px;line-height:1.6">${r.details.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${sbtn('open', 'פתוח')}${sbtn('in-progress', 'בעבודה')}${sbtn('done', 'הושלם')}
      <button class="btn ghost" style="padding:5px 11px;font-size:13px;margin-inline-start:auto;color:var(--danger)" onclick="deleteReq('${r.id}')">מחק</button>
    </div>
  </div>`;
}
window.setReqStatus = async (id, status) => {
  await fetch(`/api/requests/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  renderRequestsBody($('#requestsBody'));
};
window.deleteReq = async (id) => {
  if (!confirm('למחוק את הבקשה?')) return;
  await fetch(`/api/requests/${id}`, { method: 'DELETE' });
  renderRequestsBody($('#requestsBody'));
};

// ---- בנק: התאמת תנועות לחשבוניות ----
const BANK_META = { auto: { t: 'הותאם אוטומטית', cls: 'invoiced' }, manual: { t: 'אושר', cls: 'match' }, unmatched: { t: 'ממתין לאישור', cls: 'pending' }, ignored: { t: 'ללא התאמה', cls: 'miss' } };

const BANK_SORT = {
  date: t => (t.date || '').split('/').reverse().join(''),
  amount: t => t.absAmount || 0,
  name: t => (t.nameHint || t.description || ''),
  status: t => ({ unmatched: 0, auto: 1, manual: 2, ignored: 3, skip: 9 }[t.matchStatus] ?? 5),
};
function sortBankRows(rows) {
  const s = state.bankSort || { key: 'date', dir: 'desc' };
  const f = BANK_SORT[s.key] || BANK_SORT.date;
  const dir = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => { const av = f(a), bv = f(b); return av < bv ? -dir : av > bv ? dir : 0; });
}
window.setBankSort = (key) => {
  const s = state.bankSort || { key: 'date', dir: 'desc' };
  if (s.key === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc'; else { s.key = key; s.dir = 'asc'; }
  state.bankSort = s; renderBank($('#content'));
};

const DOC_TYPE_SHORT = { 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 300: 'הצעת מחיר', 330: 'זיכוי', 10: 'חשבון עסקה' };
let _bankList = [];

function bankPeriodMatch(t) {
  const per = state.bankPer || { mode: 'all' };
  if (per.mode === 'all') return true;
  const m = (t.date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); if (!m) return false;
  const y = +m[3], mo = +m[2], key = `${m[3]}${m[2]}`;
  if (per.mode === 'month') { const [py, pm] = (per.month || '').split('-').map(Number); return y === py && mo === pm; }
  if (per.mode === 'year') { return y === +per.year; }
  if (per.mode === 'range') { const f = (per.from || '').replace('-', ''), tt = (per.to || '').replace('-', ''); return key >= f && key <= tt; }
  return true;
}
window.setBankFilter = (f) => { state.bankFilter = f; renderBank($('#content')); };
window.setBankPerMode = (mode) => {
  const p = state.bankPer || (state.bankPer = {});
  p.mode = mode; const now = new Date();
  if (mode === 'month' && !p.month) p.month = now.toISOString().slice(0, 7);
  if (mode === 'year' && !p.year) p.year = now.getFullYear();
  if (mode === 'range') { if (!p.from) p.from = now.toISOString().slice(0, 7); if (!p.to) p.to = p.from; }
  renderBank($('#content'));
};
window.setBankPerPart = (field, part, val) => {
  const p = state.bankPer; if (!p) return;
  if (field === 'year') { p.year = +val; }
  else { let [y, mo] = (p[field] || '').split('-').map(Number); if (part === 'm') mo = +val; else y = +val; p[field] = `${y}-${String(mo).padStart(2, '0')}`; }
  renderBank($('#content'));
};
function bankDirControls() {
  const d = state.bankFilter || 'credit';
  const seg = (v, l) => `<button class="btn ${d === v ? 'primary' : 'ghost'}" style="padding:6px 12px" onclick="setBankFilter('${v}')">${l}</button>`;
  return `<div style="display:flex;gap:3px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px">${seg('credit', 'רק זכות')}${seg('all', 'הכל')}${seg('debit', 'רק חובה')}</div>`;
}
function bankPeriodControls() {
  const p = state.bankPer || { mode: 'all' };
  const seg = (m, l) => `<button class="btn ${p.mode === m ? 'primary' : 'ghost'}" style="padding:6px 11px" onclick="setBankPerMode('${m}')">${l}</button>`;
  let extra = '';
  if (p.mode === 'month') { const [y, mo] = (p.month || '').split('-').map(Number); extra = `<select onchange="setBankPerPart('month','m',this.value)" style="padding:7px 10px">${monthOptions(mo)}</select><select onchange="setBankPerPart('month','y',this.value)" style="padding:7px 10px">${yearOptions(y)}</select>`; }
  else if (p.mode === 'year') { extra = `<select onchange="setBankPerPart('year','y',this.value)" style="padding:7px 10px">${yearOptions(+p.year)}</select>`; }
  else if (p.mode === 'range') { const [fy, fm] = (p.from || '').split('-').map(Number); const [ty, tm] = (p.to || '').split('-').map(Number); extra = `<span class="muted">מ־</span><select onchange="setBankPerPart('from','m',this.value)" style="padding:7px 8px">${monthOptions(fm)}</select><select onchange="setBankPerPart('from','y',this.value)" style="padding:7px 8px">${yearOptions(fy)}</select><span class="muted">עד</span><select onchange="setBankPerPart('to','m',this.value)" style="padding:7px 8px">${monthOptions(tm)}</select><select onchange="setBankPerPart('to','y',this.value)" style="padding:7px 8px">${yearOptions(ty)}</select>`; }
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><div style="display:flex;gap:3px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px">${seg('all', 'הכל')}${seg('month', 'חודשי')}${seg('year', 'שנתי')}${seg('range', 'טווח')}</div>${extra}</div>`;
}

function bankVisibleRows() {
  const dir = state.bankFilter || 'credit';
  let rows = (_bankList || []).filter(t => dir === 'all' ? true : dir === 'credit' ? t.direction === 'credit' : t.direction === 'debit');
  rows = rows.filter(bankPeriodMatch);
  return sortBankRows(rows);
}
function bankSummaryHtml(rows) {
  const dir = state.bankFilter || 'credit';
  const cr = rows.filter(t => t.direction === 'credit'), db = rows.filter(t => t.direction === 'debit');
  const sumCredit = cr.reduce((s, t) => s + (t.absAmount || 0), 0);
  const sumDebit = db.reduce((s, t) => s + (t.absAmount || 0), 0);
  const matchedCr = cr.filter(t => (t.matchedInvoices || []).length && (t.matchStatus === 'auto' || t.matchStatus === 'manual'));
  const invSum = (t) => (t.matchedInvoices || []).reduce((a, i) => a + (Number(i.amount) || 0), 0);
  const sumInv = matchedCr.reduce((s, t) => s + invSum(t), 0);
  const sumWh = matchedCr.reduce((s, t) => { const si = invSum(t), w = si - t.absAmount; return s + ((w > 1 && w < si * 0.08) ? w : 0); }, 0);
  const unmatched = cr.filter(t => t.matchStatus === 'unmatched').length;
  const stat = (label, val, color) => `<div class="card" style="padding:11px 14px"><div class="label" style="font-size:12px">${label}</div><div style="font-size:18px;font-weight:700;color:${color || 'var(--text)'}">${val}</div></div>`;
  return `${stat('שורות מוצגות', rows.length)}${stat('סה"כ זכות', money(sumCredit), 'var(--accent2)')}${dir !== 'credit' ? stat('סה"כ חובה', money(sumDebit), 'var(--danger)') : ''}${stat('סה"כ סכום חשבוניות', money(sumInv))}${stat('סה"כ ניכוי במקור', money(sumWh), 'var(--warn)')}${stat('שורות לא מותאמות', unmatched, unmatched ? 'var(--danger)' : 'var(--accent2)')}`;
}
function updateBankSummary() { const el = document.getElementById('bankSummary'); if (el) el.innerHTML = bankSummaryHtml(bankVisibleRows()); }
function updateBankRow(tx) { const el = document.getElementById('btr-' + tx.id); if (el) el.outerHTML = bankTr(tx); updateBankSummary(); }
function bankConfidence(t) {
  const mis = t.matchedInvoices || []; if (!mis.length) return null;
  const reasons = mis.flatMap(i => i.reasons || []);
  if (reasons.some(r => r.includes('מספר חשבונית')) || (reasons.some(r => r.includes('סכום זהה')) && reasons.some(r => r.includes('שם')))) return 'strong';
  return 'weak';
}
async function bankAction(id, body) {
  const r = await fetch(`/api/bank/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => null);
  const tx = r && r.tx;
  if (tx) { const i = _bankList.findIndex(t => t.id === id); if (i >= 0) _bankList[i] = tx; updateBankRow(tx); }
}
window.approveAllStrong = async (btn) => {
  const strong = bankVisibleRows().filter(t => t.matchStatus === 'auto' && bankConfidence(t) === 'strong');
  if (!strong.length) { alert('אין התאמות חזקות שממתינות לאישור בתצוגה הנוכחית.'); return; }
  if (!confirm(`לאשר ${strong.length} התאמות חזקות (מספר חשבונית / סכום+שם)?`)) return;
  if (btn) { btn.disabled = true; btn.textContent = 'מאשר…'; }
  for (const t of strong) {
    const r = await fetch(`/api/bank/${t.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchStatus: 'manual' }) }).then(x => x.json()).catch(() => null);
    if (r && r.tx) { const i = _bankList.findIndex(x => x.id === t.id); if (i >= 0) _bankList[i] = r.tx; }
  }
  const y = window.scrollY; await renderBank($('#content'), true); window.scrollTo(0, y);
};

async function renderBank(c, soft) {
  if (!soft) c.innerHTML = `<div class="panel"><div class="empty">טוען תנועות…</div></div>`;
  const all = await api(`/api/bank?companyId=${state.company}`);
  _bankList = all;
  const dir = state.bankFilter || 'credit';
  const rows = bankVisibleRows();
  const summary = `<div id="bankSummary" class="cards" style="grid-template-columns:repeat(auto-fit,minmax(125px,1fr));margin-top:12px;gap:12px">${bankSummaryHtml(rows)}</div>`;

  const bs = state.bankSort || { key: 'date', dir: 'desc' };
  const th = (key, label) => { const on = bs.key === key; const arw = on ? (bs.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'; return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="setBankSort('${key}')">${label}<span class="muted" style="font-size:11px">${arw}</span></th>`; };
  const p = (label) => `<th style="white-space:nowrap">${label}</th>`;
  const table = rows.length ? `<div style="overflow-x:auto;margin-top:14px"><table style="min-width:1120px;font-size:13px">
    <thead><tr>
      ${th('date', 'תאריך')}${th('amount', 'סכום בבנק')}${th('name', 'שם עסק')}
      ${p('חשבונית מס / מס-קבלה')}${p('קבלה')}${p('סכום חשבונית')}${p('ניכוי במקור')}${p('תצוגה')}${p('הורדה')}${p('הערות')}${p('אישור')}
    </tr></thead><tbody>${rows.map(bankTr).join('')}</tbody></table></div>`
    : `<div class="empty" style="margin-top:14px">אין תנועות בתצוגה הנוכחית.</div>`;
  c.innerHTML = `<div class="panel">
    <div class="row-between">
      <div><h2>🏦 בנק — התאמה לחשבוניות</h2><span class="muted">התאמת תנועות הבנק לחשבוניות ההכנסה מחשבונית ירוקה</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn success" onclick="approveAllStrong(this)">✓ אשר הכל החזקות</button>
        <button class="btn primary" onclick="openBankImport()">ייבא תנועות</button>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">${bankDirControls()}${bankPeriodControls()}</div>
    ${summary}
    <p class="muted" style="font-size:12.5px;margin-top:10px">שורות אדומות = לא מותאמות · תגית ירוקה "בטוח" = התאמה חזקה, צהובה "לבדיקה" = כדאי לוודא · 🔗 שייך לשיוך ידני.</p>
    ${table}
  </div>`;
}
function bankTr(t) {
  const credit = t.direction === 'credit';
  const amt = `${credit ? '+' : '−'}${money(t.absAmount)}`;
  const esc = (u) => String(u).replace(/'/g, '%27');
  const mis = t.matchedInvoices || [];
  const isMatched = credit && mis.length && (t.matchStatus === 'auto' || t.matchStatus === 'manual');
  const notesInput = `<input value="${(t.notes || '').replace(/"/g, '&quot;')}" placeholder="הערה…" onchange="saveBankNotes('${t.id}', this.value)" style="width:120px;padding:4px 7px;font-size:12px"/>`;
  const stack = (arr) => arr.map(x => `<div style="padding:2px 0${arr.length > 1 ? ';border-bottom:1px dashed var(--line)' : ''}">${x}</div>`).join('');
  let biz = '<span class="muted">—</span>', invNo = '—', recNo = '—', invAmt = '—', wh = '—', prev = '—', dl = '—', action = '';

  if (isMatched) {
    biz = stack(mis.map(i => `<b>${escapeHtml(i.clientName || '')}</b>`));
    invNo = stack(mis.map(i => `${DOC_TYPE_SHORT[i.type] || 'מסמך'} #${i.number}`));
    recNo = stack(mis.map(i => i.receipt ? `#${i.receipt.number}` : ((i.type == 320) ? '<span class="muted" style="font-size:11px">כלול בחשבונית</span>' : '—')));
    invAmt = stack(mis.map(i => money(i.amount)));
    const sumInv = mis.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const whAmt = sumInv - t.absAmount;
    wh = (whAmt > 1 && whAmt < sumInv * 0.08) ? `<span style="color:var(--warn)">${money(whAmt)}</span>` : '—';
    prev = stack(mis.map(i => `${i.url ? `<button class="btn ghost" style="padding:2px 7px;font-size:11px" onclick="previewDoc('${esc(i.url)}')">חשבונית</button>` : ''}${i.receipt && i.receipt.url ? ` <button class="btn ghost" style="padding:2px 7px;font-size:11px" onclick="previewDoc('${esc(i.receipt.url)}')">קבלה</button>` : ''}` || '—'));
    dl = stack(mis.map(i => `${i.url ? `<a href="${i.url}" target="_blank" class="muted" style="white-space:nowrap">חשבונית ↓</a>` : ''}${i.receipt && i.receipt.url ? `<br><a href="${i.receipt.url}" target="_blank" class="muted" style="white-space:nowrap">קבלה ↓</a>` : ''}` || '—'));
    const conf = bankConfidence(t);
    const confBadge = t.matchStatus === 'auto' && conf ? `<span class="tag ${conf === 'strong' ? 'match' : 'invoiced'}" style="font-size:10px;margin-inline-end:4px">${conf === 'strong' ? 'בטוח' : 'לבדיקה'}</span>` : (t.matchStatus === 'manual' ? '<span class="tag match" style="font-size:10px;margin-inline-end:4px">אושר</span>' : '');
    action = `${confBadge}${t.matchStatus === 'auto' ? `<button class="btn success" style="padding:3px 9px;font-size:12px" onclick="confirmBank('${t.id}')">אשר</button> ` : ''}<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="unmatchBank('${t.id}')">בטל</button>`;
  } else if (credit && t.matchStatus === 'ignored') {
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
    invNo = '<span class="muted">ללא התאמה</span>';
    action = `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="setBankIgnore('${t.id}',false)">החזר</button>`;
  } else if (credit) {
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
    const sugg = (t.suggestions || []).map(s => { const j = encodeURIComponent(JSON.stringify(s)); return `<button class="btn ghost" style="padding:2px 8px;font-size:11px" onclick="matchBank('${t.id}','${j}')">#${s.number} ${escapeHtml(s.clientName || '')} · ${money(s.amount)}</button>`; }).join(' ');
    invNo = `<span class="tag miss" style="font-size:10px">לא מותאם</span>${sugg ? `<div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;max-width:280px">${sugg}</div>` : ''}`;
    action = `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="setBankIgnore('${t.id}',true)">התעלם</button>`;
  } else {
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
  }

  const linkBtn = credit ? `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="openLinkModal('${t.id}')">🔗 שייך</button>` : '';
  const rowStyle = (credit && t.matchStatus === 'unmatched') ? 'background:rgba(251,92,125,.12);border-inline-start:3px solid var(--danger)' : (credit && t.matchStatus === 'ignored' ? 'opacity:.55' : '');
  return `<tr id="btr-${t.id}" style="${rowStyle}">
    <td style="white-space:nowrap">${t.date}</td>
    <td style="white-space:nowrap;color:${credit ? 'var(--accent2)' : 'var(--danger)'};font-weight:600">${amt}</td>
    <td>${biz}</td>
    <td>${invNo}</td>
    <td>${recNo}</td>
    <td style="white-space:nowrap">${invAmt}</td>
    <td style="white-space:nowrap">${wh}</td>
    <td>${prev}</td>
    <td>${dl}</td>
    <td>${notesInput}</td>
    <td style="white-space:nowrap"><div style="display:flex;gap:5px;flex-wrap:wrap">${action}${linkBtn}</div></td>
  </tr>`;
}
// כרטיס חשבונית בודדת בתא ההתאמה — שם עסק, סוג+מספר, סכום, קבלה נפרדת, תצוגה+הורדה
function invChip(inv) {
  const esc = (u) => String(u).replace(/'/g, '%27');
  const typeLabel = DOC_TYPE_NAMES[inv.type] || 'מסמך';
  const pv = inv.url ? `<button class="btn ghost" style="padding:2px 8px;font-size:11px" onclick="previewDoc('${esc(inv.url)}')">תצוגה 👁</button>` : '';
  const dl = inv.url ? `<a href="${inv.url}" target="_blank" class="muted" style="font-size:11px;white-space:nowrap">הורדה ↓</a>` : '';
  let receipt = '';
  if (inv.receipt) {
    const rpv = inv.receipt.url ? `<button class="btn ghost" style="padding:2px 7px;font-size:11px" onclick="previewDoc('${esc(inv.receipt.url)}')">👁</button>` : '';
    const rdl = inv.receipt.url ? `<a href="${inv.receipt.url}" target="_blank" class="muted" style="font-size:11px">↓</a>` : '';
    receipt = `<div class="muted" style="font-size:11px;margin-top:1px">🧾 קבלה #${inv.receipt.number} · ${money(inv.receipt.amount)} ${rpv} ${rdl}</div>`;
  }
  return `<div style="padding:4px 0;border-bottom:1px dashed var(--line)">
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">✓ <b>${escapeHtml(inv.clientName || '')}</b> · ${typeLabel} #${inv.number} · ${money(inv.amount)} ${pv} ${dl}</div>
    ${receipt}</div>`;
}
// פעולות מתעדכנות במקום (בלי לרנדר מחדש את כל הטבלה ובלי לקפוץ למעלה)
window.matchBank = (id, j) => bankAction(id, { matchStatus: 'manual', matchedInvoices: [JSON.parse(decodeURIComponent(j))] });
window.confirmBank = (id) => bankAction(id, { matchStatus: 'manual' });
window.unmatchBank = (id) => bankAction(id, { matchStatus: 'unmatched', matchedInvoices: [] });
window.setBankIgnore = (id, ig) => bankAction(id, { matchStatus: ig ? 'ignored' : 'unmatched' });
window.saveBankNotes = (id, val) => fetch(`/api/bank/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: val }) });

// ---- שיוך ידני של חשבונית/קבלה לתנועת בנק ----
let _linkTxId = null, _linkSel = [], _linkClients = null;
function linkSelHtml() {
  if (!_linkSel.length) return '<span class="muted">אין מסמכים מקושרים.</span>';
  return _linkSel.map((d, i) => `<div style="display:flex;gap:8px;align-items:center;font-size:13px;padding:3px 0">
    <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${money(d.amount)}</span>
    ${d.url ? `<button class="btn ghost" style="padding:1px 8px;font-size:12px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : ''}
    <button class="btn ghost" style="padding:1px 8px;font-size:12px" onclick="linkRemove(${i})">הסר ×</button></div>`).join('');
}
window.openLinkModal = async (txId) => {
  const tx = (_bankList || []).find(t => t.id === txId);
  _linkTxId = txId;
  _linkSel = tx ? JSON.parse(JSON.stringify(tx.matchedInvoices || [])) : [];
  let m = document.getElementById('linkModal');
  if (!m) { m = document.createElement('div'); m.id = 'linkModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(700px,95vw);max-height:88vh;overflow:auto">
    <h3>שיוך ידני של חשבונית / קבלה${tx ? ` — ${tx.date} · ${money(tx.absAmount)}` : ''}</h3>
    <div style="margin:8px 0;padding:8px 10px;background:var(--panel2);border-radius:10px"><b style="font-size:13px">מקושר כרגע:</b><div id="linkSelBox" style="margin-top:4px">${linkSelHtml()}</div></div>
    <label class="muted" style="font-size:13px">חפש לקוח כדי לראות את כל המסמכים שלו (חשבוניות וקבלות):</label>
    <input id="linkClientSearch" placeholder="שם לקוח…" style="width:100%;margin:6px 0" oninput="renderLinkClients(this.value)"/>
    <div id="linkClients" style="max-height:170px;overflow:auto"></div>
    <div id="linkDocs" style="margin-top:10px"></div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn ghost" onclick="document.getElementById('linkModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="linkSave()">שמור שיוך</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  if (!_linkClients) { const box = document.getElementById('linkClients'); if (box) box.innerHTML = '<span class="muted">טוען לקוחות…</span>'; _linkClients = await api('/api/clients'); }
  renderLinkClients('');
};
window.renderLinkClients = (q) => {
  const box = document.getElementById('linkClients'); if (!box) return;
  const list = (_linkClients || []).filter(c => !q || (c.name || '').includes(q)).slice(0, 40);
  box.innerHTML = list.length ? list.map(c => `<div class="chat-item" style="margin:0;padding:6px 10px" onclick="linkPickClient('${c.id}','${encodeURIComponent(c.name || '')}')">🏢 ${escapeHtml(c.name)}</div>`).join('') : '<span class="muted">אין תוצאות.</span>';
};
// מסמכים שכבר משויכים לתנועות אחרות (כדי לא להציע אותם שוב)
function linkedDocIds() {
  const ids = new Set(), recs = new Set();
  for (const t of (_bankList || [])) {
    for (const inv of (t.matchedInvoices || [])) {
      if (t.id !== _linkTxId) ids.add(inv.id);                 // תנועות אחרות חוסמות את המסמך
      if (inv.receipt && inv.receipt.number) recs.add(String(inv.receipt.number));
    }
  }
  for (const d of _linkSel) ids.add(d.id);                      // מה שכבר נבחר כאן
  return { ids, recs };
}
window.linkPickClient = async (id, name) => {
  const box = document.getElementById('linkDocs'); if (!box) return;
  box.innerHTML = '<div class="muted" style="font-size:13px">טוען מסמכים…</div>';
  const docs = await api(`/api/clients/${id}/documents`);
  const { ids, recs } = linkedDocIds();
  const allowed = [305, 320, 400];   // חשבונית מס, חשבונית מס-קבלה, קבלה בלבד
  const avail = (Array.isArray(docs) ? docs : []).filter(d =>
    allowed.includes(Number(d.type)) && !ids.has(d.id) && !(Number(d.type) === 400 && recs.has(String(d.number))));
  const rows = avail.map(d => {
    const j = encodeURIComponent(JSON.stringify({ id: d.id, number: d.number, type: d.type, clientName: d.clientName, amount: d.amountIncVat, date: d.date, url: d.url }));
    const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : '';
    const dl = d.url ? `<a href="${d.url}" target="_blank" class="muted" style="font-size:11px;white-space:nowrap">הורדה ↓</a>` : '';
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${fmtDate(d.date)} · ${money(d.amountIncVat)}</span>
      ${pv}${dl}<button class="btn primary" style="padding:2px 12px;font-size:11px" onclick="linkAdd('${j}')">הוסף</button></div>`;
  }).join('');
  box.innerHTML = `<b style="font-size:13px">מסמכים פנויים של ${decodeURIComponent(name)} (חשבונית מס / מס-קבלה / קבלה):</b>${rows || '<div class="muted" style="font-size:13px;margin-top:4px">אין מסמכים פנויים — כולם כבר משויכים לתנועות אחרות.</div>'}`;
};
window.linkAdd = (j) => { const d = JSON.parse(decodeURIComponent(j)); if (!_linkSel.find(x => x.id === d.id)) _linkSel.push(d); const b = document.getElementById('linkSelBox'); if (b) b.innerHTML = linkSelHtml(); };
window.linkRemove = (i) => { _linkSel.splice(i, 1); const b = document.getElementById('linkSelBox'); if (b) b.innerHTML = linkSelHtml(); };
window.linkSave = async () => {
  const r = await fetch(`/api/bank/${_linkTxId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchStatus: _linkSel.length ? 'manual' : 'unmatched', matchedInvoices: _linkSel }) }).then(x => x.json()).catch(() => null);
  const m = document.getElementById('linkModal'); if (m) m.classList.add('hidden');
  if (r && r.tx) { const i = _bankList.findIndex(t => t.id === _linkTxId); if (i >= 0) _bankList[i] = r.tx; updateBankRow(r.tx); }
};
window.openBankImport = () => {
  let m = document.getElementById('bankModal');
  if (!m) { m = document.createElement('div'); m.id = 'bankModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(640px,94vw)">
    <h3>ייבוא תנועות בנק</h3>
    <p class="muted" style="font-size:13px">שתי דרכים: להעלות את קובץ ה-Excel שהורדת ממזרחי (מהיר, כל התנועות), או להדביק ידנית מהתצוגה המפורטת באתר (מוסיף מספרי חשבונית).</p>
    <label class="btn ghost" style="display:inline-block;cursor:pointer;margin:6px 0">📄 העלה קובץ Excel (מזרחי)
      <input type="file" id="bankFile" accept=".xls,.xlsx,.csv,.htm,.html" style="display:none" onchange="bankFilePicked(this)"/>
    </label>
    <div class="muted" style="font-size:12px;margin:6px 0">— או —</div>
    <textarea id="bankText" rows="8" placeholder="הדבק כאן את התנועות מהאתר…" style="width:100%;margin:6px 0"></textarea>
    <div id="bankStatus" style="font-size:13px;margin-bottom:8px;min-height:18px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('bankModal').classList.add('hidden')">סגור</button>
      <button class="btn primary" id="bankImportBtn" onclick="doBankImport(this)">ייבא והתאם</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  setTimeout(() => { const ta = document.getElementById('bankText'); if (ta) ta.focus(); }, 50);
};
window.bankFilePicked = (input) => {
  const f = input.files && input.files[0]; if (!f) return;
  const status = document.getElementById('bankStatus');
  if (status) status.innerHTML = `<span class="muted">נבחר קובץ: ${f.name} — לחץ "ייבא והתאם".</span>`;
};
window.doBankImport = async (btn) => {
  const fileInput = document.getElementById('bankFile');
  const ta = document.getElementById('bankText');
  const status = document.getElementById('bankStatus');
  let text = '';
  if (fileInput && fileInput.files && fileInput.files[0]) { text = await fileInput.files[0].text(); }
  else { text = (ta?.value || '').trim(); }
  if (!text) { if (status) status.innerHTML = '<span style="color:var(--warn)">בחר קובץ או הדבק תנועות.</span>'; return; }
  btn.disabled = true; btn.textContent = 'מייבא ומתאים…';
  if (status) status.innerHTML = '<span class="muted">מייבא ומצליב מול חשבונית ירוקה… זה עשוי לקחת כמה שניות.</span>';
  try {
    const r = await fetch('/api/bank/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, companyId: state.company }) }).then(x => x.json());
    btn.disabled = false; btn.textContent = 'ייבא והתאם';
    if (r.error) { if (status) status.innerHTML = `<span style="color:var(--danger)">${r.error}</span>`; return; }
    if (status) status.innerHTML = `<span style="color:var(--accent2)">✓ נוספו ${r.added} תנועות · מתוך ${r.credits} זכות, ${r.autoMatched} הותאמו אוטומטית.</span>`;
    await renderBank($('#content'));
    setTimeout(() => { const mm = document.getElementById('bankModal'); if (mm) mm.classList.add('hidden'); }, 1400);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'ייבא והתאם';
    if (status) status.innerHTML = `<span style="color:var(--danger)">שגיאה: ${e.message}</span>`;
  }
};

// ---- מודל הדבקה ----
function setupModal() {
  $('#ingestCancel').onclick = () => $('#ingestModal').classList.add('hidden');
  $('#ingestSave').onclick = async () => {
    const text = $('#ingestText').value.trim();
    if (!text) return;
    await fetch('/api/events/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, companyId: state.company }) });
    $('#ingestText').value = ''; $('#ingestModal').classList.add('hidden');
    state.tab = 'events'; render();
  };
}

boot();
