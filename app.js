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
  ({ home: renderHome, events: renderCombined, clients: renderClients, invoicing: renderInvoicing, quotes: renderQuotes, team: renderTeam,
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
        ${kpi('חיובים פתוחים', d.openInvoices != null ? d.openInvoices : '—', 'חשבון עסקה + חשבונית מס', 'var(--danger)')}
        ${kpi('סכום מסמכים פתוחים', d.openInvoicesSum != null ? money(d.openInvoicesSum) : '—', 'סה"כ עסקה + מס פתוחים', 'var(--warn)')}
      </div>
      ${otherErrs.length ? `<div class="warn-banner" style="margin-top:12px">חלק מהנתונים לא נטענו: ${otherErrs.join(' | ')}</div>` : ''}
    </div>
    ${state.period !== 'month' ? `<div class="panel">
      <div class="row-between"><h2>פירוט לפי חודש</h2><span class="muted">${label}</span></div>
      ${monthlyBreakdown(docs)}
    </div>` : ''}
    <div class="panel" id="openInvWrap"><div class="empty">טוען חשבוניות פתוחות…</div></div>
    <div class="panel">
      <div class="row-between"><h2>מסמכים — ${label}</h2><span class="muted">${docs.length} מסמכים · סה"כ ${money(d.income)}</span></div>
      ${docsTable(docs, { showClient: true })}
    </div>`;
  loadOpenInvoices();
}

// ---- חשבוניות פתוחות בדף הבית (כמו "חיובים קרובים" בחשבונית ירוקה) ----
let _openInv = null, _openInvErr = null, _openInvFilter = 'all';
async function loadOpenInvoices() {
  const wrap = document.getElementById('openInvWrap'); if (!wrap) return;
  const r = await api('/api/open-invoices').catch(() => ({ docs: [], error: 'שגיאת טעינה' }));
  _openInv = r.docs || []; _openInvErr = r.error || null;
  renderOpenInvoices();
}
window.setOpenInvFilter = (v) => { _openInvFilter = v; renderOpenInvoices(); };
function renderOpenInvoices() {
  const wrap = document.getElementById('openInvWrap'); if (!wrap) return;
  const openAmt = (d) => (d.amountDue != null ? Number(d.amountDue) : Number(d.amount) || 0);
  const docs = (_openInv || []).filter(d => _openInvFilter === 'all' ? true
    : _openInvFilter === 'proforma' ? Number(d.type) === 300 : Number(d.type) === 305);
  const groups = {};
  for (const d of docs) { const k = d.clientName || '—'; (groups[k] = groups[k] || []).push(d); }
  const clients = Object.entries(groups)
    .map(([name, ds]) => ({ name, ds, total: ds.reduce((s, x) => s + openAmt(x), 0) }))
    .sort((a, b) => b.total - a.total);
  const totalAll = clients.reduce((s, c) => s + c.total, 0);
  const chip = (v, lbl) => `<button class="btn ${_openInvFilter === v ? 'primary' : 'ghost'}" style="padding:4px 12px;font-size:13px" onclick="setOpenInvFilter('${v}')">${lbl}</button>`;
  wrap.innerHTML = `
    <div class="row-between"><div><h2>חשבוניות פתוחות</h2>
      <span class="muted">${docs.length} מסמכים · ${money(totalAll)} · מקובץ לפי לקוח</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${chip('all', 'הכל')}${chip('proforma', 'חשבון עסקה')}${chip('invoice', 'חשבונית מס')}</div>
    </div>
    ${_openInvErr ? `<div class="warn-banner" style="margin-top:10px">${escapeHtml(_openInvErr)}</div>` : ''}
    ${clients.length ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">${clients.map(openInvClientHtml).join('')}</div>`
      : `<div class="empty">אין חשבוניות פתוחות 👌</div>`}`;
}
function openInvClientHtml(cl) {
  const rid = 'oig_' + Math.random().toString(36).slice(2, 8);
  const rows = cl.ds.map(d => `<div style="display:flex;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--line);font-size:13px">
    <span class="tag">${DOC_TYPE_SHORT[d.type] || 'מסמך'}</span>
    <span style="white-space:nowrap">#${d.number}</span><span class="muted" style="white-space:nowrap">${fmtDate(d.date)}</span>
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(d.description || '')}">${d.description ? escapeHtml(d.description) : '<span class="muted">—</span>'}</span>
    <span style="font-weight:600;white-space:nowrap">${money(d.amountDue != null ? d.amountDue : d.amount)}</span>
    ${d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>
    <a href="${d.url}" target="_blank" rel="noopener" class="btn ghost" style="padding:2px 9px;font-size:12px;text-decoration:none;white-space:nowrap">הורדה ↓</a>` : ''}
    ${FOLLOWUP_FOR[Number(d.type)]?.length ? `<button class="btn ghost" style="padding:2px 9px;font-size:12px;white-space:nowrap" onclick="openDerive('${d.id}','${escAttr(String(d.number))}',${Number(d.type)},'followup')">מסמך המשך ↪</button>` : ''}
    <button class="btn ghost" style="padding:2px 9px;font-size:12px;white-space:nowrap" onclick="openDerive('${d.id}','${escAttr(String(d.number))}',${Number(d.type)},'duplicate')">שכפול ⧉</button>
  </div>`).join('');
  return `<div class="card" style="padding:0;overflow:hidden">
    <div class="row-between" style="margin:0;padding:11px 13px;cursor:pointer" onclick="document.getElementById('${rid}').classList.toggle('hidden')">
      <div><b>${escapeHtml(cl.name)}</b> <span class="muted">· ${cl.ds.length} מסמכים</span></div>
      <div style="font-weight:700">${money(cl.total)}</div>
    </div>
    <div id="${rid}" class="${cl.ds.length > 1 ? 'hidden' : ''}">${rows}</div>
  </div>`;
}
// מסמכי המשך מותרים לפי סוג המקור: עסקה→מס/מס-קבלה ; מס→קבלה
const FOLLOWUP_FOR = { 300: [[305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה']], 305: [[400, 'קבלה']] };
// שכפול — אפשר לבחור כל סוג (כולל הצעת מחיר)
const DUPLICATE_TYPES = [[300, 'חשבון עסקה'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה'], [10, 'הצעת מחיר']];
window.openDerive = (id, number, srcType, mode) => {
  const followup = mode === 'followup';
  const opts = followup ? (FOLLOWUP_FOR[srcType] || []) : DUPLICATE_TYPES;
  let m = document.getElementById('derModal');
  if (!m) { m = document.createElement('div'); m.id = 'derModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const srcName = DOC_TYPE_SHORT[srcType] || 'מסמך';
  m.innerHTML = `<div class="modal-card" style="width:min(440px,94vw)">
    <h3>${followup ? 'מסמך המשך' : 'שכפול מסמך'} — ${srcName} #${escapeHtml(String(number))}</h3>
    <p class="muted" style="font-size:13px">${followup
      ? 'ייפתח עורך עם כל השורות לעריכה, בחירת תאריך ותקבולים. בחר סוג מסמך:'
      : 'שכפול (לא מקושר למקור) — ייפתח עורך שורות. בחר סוג מסמך:'}</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
      ${opts.map(([v, l]) => `<button class="btn ghost" style="justify-content:flex-start;text-align:right" onclick="openDeriveEditor('${id}',${v},${followup ? 'true' : 'false'})">${l} ←</button>`).join('')}
    </div>
    <div id="derStatus" style="font-size:13px;min-height:18px;margin-top:10px"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('derModal').classList.add('hidden')">ביטול</button></div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
};
window.doDerive = async (id, type, linked, btn) => {
  const st = document.getElementById('derStatus');
  const typeName = DOC_TYPE_SHORT[type] || 'מסמך';
  if (!confirm(`להפיק ${typeName}?\nהמסמך ייווצר בחשבונית ירוקה${linked ? ' ויקושר למקור' : ''} ולא ניתן למחיקה (רק לזכות).`)) return;
  [...document.querySelectorAll('#derModal button')].forEach(b => b.disabled = true);
  st.innerHTML = '<span class="muted">מפיק מסמך…</span>';
  const r = await fetch(`/api/documents/${id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, linked }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) {
    st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''}</span>`;
    setTimeout(() => { document.getElementById('derModal').classList.add('hidden'); loadOpenInvoices && loadOpenInvoices(); }, 1400);
  } else {
    [...document.querySelectorAll('#derModal button')].forEach(b => b.disabled = false);
    st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};

// ============ עורך מסמך המשך: שורות לעריכה + תאריך + תקבולים ============
// סוגי תקבול לפי חשבונית ירוקה: ניכוי מס במקור=0, מזומן=1, צ'ק=2, אשראי=3, העברה בנקאית=4
const DER_PAY_TYPES = [[4, 'העברה בנקאית'], [2, "צ'ק"], [0, 'ניכוי מס במקור'], [1, 'מזומן'], [3, 'כרטיס אשראי']];
const DER_PAYMENT_DOCS = new Set([320, 400]); // מסמכים שמחייבים תקבול (מס-קבלה / קבלה)
let _derEdit = null;
window.openDeriveEditor = async (id, type, linked) => {
  const m = document.getElementById('derModal') || (() => { const x = document.createElement('div'); x.id = 'derModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw)"><div class="empty">טוען שורות מהמסמך…</div></div>`;
  const r = await api(`/api/documents/${id}/lines`).catch(() => ({ error: 'שגיאת רשת' }));
  if (!r || !r.ok) { m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)"><div class="warn-banner">שגיאה בטעינת השורות: ${escapeHtml(String(r?.error || ''))}</div><div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('derModal').classList.add('hidden')">סגור</button></div></div>`; return; }
  const needsPay = DER_PAYMENT_DOCS.has(Number(type));
  _derEdit = {
    id, type: Number(type), linked: linked === true || linked === 'true',
    clientName: r.client?.name || '', date: todayIso(),
    description: r.description || '', remarks: r.remarks || '',
    items: (r.items || []).map(it => ({ description: it.description || '', quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })),
    payments: needsPay ? [{ type: 4, price: 0, date: todayIso(), chequeNum: '', bankName: '' }] : [],
    needsPay,
  };
  if (!_derEdit.items.length) _derEdit.items.push({ description: '', quantity: 1, price: 0 });
  renderDeriveEditor();
};
// סנכרון ערכי ה-DOM לתוך ה-state לפני רינדור מחדש
function derSyncFromDom() {
  const e = _derEdit; if (!e) return;
  document.querySelectorAll('#derModal .der-item').forEach((row, i) => {
    if (!e.items[i]) return;
    e.items[i].description = row.querySelector('.der-desc')?.value ?? e.items[i].description;
    e.items[i].quantity = row.querySelector('.der-qty')?.value ?? e.items[i].quantity;
    e.items[i].price = row.querySelector('.der-price')?.value ?? e.items[i].price;
  });
  document.querySelectorAll('#derModal .der-pay').forEach((row, i) => {
    if (!e.payments[i]) return;
    e.payments[i].type = Number(row.querySelector('.der-ptype')?.value ?? e.payments[i].type);
    e.payments[i].price = row.querySelector('.der-pprice')?.value ?? e.payments[i].price;
    e.payments[i].date = row.querySelector('.der-pdate')?.value ?? e.payments[i].date;
    e.payments[i].chequeNum = row.querySelector('.der-pcheque')?.value ?? e.payments[i].chequeNum;
    e.payments[i].bankName = row.querySelector('.der-pbank')?.value ?? e.payments[i].bankName;
  });
  const d = document.querySelector('#derModal .der-date'); if (d) e.date = d.value;
  const desc = document.querySelector('#derModal .der-descr'); if (desc) e.description = desc.value;
  const rem = document.querySelector('#derModal .der-rem'); if (rem) e.remarks = rem.value;
}
window.derAddItem = () => { derSyncFromDom(); _derEdit.items.push({ description: '', quantity: 1, price: 0 }); renderDeriveEditor(); };
window.derDelItem = (i) => { derSyncFromDom(); _derEdit.items.splice(i, 1); if (!_derEdit.items.length) _derEdit.items.push({ description: '', quantity: 1, price: 0 }); renderDeriveEditor(); };
window.derAddPay = () => { derSyncFromDom(); _derEdit.payments.push({ type: 4, price: 0, date: _derEdit.date, chequeNum: '', bankName: '' }); renderDeriveEditor(); };
window.derDelPay = (i) => { derSyncFromDom(); _derEdit.payments.splice(i, 1); renderDeriveEditor(); };
window.derPayTypeChanged = () => { derSyncFromDom(); renderDeriveEditor(); }; // מציג שדה צ'ק/בנק לפי הסוג
// מילוי אוטומטי של יתרת התקבול הראשון לפי סה"כ המסמך
window.derFillBalance = () => {
  derSyncFromDom();
  const t = derTotals();
  const others = _derEdit.payments.reduce((s, p, i) => i === 0 ? s : s + (Number(p.price) || 0), 0);
  if (_derEdit.payments[0]) _derEdit.payments[0].price = Math.max(0, +(t.total - others).toFixed(2));
  renderDeriveEditor();
};
function derTotals() {
  const sub = _derEdit.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);
  const vat = +(sub * VAT_RATE).toFixed(2);
  return { sub: +sub.toFixed(2), vat, total: +(sub + vat).toFixed(2) };
}
window.derRecalc = () => {
  // עדכון חי של הסכומים בלי רינדור מלא
  const e = _derEdit; if (!e) return;
  let sub = 0;
  document.querySelectorAll('#derModal .der-item').forEach(row => {
    sub += (Number(row.querySelector('.der-qty')?.value) || 0) * (Number(row.querySelector('.der-price')?.value) || 0);
  });
  const vat = sub * VAT_RATE, total = sub + vat;
  const box = document.getElementById('derTotals');
  if (box) box.innerHTML = `ביניים: <b>${money(sub)}</b> · מע"מ ${Math.round(VAT_RATE * 100)}%: <b>${money(vat)}</b> · סה"כ: <b style="color:var(--accent2)">${money(total)}</b>`;
  if (e.needsPay) {
    let psum = 0; document.querySelectorAll('#derModal .der-pprice').forEach(x => psum += Number(x.value) || 0);
    const ps = document.getElementById('derPaySum');
    if (ps) { const diff = +(total - psum).toFixed(2); ps.innerHTML = `סה"כ תקבולים: <b>${money(psum)}</b>${Math.abs(diff) > 0.01 ? ` · <span style="color:var(--danger)">חסר ${money(diff)}</span>` : ' · <span style="color:var(--accent2)">מאוזן ✓</span>'}`; }
  }
};
function renderDeriveEditor() {
  const e = _derEdit; if (!e) return;
  const t = derTotals();
  const typeName = DOC_TYPE_SHORT[e.type] || 'מסמך';
  const itemRows = e.items.map((it, i) => `<div class="der-item" style="display:grid;grid-template-columns:1fr 62px 96px 28px;gap:6px;align-items:center;margin-bottom:6px">
    <input class="der-desc" value="${escAttr(it.description)}" placeholder="תיאור" style="padding:6px 8px">
    <input class="der-qty" type="number" step="any" value="${it.quantity}" oninput="derRecalc()" style="padding:6px 6px;text-align:center" title="כמות">
    <input class="der-price" type="number" step="any" value="${it.price}" oninput="derRecalc()" style="padding:6px 6px;text-align:left" title="מחיר יחידה (ללא מע״מ)">
    <button class="btn ghost" style="padding:4px 8px;font-size:14px" onclick="derDelItem(${i})" title="מחק שורה">✕</button>
  </div>`).join('');
  const payRows = e.needsPay ? e.payments.map((p, i) => {
    const isCheque = Number(p.type) === 2, isBank = Number(p.type) === 4;
    return `<div class="der-pay" style="display:grid;grid-template-columns:1fr 96px 130px 28px;gap:6px;align-items:center;margin-bottom:6px">
      <select class="der-ptype" onchange="derPayTypeChanged()" style="padding:6px 6px">${DER_PAY_TYPES.map(([v, l]) => `<option value="${v}" ${Number(p.type) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="der-pprice" type="number" step="any" value="${p.price}" oninput="derRecalc()" style="padding:6px 6px;text-align:left" title="סכום">
      <input class="der-pdate" type="date" value="${(p.date || e.date || '').slice(0, 10)}" style="padding:6px 6px" title="תאריך תקבול">
      <button class="btn ghost" style="padding:4px 8px;font-size:14px" onclick="derDelPay(${i})" title="הסר תקבול">✕</button>
      ${isCheque ? `<input class="der-pcheque" value="${escAttr(p.chequeNum || '')}" placeholder="מספר צ'ק" style="grid-column:1/4;padding:6px 8px">` : ''}
      ${isBank ? `<input class="der-pbank" value="${escAttr(p.bankName || '')}" placeholder="שם בנק (לא חובה)" style="grid-column:1/4;padding:6px 8px">` : ''}
    </div>`;
  }).join('') : '';
  const m = document.getElementById('derModal');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw);max-height:92vh;overflow:auto">
    <div class="row-between"><h3>${e.linked ? 'מסמך המשך' : 'שכפול'} — ${typeName}</h3><span class="muted">${escapeHtml(e.clientName)}</span></div>

    <div style="display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 4px">
      <label style="font-size:13px">תאריך המסמך <input class="der-date" type="date" value="${e.date}" style="padding:6px 8px;margin-inline-start:6px"></label>
    </div>
    <label style="font-size:13px;display:block;margin-bottom:8px">נושא/כותרת <input class="der-descr" value="${escAttr(e.description)}" placeholder="נושא המסמך" style="width:100%;padding:6px 8px;margin-top:3px"></label>

    <div style="font-weight:600;font-size:13px;margin:8px 0 4px">שורות המסמך</div>
    <div style="display:grid;grid-template-columns:1fr 62px 96px 28px;gap:6px;font-size:11px;color:var(--muted);margin-bottom:3px"><span>תיאור</span><span style="text-align:center">כמות</span><span style="text-align:left">מחיר</span><span></span></div>
    <div id="derItems">${itemRows}</div>
    <button class="btn ghost" style="padding:4px 10px;font-size:12px;margin-top:2px" onclick="derAddItem()">+ הוסף שורה</button>
    <div id="derTotals" style="margin-top:10px;font-size:14px">ביניים: <b>${money(t.sub)}</b> · מע"מ ${Math.round(VAT_RATE * 100)}%: <b>${money(t.vat)}</b> · סה"כ: <b style="color:var(--accent2)">${money(t.total)}</b></div>

    ${e.needsPay ? `<div style="border-top:1px solid var(--line);margin-top:12px;padding-top:10px">
      <div class="row-between" style="margin-bottom:4px"><div style="font-weight:600;font-size:13px">תקבולים</div><button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="derFillBalance()">מלא יתרה בשורה 1</button></div>
      <p class="muted" style="font-size:11.5px;margin:0 0 6px">סכום התקבולים צריך להשתוות לסה"כ המסמך. ניכוי מס במקור מוזן כשורת תקבול נפרדת על סכום הניכוי.</p>
      <div style="display:grid;grid-template-columns:1fr 96px 130px 28px;gap:6px;font-size:11px;color:var(--muted);margin-bottom:3px"><span>סוג תקבול</span><span style="text-align:left">סכום</span><span>תאריך</span><span></span></div>
      <div id="derPays">${payRows}</div>
      <button class="btn ghost" style="padding:4px 10px;font-size:12px;margin-top:2px" onclick="derAddPay()">+ הוסף תקבול</button>
      <div id="derPaySum" style="margin-top:8px;font-size:13px"></div>
    </div>` : ''}

    <label style="font-size:13px;display:block;margin-top:10px">הערה בתחתית (לא חובה) <input class="der-rem" value="${escAttr(e.remarks)}" style="width:100%;padding:6px 8px;margin-top:3px"></label>

    <div id="derEditStatus" style="font-size:13px;min-height:18px;margin-top:10px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('derModal').classList.add('hidden')">ביטול</button>
      <button class="btn success" id="derConfirmBtn" onclick="derConfirm()">✓ הפק ${typeName}</button>
    </div>
  </div>`;
  m.onclick = (ev) => { if (ev.target === m) m.classList.add('hidden'); };
  derRecalc();
}
window.derConfirm = async () => {
  derSyncFromDom();
  const e = _derEdit; if (!e) return;
  const items = e.items.map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
  if (!items.length) { alert('יש להזין לפחות שורה אחת עם תיאור.'); return; }
  const t = derTotals();
  let payment = [];
  if (e.needsPay) {
    payment = e.payments.map(p => ({ type: Number(p.type), price: Number(p.price) || 0, date: (p.date || e.date), chequeNum: p.chequeNum || '', bankName: p.bankName || '' })).filter(p => Math.abs(p.price) > 0);
    const psum = payment.reduce((s, p) => s + p.price, 0);
    if (!payment.length) { alert('מסמך מסוג ' + (DOC_TYPE_SHORT[e.type] || '') + ' מחייב לפחות תקבול אחד.'); return; }
    if (Math.abs(psum - t.total) > 0.01 && !confirm(`סכום התקבולים (${money(psum)}) שונה מסה"כ המסמך (${money(t.total)}).\nלהמשיך בכל זאת?`)) return;
  }
  const typeName = DOC_TYPE_SHORT[e.type] || 'מסמך';
  if (!confirm(`להפיק ${typeName} על סך ${money(t.total)}?\nהמסמך ייווצר בחשבונית ירוקה${e.linked ? ' ויקושר למקור' : ''} ולא ניתן למחיקה (רק לזכות).`)) return;
  const btn = document.getElementById('derConfirmBtn'); if (btn) { btn.disabled = true; }
  const st = document.getElementById('derEditStatus'); if (st) st.innerHTML = '<span class="muted">מפיק מסמך…</span>';
  const r = await fetch(`/api/documents/${e.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: e.type, linked: e.linked, items, date: e.date, description: e.description, remarks: e.remarks, payment }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) {
    if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''}</span>`;
    setTimeout(() => { document.getElementById('derModal').classList.add('hidden'); loadOpenInvoices && loadOpenInvoices(); }, 1400);
  } else {
    if (btn) btn.disabled = false;
    if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};

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
const DOC_TYPE_NAMES = { 10: 'הצעת מחיר', 100: 'הזמנה', 200: 'תעודת משלוח', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 330: 'חשבונית זיכוי', 400: 'קבלה', 405: 'קבלה על תרומה' };
async function renderClients(c) {
  if (!state.clientsList) {
    c.innerHTML = `<div class="panel"><div class="empty">טוען לקוחות…</div></div>`;
    const list = await api(`/api/clients`);
    state.clientsList = Array.isArray(list) ? list : [];
  }
  c.innerHTML = `<div class="panel">
    <div class="row-between"><div><h2>לקוחות</h2><span class="muted">${state.clientsList.length} לקוחות</span></div>
      <button class="btn primary" onclick="openContactForm('client')">+ הוסף לקוח</button></div>
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
  const monthsSet = [...new Set(events.map(e => (e.date || e.dateRaw || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const filtered = _evMonthFilter === 'all' ? events : events.filter(e => (e.date || e.dateRaw || '').slice(0, 7) === _evMonthFilter);
  const pending = filtered.filter(e => !e.confirmed);
  const approved = filtered.filter(e => e.confirmed);
  const overdue = events.filter(isOverdueUnbilled).length;
  const monthSel = `<select onchange="setEvMonth(this.value)" style="padding:6px 10px"><option value="all" ${_evMonthFilter === 'all' ? 'selected' : ''}>כל החודשים</option>${monthsSet.map(k => `<option value="${k}" ${_evMonthFilter === k ? 'selected' : ''}>${monthKeyLabel(k)}</option>`).join('')}</select>`;
  // סינון לפי לקוח וקבלן — בחלק של האירועים המאושרים בלבד
  const approvedClients = [...new Set(approved.map(e => (e.clientName || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  const approvedContractors = [...new Set(approved.flatMap(e => (e.contractors || []).map(c => (c || '').trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'he'));
  if (_evClientFilter !== 'all' && !approvedClients.includes(_evClientFilter)) _evClientFilter = 'all';
  if (_evContractorFilter !== 'all' && !approvedContractors.includes(_evContractorFilter)) _evContractorFilter = 'all';
  let approvedShown = _evClientFilter === 'all' ? approved : approved.filter(e => (e.clientName || '').trim() === _evClientFilter);
  if (_evContractorFilter !== 'all') approvedShown = approvedShown.filter(e => (e.contractors || []).some(c => (c || '').trim() === _evContractorFilter));
  const anyApprovedFilter = _evClientFilter !== 'all' || _evContractorFilter !== 'all';
  const evClientSel = approvedClients.length ? `<select onchange="setEvClient(this.value)" style="padding:5px 10px;font-size:13px"><option value="all" ${_evClientFilter === 'all' ? 'selected' : ''}>כל הלקוחות</option>${approvedClients.map(cn => `<option value="${escAttr(cn)}" ${_evClientFilter === cn ? 'selected' : ''}>${escapeHtml(cn)}</option>`).join('')}</select>` : '';
  const evContractorSel = approvedContractors.length ? `<select onchange="setEvContractor(this.value)" style="padding:5px 10px;font-size:13px"><option value="all" ${_evContractorFilter === 'all' ? 'selected' : ''}>כל הקבלנים</option>${approvedContractors.map(cn => `<option value="${escAttr(cn)}" ${_evContractorFilter === cn ? 'selected' : ''}>${escapeHtml(cn)}</option>`).join('')}</select>` : '';
  c.innerHTML = `
    <div class="panel">
      <div class="row-between">
        <div><h2>אירועים</h2><span class="muted">${events.length} אירועים${overdue ? ` · <span style="color:var(--danger)">${overdue} ללא חשבונית מחודש שעבר</span>` : ''}</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span class="muted" style="font-size:13px">חודש:</span>${monthSel}
          <button class="btn primary" id="addEvent">+ הדבק הודעת ווטסאפ</button>
          <button class="btn ghost" id="addEventManual">+ הוסף אירוע</button>
        </div>
      </div>
      ${events.length ? `
        <h3 style="margin:16px 0 4px;font-size:15px">🕓 אירועים לאישור <span class="muted" style="font-weight:400;font-size:13px">· ${pending.length}</span></h3>
        ${pending.length ? eventsByMonthHtml(pending, 'pending') : `<div class="empty">אין אירועים הממתינים לאישור 👌</div>`}
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:22px 0 4px">
          <h3 style="margin:0;font-size:15px">✓ אירועים מאושרים <span class="muted" style="font-weight:400;font-size:13px">· ${approvedShown.length}${anyApprovedFilter ? ` מתוך ${approved.length}` : ''}</span></h3>
          ${approvedClients.length ? `<div style="display:flex;gap:6px;align-items:center"><span class="muted" style="font-size:13px">לקוח:</span>${evClientSel}</div>` : ''}
          ${approvedContractors.length ? `<div style="display:flex;gap:6px;align-items:center"><span class="muted" style="font-size:13px">קבלן:</span>${evContractorSel}</div>` : ''}
        </div>
        ${approvedShown.length ? eventsByMonthHtml(approvedShown, 'approved') : `<div class="empty">${_evClientFilter === 'all' ? 'עדיין אין אירועים מאושרים' : 'אין אירועים מאושרים ללקוח זה'}</div>`}`
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
      ${misses.length ? `<table><thead><tr><th>תאריך</th><th>אירוע (ווטסאפ)</th><th>סטטוס</th><th></th></tr></thead>
      <tbody>${misses.slice().sort((a, b) => (a.whatsapp.date || '').localeCompare(b.whatsapp.date || '')).map(x => `<tr>
        <td style="white-space:nowrap">${ddmy(x.whatsapp.date)}</td>
        <td>${x.whatsapp.artist || '—'}${x.whatsapp.location ? ` / ${x.whatsapp.location}` : ''}</td>
        <td><span class="tag miss">חסר ביומן</span></td>
        <td style="text-align:left"><button class="btn ghost" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="markMatched('${x.whatsapp.id}',this)">✓ סמן כהותאם</button></td>
      </tr>`).join('')}</tbody></table>`
      : `<div class="empty">אין אי-התאמות כרגע 👌</div>`}
    </div>

    <div class="panel" id="calWrap"><div class="empty">טוען יומן…</div></div>`;
  $('#addEvent').onclick = () => $('#ingestModal').classList.remove('hidden');
  $('#addEventManual').onclick = async () => {
    const ev = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: state.company, source: 'manual', date: todayIso() }) }).then(r => r.json()).catch(() => null);
    if (ev && ev.id) openEventEditor(ev);
  };
  renderCalView();
}

// תאריך בפורמט DD/MM/YY (למשל 09/07/26)
const ddmy = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : (iso || '—'); };
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
// ---- מקורות יומן: צבעים, מקרא וסינון (ווטסאפ + כל יומני גוגל) ----
const CAL_COLORS = [['var(--ev-cal-bg)', 'var(--ev-cal)'], ['#fce7f3', '#db2777'], ['#dcfce7', '#16a34a'], ['#fef9c3', '#ca8a04'], ['#e0f2fe', '#0284c7']];
const WA_COLOR = ['var(--ev-wa-bg)', 'var(--ev-wa)'];
function evSrcKey(e) { return (e.source === 'whatsapp' || e.cls === 'wa') ? 'wa' : 'cal' + (e.calendarIndex ?? 0); }
function evSrcColor(e) { return evSrcKey(e) === 'wa' ? WA_COLOR : CAL_COLORS[(e.calendarIndex ?? 0) % CAL_COLORS.length]; }
function calHidden() { state.calHidden = state.calHidden || {}; return state.calHidden; }
window.toggleCalSrc = (k) => { const h = calHidden(); h[k] = !h[k]; renderCalView(); };
// מקרא לחיץ: לוחצים על מקור כדי להציג/להסתיר אותו ביומן
function calLegend(data) {
  const cals = new Map();
  (data.calendar || []).forEach(e => cals.set(e.calendarIndex ?? 0, e.calendarName || ('יומן ' + ((e.calendarIndex ?? 0) + 1))));
  const h = calHidden();
  const item = (key, label, colors) => `<button onclick="toggleCalSrc('${key}')" title="לחץ להצגה/הסתרה" style="display:inline-flex;align-items:center;gap:5px;background:none;border:0;cursor:pointer;font-size:12px;color:var(--muted);opacity:${h[key] ? 0.45 : 1}"><span style="width:11px;height:11px;border-radius:3px;background:${colors[1]};display:inline-block"></span>${escapeHtml(label)}${h[key] ? ' (מוסתר)' : ''}</button>`;
  let out = item('wa', 'ווטסאפ', WA_COLOR);
  [...cals.keys()].sort((a, b) => a - b).forEach(idx => { out += item('cal' + idx, cals.get(idx), CAL_COLORS[idx % CAL_COLORS.length]); });
  return `<span style="display:inline-flex;gap:12px;flex-wrap:wrap;align-items:center">${out}</span>`;
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
  const h = calHidden();
  const cols = days.map((d, i) => {
    const iso = isoDate(d);
    const isToday = iso === today;
    const evs = (byDay[iso] || []).filter(e => !h[evSrcKey(e)]);
    const items = evs.length ? evs.map(e => {
      const [bg, fg] = evSrcColor(e);
      return `<div ${evClickAttr(e)} title="לחץ לעריכה" style="cursor:pointer;font-size:12px;padding:4px 7px;margin-top:4px;border-radius:6px;line-height:1.3;overflow:hidden;background:${bg};color:${fg}">${e.title || 'אירוע'}${e.location ? `<div style="font-size:10px;opacity:.75">${e.location}</div>` : ''}</div>`;
    }).join('')
      : `<div class="muted" style="font-size:11px;margin-top:8px">—</div>`;
    return `<div style="min-width:0;overflow:hidden;border:${isToday ? '2px solid var(--accent)' : '1px solid var(--line)'};border-radius:10px;padding:9px;min-height:230px;background:${isToday ? 'rgba(79,70,229,.08)' : 'var(--panel2)'}">
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
        <button class="btn ghost" onclick="shiftWeek(-1)">שבוע קודם →</button>
        <button class="btn ghost" onclick="shiftWeek(1)">← שבוע הבא</button>
      </div>
    </div>
    <div style="margin-bottom:10px">${calLegend(data)}</div>
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
  const h = calHidden();
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += '<div style="min-height:88px;min-width:0"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${month}-${String(day).padStart(2, '0')}`;
    const isToday = iso === today;
    const evs = (byDay[iso] || []).filter(e => !h[evSrcKey(e)]);
    const items = evs.slice(0, 4).map(e => {
      const [bg, fg] = evSrcColor(e);
      return `<div ${evClickAttr(e)} title="${(e.title || '').replace(/"/g, '')} ${e.location || ''} — לחץ לעריכה" style="cursor:pointer;font-size:11px;padding:1px 5px;margin-top:2px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:${bg};color:${fg}">${e.title || 'אירוע'}</div>`;
    }).join('');
    const more = evs.length > 4 ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">+${evs.length - 4} עוד</div>` : '';
    cells += `<div style="min-height:88px;min-width:0;overflow:hidden;border:${isToday ? '2px solid var(--accent)' : '1px solid var(--line)'};border-radius:8px;padding:5px;background:${isToday ? 'rgba(79,70,229,.08)' : (evs.length ? 'var(--panel2)' : 'transparent')}">
      <div style="font-size:12px;color:${isToday ? 'var(--accent)' : 'var(--muted)'};font-weight:${isToday ? '700' : '400'}">${day}${isToday ? ' • היום' : ''}</div>${items}${more}</div>`;
  }

  wrap.innerHTML = `
    <div class="row-between" style="margin-bottom:12px">
      <h2>יומן חודשי — ${MONTHS_HE[m - 1]} ${y}</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${viewToggle()}
        <button class="btn ghost" onclick="shiftMonth(-1)">חודש קודם →</button>
        <button class="btn ghost" onclick="shiftMonth(1)">← חודש הבא</button>
      </div>
    </div>
    <div style="margin-bottom:10px">${calLegend(data)}</div>
    ${data.calendarError ? `<div class="warn-banner">${data.calendarError}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;width:100%">
      ${DAYS_HE.map(d => `<div style="text-align:center;color:var(--muted);font-size:12px;font-weight:600;padding-bottom:4px;min-width:0">${d}</div>`).join('')}
      ${cells}
    </div>`;
}
const EVENTS_THEAD = `<thead><tr><th>תאריך</th><th>זמר</th><th>מיקום</th><th>לקוח</th><th>תמחור (ללא מע"מ)</th><th>תמחור כולל מע"מ</th><th>עובדים</th><th>קבלנים</th><th>חיוב</th><th>אישור</th><th>עריכה</th></tr></thead>`;
let _evMonthFilter = 'all';
window.setEvMonth = (v) => { _evMonthFilter = v; renderCombined($('#content')); };
let _evClientFilter = 'all';
window.setEvClient = (v) => { _evClientFilter = v; renderCombined($('#content')); };
let _evContractorFilter = 'all';
window.setEvContractor = (v) => { _evContractorFilter = v; renderCombined($('#content')); };
const monthKeyLabel = (k) => { const m = String(k).match(/^(\d{4})-(\d{2})$/); return m ? `${MONTHS_HE[+m[2] - 1]} ${m[1]}` : k; };
const curMonthKey = () => new Date().toISOString().slice(0, 7);
const isNoInvoiceEv = (e) => Boolean(e.noInvoice) || /ללא\s*-?\s*שול[םמ]/.test(e.clientName || '');
const isBilledEv = (e) => Boolean(e.invoiceId) || e.invoiceStatus === 'invoiced';
const isOverdueUnbilled = (e) => {
  if (isBilledEv(e) || isNoInvoiceEv(e)) return false;
  const mk = (e.date || e.dateRaw || '').slice(0, 7);
  return Boolean(mk) && mk < curMonthKey();
};
function invoiceCell(e) {
  const clientEnc = encodeURIComponent(e.clientName || '');
  const clientId = e.clientId || '';
  // כפתור שיוך עד 4 מסמכים — רק מסמכים של אותו לקוח (linkForEvent אוכף את זה)
  const linkBtn = `<button class="btn ghost" style="padding:3px 9px;font-size:11px" onclick="linkForEvent('${e.id}','${clientEnc}','${clientId}')">🔗 שייך מסמכים</button>`;
  const docs = Array.isArray(e.linkedDocs) ? e.linkedDocs : [];
  // "שולם" רק כשיש חשבונית מס-קבלה (320) או קבלה (400) — עסקה/מס בלבד נשאר פתוח
  const isReceipt = docs.some(d => [320, 400].includes(Number(d.type))) || [320, 400].includes(Number(e.invoiceType));
  if (isBilledEv(e) || docs.length) {
    const tags = docs.length
      ? docs.map(d => `<span class="tag invoiced" style="font-size:10.5px">${DOC_TYPE_SHORT[d.type] || 'מסמך'}${d.number ? ' #' + d.number : ''}</span>`).join(' ')
      : `<span class="tag invoiced">שויך · ${DOC_TYPE_SHORT[e.invoiceType] || 'חשבונית'}${e.invoiceNumber ? ' #' + e.invoiceNumber : ''}</span>`;
    const status = isReceipt
      ? `<div style="font-size:10.5px;color:var(--accent2);font-weight:700">שולם ✓</div>`
      : `<div style="font-size:10.5px;color:var(--muted)">ממתין לקבלה</div>`;
    return `<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">${tags}${status}${linkBtn}</div>`;
  }
  if (isNoInvoiceEv(e)) return `<span class="tag" style="background:var(--panel2);color:var(--muted)">לא נדרש</span>`;
  const base = isOverdueUnbilled(e)
    ? `<span class="tag" style="background:rgba(225,29,72,.14);color:var(--danger);font-weight:700">חסר חשבונית!</span>`
    : `<span class="tag pending">ממתין</span>`;
  return `<div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start">${base}${linkBtn}</div>`;
}
window.confirmEventRow = async (id, val) => {
  await fetch(`/api/events/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: val }) }).catch(() => {});
  renderCombined($('#content'));
};
// אירועים מקובצים לפי חודש — כל חודש בטבלה נפרדת עם סיכום
const VAT_RATE = 0.18; // מע"מ בישראל
// סכום ברוטו של אירוע (ללא מע"מ) — הגברה+תאורה+סאונד+בקליין+מסך לד(מ'×מחיר)+תוספות
const evGross = (e) => (Number(e.price) || 0) + (Number(e.priceLighting) || 0) + (Number(e.priceSound) || 0) + (Number(e.priceBackline) || 0) + ((Number(e.ledPricePerMeter) || 0) * (Number(e.ledMeters) || 0)) + (Number(e.priceExtras) || 0);
function eventsByMonthHtml(events, mode = 'approved') {
  const groups = {};
  for (const e of events) { const k = (e.date || e.dateRaw || '').slice(0, 7) || 'ללא תאריך'; (groups[k] = groups[k] || []).push(e); }
  const keys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const monthLabel = (k) => { const m = k.match(/^(\d{4})-(\d{2})$/); return m ? `${MONTHS_HE[+m[2] - 1]} ${m[1]}` : k; };
  return keys.map(k => {
    // מיון בתוך החודש לפי תאריך האירוע — מתחילת החודש (מוקדם) לסופו (מאוחר)
    const list = groups[k].slice().sort((a, b) => (a.date || a.dateRaw || '').localeCompare(b.date || b.dateRaw || ''));
    const total = list.reduce((s, e) => s + evGross(e), 0);
    const withVat = +(total * (1 + VAT_RATE)).toFixed(2);   // הסכומים מוזנים ללא מע"מ — מחושב אוטומטית
    const ctrCost = list.reduce((s, e) => s + (e.contractorDetails || []).reduce((t, c) => t + (Number(c.amount) || 0), 0), 0);
    const net = total - ctrCost;
    // לאישור: רק הכנסה צפויה (ללא מע"מ + כולל מע"מ). מאושרים: כולל קבלנים ונטו.
    const summary = mode === 'pending'
      ? `סה"כ הכנסה צפויה (ללא מע"מ): <b style="color:var(--accent2)">${money(total)}</b> · כולל מע"מ: <b style="color:var(--text)">${money(withVat)}</b>`
      : `סה"כ הכנסה (ללא מע"מ): <b style="color:var(--accent2)">${money(total)}</b> · כולל מע"מ: <b style="color:var(--text)">${money(withVat)}</b> · תשלומי קבלנים: <b style="color:var(--danger)">${money(ctrCost)}</b> · סה"כ לאחר קבלנים: <b style="color:var(--text)">${money(net)}</b>`;
    return `<div style="margin-top:18px">
      <div class="row-between" style="margin-bottom:6px">
        <h3 style="margin:0;font-size:15px">${monthLabel(k)} <span class="muted" style="font-weight:400;font-size:13px">· ${list.length} אירועים</span></h3>
        <span class="muted" style="font-size:13px">${summary}</span>
      </div>
      <div style="overflow-x:auto"><table style="min-width:960px">${EVENTS_THEAD}
        <tbody>${list.map(rowEvent).join('')}</tbody></table></div>
    </div>`;
  }).join('');
}
function rowEvent(e) {
  // אישור נעשה רק דרך העריכה (כדי לוודא פרטים) — בשורה לא מאושרת יש כפתור שפותח עריכה
  const confBtn = e.confirmed
    ? `<button class="btn success" style="padding:4px 12px;font-size:12px" onclick="confirmEventRow('${e.id}',false)">מאושר ✓</button>`
    : `<button class="btn ghost" style="padding:4px 12px;font-size:12px" onclick="openEventFromCal('${encodeURIComponent(JSON.stringify({ eventId: e.id }))}')">ערוך ואשר →</button>`;
  const rowBg = isOverdueUnbilled(e) ? 'background:rgba(225,29,72,.06)' : (e.confirmed ? 'background:rgba(14,164,114,.05)' : '');
  return `<tr${rowBg ? ` style="${rowBg}"` : ''}>
    <td style="white-space:nowrap">${ddmy(e.date || e.dateRaw)}</td>
    <td>${e.artist || '—'}</td>
    <td>${e.location || '—'}</td>
    <td>${e.clientName ? escapeHtml(e.clientName) : '<span class="muted">—</span>'}</td>
    <td>${money(e.price)}${(e.priceLighting || e.priceSound || e.priceBackline || (e.ledMeters && e.ledPricePerMeter) || e.priceExtras) ? `<div class="muted" style="font-size:11px">${e.priceLighting ? `תאורה ${money(e.priceLighting)} · ` : ''}${e.priceSound ? `סאונד ${money(e.priceSound)}` : ''}${e.priceBackline ? ` · בקליין ${money(e.priceBackline)}` : ''}${(e.ledMeters && e.ledPricePerMeter) ? ` · לד ${e.ledMeters}מ׳×${money(e.ledPricePerMeter)}` : ''}${e.priceExtras ? ` · תוספות ${money(e.priceExtras)}` : ''}</div>` : ''}</td>
    <td style="white-space:nowrap;font-weight:600">${money(evGross(e) * (1 + VAT_RATE))}</td>
    <td>${(e.employees || []).map(n => `<span class="chip">${n}</span>`).join('') || '—'}</td>
    <td>${(e.contractors || []).map(n => `<span class="chip">${n}</span>`).join('') || '—'}</td>
    <td>${invoiceCell(e)}</td>
    <td>${confBtn}</td>
    <td><button class="btn ghost" style="padding:4px 11px;font-size:12px" onclick="openEventFromCal('${encodeURIComponent(JSON.stringify({ eventId: e.id }))}')">עריכה</button></td></tr>`;
}

// ================= עורך אירוע (תבנית מלאה + מחירים + שיוך לקוח) =================
let _evEditing = null, _evCtr = [], _evClients = null, _evEmp = [], _evEmployees = null, _evSuppliers = null;
const EV_FACTORS = [['0.5', 'חצי יומית'], ['1', 'יומית'], ['1.5', 'יומית וחצי'], ['2', 'כפולה']];
function evClickAttr(e) {
  const p = encodeURIComponent(JSON.stringify({ eventId: e.eventId || null, gcalId: e.gcalId || null, date: e.date, title: e.title, location: e.location }));
  return `onclick="openEventFromCal('${p}')"`;
}
async function fetchEventById(id) {
  const list = await api(`/api/events?companyId=${state.company}`);
  return (list || []).find(e => e.id === id) || null;
}
window.openEventFromCal = async (enc) => {
  const p = JSON.parse(decodeURIComponent(enc));
  let ev = null;
  if (p.eventId) ev = await fetchEventById(p.eventId);
  if (!ev) {
    ev = await fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: state.company, date: p.date, artist: p.title, location: p.location, gcalId: p.gcalId || null, source: p.gcalId ? 'calendar' : 'manual' }),
    }).then(r => r.json()).catch(() => null);
  }
  if (ev && ev.id) openEventEditor(ev);
};
async function openEventEditor(ev) {
  _evEditing = ev;
  _evCtr = (ev.contractorDetails && ev.contractorDetails.length ? ev.contractorDetails
    : (ev.contractors || []).map(n => ({ name: n, amount: null }))).map(c => ({ name: c.name || '', amount: c.amount ?? '' }));
  _evEmp = (ev.employeeDetails && ev.employeeDetails.length ? ev.employeeDetails
    : (ev.employees || []).map(n => ({ name: n }))).map(w => ({ name: w.name || '', factor: w.factor ?? '1', bonus: w.bonus ?? '', food: w.food ?? '', note: w.note ?? '', bonusFactor: w.bonusFactor ?? null }));
  if (!_evClients) { try { _evClients = await api('/api/clients'); } catch { _evClients = []; } }
  if (!_evEmployees) { try { _evEmployees = await api(`/api/employees?companyId=${state.company}`); } catch { _evEmployees = []; } }
  if (!_evSuppliers) { try { const s = await api('/api/suppliers'); _evSuppliers = Array.isArray(s) ? s : []; } catch { _evSuppliers = []; } }
  let m = document.getElementById('evModal');
  if (!m) { m = document.createElement('div'); m.id = 'evModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const v = (x) => x == null ? '' : String(x).replace(/"/g, '&quot;');
  const fld = (lbl, inner, span) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)${span ? ';grid-column:1/3' : ''}">${lbl}${inner}</label>`;
  m.innerHTML = `<div class="modal-card" style="width:min(700px,95vw);max-height:90vh;overflow:auto">
    <h3>עריכת אירוע${ev.gcalId && ev.source === 'calendar' ? ' <span class="muted" style="font-size:12px;font-weight:400">(מיומן גוגל)</span>' : ''}</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
      ${fld('תאריך', `<input id="evDate" type="date" value="${ev.date || ''}"/>`)}
      ${fld('זמר / מופע', `<input id="evArtist" value="${v(ev.artist)}"/>`)}
      ${fld('מיקום', `<input id="evLocation" value="${v(ev.location)}"/>`, true)}
      ${fld('סאונד (תיאור)', `<input id="evSound" value="${v(ev.sound)}"/>`, true)}
      ${fld('מחיר אירוע (הגברה) ₪', `<input id="evPrice" type="number" inputmode="decimal" value="${ev.price ?? ''}"/>`)}
      ${fld('מחיר תאורה ₪', `<input id="evPriceLighting" type="number" inputmode="decimal" value="${ev.priceLighting ?? ''}"/>`)}
      ${fld('מחיר סאונד ₪', `<input id="evPriceSound" type="number" inputmode="decimal" value="${ev.priceSound ?? ''}"/>`)}
      ${fld('מחיר בקליין ₪', `<input id="evPriceBackline" type="number" inputmode="decimal" value="${ev.priceBackline ?? ''}"/>`)}
      ${fld('מסך לד — מחיר למ׳ ₪', `<input id="evLedPrice" type="number" inputmode="decimal" value="${ev.ledPricePerMeter ?? ''}"/>`)}
      ${fld('מסך לד — כמות (מ׳)', `<input id="evLedMeters" type="number" inputmode="decimal" value="${ev.ledMeters ?? ''}"/>`)}
      ${fld('מחיר תוספות ₪', `<input id="evPriceExtras" type="number" inputmode="decimal" value="${ev.priceExtras ?? ''}"/>`)}
      ${fld('שיוך ללקוח (לחיוב חודשי)', `<input id="evClient" list="evClientList" value="${v(ev.clientName)}" placeholder="שם לקוח…"/>`)}
      <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);grid-column:1/3"><input id="evNoInvoice" type="checkbox" ${ev.noInvoice ? 'checked' : ''}/> לא צריך להוציא חשבונית על אירוע זה (שולם במזומן / ללא חיוב)</label>
      ${fld('הערת בונוס/תשלום (טקסט חופשי) — מוחל אוטומטית', `<div style="display:flex;gap:6px"><input id="evBonus" value="${v(ev.employeeBonusRaw)}" placeholder="למשל: בונוס 278 לשניהם · בונוס חצי יומית · יומית וחצי" style="flex:1" onchange="applyBonusNote(null,true)"/><button type="button" class="btn ghost" style="white-space:nowrap;padding:8px 12px" onclick="applyBonusNote(this)">✨ החל שוב</button></div>`, true)}
    </div>
    <datalist id="evClientList">${(_evClients || []).map(c => `<option value="${escapeHtml(c.name)}">`).join('')}</datalist>
    <datalist id="evEmpList">${(_evEmployees || []).map(e => `<option value="${escapeHtml(e.name)}">`).join('')}</datalist>
    <datalist id="evSupList">${(_evSuppliers || []).map(s => `<option value="${escapeHtml(s.name)}">`).join('')}</datalist>
    <div style="margin-top:14px">
      <div class="row-between" style="margin-bottom:6px"><b style="font-size:14px">עובדים</b>
        <button class="btn ghost" style="padding:4px 11px;font-size:12px" onclick="evAddEmp()">+ הוסף עובד</button></div>
      <div id="evEmpBox">${evEmpHtml()}</div>
    </div>
    <div style="margin-top:14px">
      <div class="row-between" style="margin-bottom:6px"><b style="font-size:14px">קבלנים / ספקים</b>
        <button class="btn ghost" style="padding:4px 11px;font-size:12px" onclick="evAddCtr()">+ הוסף קבלן</button></div>
      <div id="evCtrBox">${evCtrHtml()}</div>
    </div>
    <div class="modal-actions" style="margin-top:18px;justify-content:space-between;align-items:center">
      <button class="btn ghost" style="color:var(--danger);border-color:rgba(225,29,72,.3)" onclick="deleteEvent()">🗑 מחק מהרשימה</button>
      <div style="display:flex;gap:12px;align-items:center">
        <span id="evSaveState" class="muted" style="font-size:12.5px">✓ נשמר אוטומטית</span>
        ${ev.confirmed
      ? '<button class="btn ghost" onclick="unapproveFromEditor(this)">בטל אישור</button>'
      : '<button class="btn success" onclick="approveFromEditor(this)">✓ אשר אירוע</button>'}
        <button class="btn primary" onclick="saveEvent(this)">סגור</button>
      </div>
    </div>
  </div>`;
  const card = m.querySelector('.modal-card'); if (card) card.addEventListener('change', window.autoSaveEvent);
  m.onclick = (e) => { if (e.target === m) { saveEventCore(); m.classList.add('hidden'); renderCombined($('#content')); } };
}
window.deleteEvent = async () => {
  if (!_evEditing) return;
  if (!confirm('למחוק את האירוע מרשימת האירועים שלך? (לא נמחק מיומן גוגל)')) return;
  await fetch(`/api/events/${_evEditing.id}`, { method: 'DELETE' }).catch(() => {});
  const m = document.getElementById('evModal'); if (m) m.classList.add('hidden');
  renderCombined($('#content'));
};
function evCtrHtml() {
  if (!_evCtr.length) return '<span class="muted" style="font-size:13px">אין קבלנים. הוסף אם רלוונטי לתשלום. אפשר לבחור ספק מחשבונית ירוקה.</span>';
  return _evCtr.map((c, i) => `<div style="display:flex;gap:8px;margin-bottom:6px">
    <input list="evSupList" value="${(c.name || '').replace(/"/g, '&quot;')}" placeholder="שם קבלן / ספק" oninput="_evCtr[${i}].name=this.value" style="flex:1"/>
    <input type="number" inputmode="decimal" value="${c.amount ?? ''}" placeholder="סכום לתשלום ₪" oninput="_evCtr[${i}].amount=this.value" style="width:150px"/>
    <button class="btn ghost" style="padding:4px 11px" onclick="evRemoveCtr(${i})" title="הסר">×</button></div>`).join('');
}
window.evAddCtr = () => { _evCtr.push({ name: '', amount: '' }); document.getElementById('evCtrBox').innerHTML = evCtrHtml(); };
window.evRemoveCtr = (i) => { _evCtr.splice(i, 1); document.getElementById('evCtrBox').innerHTML = evCtrHtml(); };
// שורות עובדים: שם (מרשימת עובדים) + פקטור (חצי/יומית/כפולה) + בונוס
function evEmpHtml() {
  if (!_evEmp.length) return '<span class="muted" style="font-size:13px">אין עובדים. הוסף עובדים למשמרת.</span>';
  return _evEmp.map((w, i) => `<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;flex-wrap:wrap">
    <input list="evEmpList" value="${(w.name || '').replace(/"/g, '&quot;')}" placeholder="שם עובד" oninput="_evEmp[${i}].name=this.value" style="flex:1;min-width:110px"/>
    <select onchange="_evEmp[${i}].factor=this.value" style="width:105px">${EV_FACTORS.map(([val, lbl]) => `<option value="${val}"${String(w.factor) === val ? ' selected' : ''}>${lbl}</option>`).join('')}</select>
    <input type="number" inputmode="decimal" value="${w.bonus ?? ''}" placeholder="בונוס ₪" oninput="_evEmp[${i}].bonus=this.value" style="width:82px"/>
    <input type="number" inputmode="decimal" value="${w.food ?? ''}" placeholder="אוכל ₪" oninput="_evEmp[${i}].food=this.value" style="width:80px"/>
    <input value="${(w.note || '').replace(/"/g, '&quot;')}" placeholder="הערה" oninput="_evEmp[${i}].note=this.value" style="width:120px"/>
    <button class="btn ghost" style="padding:4px 11px" onclick="evRemoveEmp(${i})" title="הסר">×</button></div>`).join('');
}
window.evAddEmp = () => { _evEmp.push({ name: '', factor: '1', bonus: '', food: '', note: '' }); document.getElementById('evEmpBox').innerHTML = evEmpHtml(); };
window.evRemoveEmp = (i) => { _evEmp.splice(i, 1); document.getElementById('evEmpBox').innerHTML = evEmpHtml(); };
let _lastBonusNote = null;
// silent=true → החלה אוטומטית (בלי התראות, בלי כפתור). נקרא גם כשמסיימים לכתוב את ההערה.
window.applyBonusNote = async (btn, silent) => {
  const note = (document.getElementById('evBonus')?.value || '').trim();
  const names = _evEmp.map(w => (w.name || '').trim()).filter(Boolean);
  if (!note || !names.length) { if (!silent) alert(!note ? 'כתוב הערת בונוס/תשלום קודם.' : 'הוסף עובדים לאירוע קודם.'); return; }
  if (silent && note === _lastBonusNote) return; // כבר הוחל על אותה הערה — לא מריצים שוב
  _lastBonusNote = note;
  let t; if (btn) { btn.disabled = true; t = btn.textContent; btn.textContent = 'מפרש…'; }
  const res = await fetch('/api/interpret-bonuses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, employees: names }) }).then(r => r.json()).catch(() => []);
  if (btn) { btn.disabled = false; btn.textContent = t; }
  if (Array.isArray(res) && res.length) {
    let applied = 0;
    res.forEach(a => {
      const w = _evEmp.find(x => (x.name || '').trim() === String(a.name || '').trim());
      if (w) { if (a.bonus != null) w.bonus = a.bonus; if (a.bonusFactor != null) w.bonusFactor = a.bonusFactor; if (a.factor != null) w.factor = String(a.factor); applied++; }
    });
    const box = document.getElementById('evEmpBox'); if (box) box.innerHTML = evEmpHtml();
    await saveEventCore();
    if (!silent) alert(`הוחל ונשמר עבור ${applied} עובדים.`);
  } else if (!silent) alert('לא זוהתה הוראת בונוס/תשלום תקפה בהערה.');
};
function collectEventBody() {
  const g = (id) => document.getElementById(id);
  const num = (x) => { const s = String(x ?? '').trim(); return s === '' || isNaN(+s) ? null : +s; };
  const clientName = (g('evClient')?.value || '').trim() || null;
  const clientId = (_evClients || []).find(c => c.name === clientName)?.id || _evEditing.clientId || null;
  const ctr = _evCtr.filter(c => (c.name || '').trim()).map(c => ({ name: c.name.trim(), amount: num(c.amount) }));
  const emp = _evEmp.filter(w => (w.name || '').trim()).map(w => ({ name: w.name.trim(), factor: (w.factor == null || w.factor === '') ? 1 : +w.factor, bonus: num(w.bonus), bonusFactor: (w.bonusFactor == null || w.bonusFactor === '') ? null : +w.bonusFactor, food: num(w.food), note: (w.note || '').trim() || null }));
  return {
    date: g('evDate').value || null, dateRaw: g('evDate').value || _evEditing.dateRaw || null,
    artist: g('evArtist').value.trim() || null,
    location: g('evLocation').value.trim() || null,
    sound: g('evSound').value.trim() || null,
    price: num(g('evPrice').value), priceLighting: num(g('evPriceLighting')?.value), priceSound: num(g('evPriceSound').value), priceBackline: num(g('evPriceBackline')?.value), ledPricePerMeter: num(g('evLedPrice')?.value), ledMeters: num(g('evLedMeters')?.value), priceExtras: num(g('evPriceExtras').value),
    employees: emp.map(w => w.name), employeeDetails: emp,
    employeeBonusRaw: g('evBonus').value.trim() || null,
    contractors: ctr.map(c => c.name), contractorDetails: ctr,
    clientName, clientId,
    noInvoice: Boolean(g('evNoInvoice')?.checked),
  };
}
let _evSaveT = null;
async function saveEventCore() {
  if (!_evEditing || !document.getElementById('evDate')) return;
  const body = collectEventBody();
  Object.assign(_evEditing, body);
  const ind = document.getElementById('evSaveState'); if (ind) ind.textContent = 'שומר…';
  await fetch(`/api/events/${_evEditing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  if (ind) { ind.textContent = '✓ נשמר'; }
}
window.autoSaveEvent = () => { clearTimeout(_evSaveT); _evSaveT = setTimeout(saveEventCore, 350); };
window.saveEvent = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'שומר…'; }
  await saveEventCore();
  const m = document.getElementById('evModal'); if (m) m.classList.add('hidden');
  renderCombined($('#content'));
};
// אישור אירוע מתוך העריכה — שומר את הפרטים ומסמן כמאושר
window.approveFromEditor = async (btn) => {
  if (!_evEditing) return;
  if (btn) { btn.disabled = true; btn.textContent = 'מאשר…'; }
  await saveEventCore();
  _evEditing.confirmed = true;
  await fetch(`/api/events/${_evEditing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) }).catch(() => {});
  const m = document.getElementById('evModal'); if (m) m.classList.add('hidden');
  renderCombined($('#content'));
};
window.unapproveFromEditor = async (btn) => {
  if (!_evEditing) return;
  if (btn) { btn.disabled = true; }
  _evEditing.confirmed = false;
  await fetch(`/api/events/${_evEditing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: false }) }).catch(() => {});
  const m = document.getElementById('evModal'); if (m) m.classList.add('hidden');
  renderCombined($('#content'));
};

// סימון ידני של אי-התאמה כ"הותאם" — האירוע יורד מרשימת אי-ההתאמות מול היומן
window.markMatched = async (eventId, btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'מסמן…'; }
  const r = await fetch('/api/calendar/mark-matched', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, matched: true }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) { render(); }
  else if (btn) { btn.disabled = false; btn.textContent = '✓ סמן כהותאם'; alert('שגיאה: ' + (r.error || '')); }
};
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
    ${misses.length ? `<table><thead><tr><th>תאריך</th><th>אירוע (ווטסאפ)</th><th>סטטוס</th><th></th></tr></thead>
    <tbody>${misses.map(x => `<tr>
      <td>${x.whatsapp.date || '—'}</td>
      <td>${x.whatsapp.artist || '—'} / ${x.whatsapp.location || ''}</td>
      <td><span class="tag miss">חסר ביומן</span></td>
      <td style="text-align:left"><button class="btn ghost" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="markMatched('${x.whatsapp.id}',this)">✓ סמן כהותאם</button></td>
    </tr>`).join('')}</tbody></table>`
    : `<div class="empty">אין אי-התאמות כרגע 👌</div>`}
  </div>
  <div class="panel" id="calWrap"><div class="empty">טוען יומן…</div></div>`;
  renderCalView();
}

// ---- חיוב: בחירת אירועים לפי לקוח והפקת מסמך ----
const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const INV_TYPES = [[300, 'חשבון עסקה'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה']];
let _invClients = [];
async function renderInvoicing(c) {
  c.innerHTML = `<div class="panel"><div class="empty">טוען אירועים…</div></div>`;
  _invClients = await api(`/api/invoicing/clients?companyId=${state.company}`) || [];
  // מציגים רק לקוחות עם יתרה פתוחה (יש אירועים בלי קבלה/מס-קבלה). כשכל האירועים שולמו — הלקוח יורד מהרשימה.
  const shown = _invClients.filter(g => (g.unpaidCount || 0) > 0);
  c.innerHTML = `<div class="panel">
    <div class="row-between"><div><h2>הפקת חשבוניות ללקוחות</h2>
      <span class="muted">בחר אירועים והפק חשבון עסקה / מס / מס-קבלה / קבלה, או שייך למסמך קיים. אירוע נסגר ויורד מהרשימה רק כשמשויכת אליו קבלה או מס-קבלה. שיוך מסמכים נוסף אפשרי גם מלשונית האירועים (עמודת חיוב).</span></div></div>
    ${shown.length ? shown.map(invClientCard).join('') : `<div class="empty">אין יתרות פתוחות — כל האירועים חויבו ושולמו. 👌</div>`}
  </div>`;
}
function invClientCard(g) {
  const safe = 'c' + (g.clientId || g.client).replace(/[^a-zA-Z0-9֐-׿]/g, '_');
  const bodyId = 'invbody_' + safe;
  const cEnc = encodeURIComponent(g.client);
  // מציגים אירועים שטרם "שולמו" (אין להם קבלה/מס-קבלה). אירוע עם קבלה מוסר לגמרי.
  const openEvents = g.events.filter(ev => !ev.paid);
  const rows = openEvents.map(ev => {
    const tags = (ev.linkedDocs || []).map(d => `<span class="tag invoiced" style="font-size:10.5px">${DOC_TYPE_SHORT[d.type] || 'מסמך'}${d.number ? ' #' + d.number : ''}</span>`).join(' ');
    return `<tr>
      <td style="text-align:center"><input type="checkbox" class="invchk" data-c="${safe}" value="${ev.id}" ${ev.billed ? '' : 'checked'}/></td>
      <td>${ddmy(ev.date)}</td>
      <td>${escapeHtml(ev.artist || '')}</td>
      <td>${escapeHtml(ev.location || '')}</td>
      <td style="white-space:nowrap">${money(ev.total)}</td>
      <td>${tags || (ev.billed ? '<span class="tag pending" style="font-size:10.5px">חויב</span>' : '<span class="muted" style="font-size:11px">—</span>')}
        <button class="btn ghost" style="padding:2px 8px;font-size:11px;white-space:nowrap;margin-inline-start:4px" onclick="linkOneEvent('${ev.id}','${cEnc}','${g.clientId || ''}')">🔗 שייך</button></td>
    </tr>`;
  }).join('');
  const collapsed = g.unpaidCount === 0;
  return `<div class="card" style="margin-top:12px;padding:0;overflow:hidden">
    <div class="row-between" style="margin:0;padding:12px 14px;cursor:pointer" onclick="document.getElementById('${bodyId}').classList.toggle('hidden')">
      <div><b>${escapeHtml(g.client)}</b> <span class="muted">· ${g.unpaidCount} פתוחים · יתרה ${money(g.unpaidTotal)}</span></div>
      <div style="font-weight:700">${money(g.unpaidTotal)}</div>
    </div>
    <div id="${bodyId}" class="${collapsed ? 'hidden' : ''}">
      <table style="margin:0"><thead><tr><th style="width:56px">בחר</th><th>תאריך</th><th>אמן</th><th>מיקום</th><th>סכום</th><th>מסמכים</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <div style="padding:10px 14px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" onclick="openLinkExisting('${safe}','${cEnc}','${g.clientId || ''}')">🔗 שייך למסמכים קיימים</button>
        <button class="btn success" onclick="openInvoicePreview('${safe}','${cEnc}','${g.clientId || ''}')">הפק חשבונית מהנבחרים ←</button>
      </div>
    </div>
  </div>`;
}

// ---- תצוגה מקדימה + הפקה ----
let _invPreview = null;
let _linkCtx = null; // { ids, client, clientId }
// שורת מסמך עם תיבת סימון (בחירה מרובה עד 4 לשיוך)
function linkDocRow(d) {
  return `<label class="card" style="padding:9px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;cursor:pointer">
      <input type="checkbox" class="linkchk" data-id="${escAttr(String(d.id))}" data-number="${escAttr(String(d.number))}" data-type="${d.type}" onchange="linkChkChanged(this)"/>
      <span class="tag">${DOC_TYPE_SHORT[d.type] || 'מסמך'}</span>
      <span style="white-space:nowrap">#${d.number}</span>
      <span class="muted" style="white-space:nowrap">${fmtDate(d.date)}</span>
      <span style="flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d.description ? escapeHtml(d.description) : ''}</span>
      <span style="font-weight:600;white-space:nowrap">${money(d.amountDue != null ? d.amountDue : d.amount)}</span>
    </label>`;
}
window.linkChkChanged = (el) => {
  const checked = [...document.querySelectorAll('.linkchk:checked')];
  if (checked.length > 4) { el.checked = false; alert('אפשר לשייך עד 4 מסמכים לאירוע.'); return; }
  const btn = document.getElementById('linkConfirmBtn');
  if (btn) { const n = document.querySelectorAll('.linkchk:checked').length; btn.disabled = n === 0; btn.textContent = n ? `✓ שייך ${n} מסמכים וסגור את האירוע` : '✓ שייך וסגור את האירוע'; }
};
// קישור אירועים נבחרים למסמכים קיימים של הלקוח (במקום להפיק חדש)
window.openLinkExisting = (safe, clientEnc, clientId) => {
  const ids = [...document.querySelectorAll(`.invchk[data-c="${safe}"]:checked`)].map(x => x.value);
  if (!ids.length) { alert('לא נבחרו אירועים לשיוך'); return; }
  openDocLinkModal(ids, decodeURIComponent(clientEnc), clientId, renderInvoicing);
};
// שיוך מסמכים לאירוע בודד — מלשונית האירועים (עמודת חיוב). רק מסמכים של אותו לקוח.
window.linkForEvent = (eventId, clientEnc, clientId) => {
  const client = decodeURIComponent(clientEnc);
  if (!client && !clientId) { alert('יש לשייך את האירוע ללקוח לפני קישור מסמכים.'); return; }
  openDocLinkModal([eventId], client, clientId, renderCombined);
};
// שיוך מסמכים לאירוע בודד מתוך כרטיס החשבוניות (בלי תלות ב-checkbox) — מרענן את מסך החשבוניות
window.linkOneEvent = (eventId, clientEnc, clientId) => {
  openDocLinkModal([eventId], decodeURIComponent(clientEnc), clientId || '', renderInvoicing);
};
// שיוך אירוע למסמכים קיימים של אותו הלקוח (שם ייחודי כדי לא להתנגש עם שיוך-בנק openLinkModal)
async function openDocLinkModal(ids, client, clientId, onDone) {
  _linkCtx = { ids, client, clientId: clientId || '', onDone: onDone || renderInvoicing };
  let m = document.getElementById('docLinkModal');
  if (!m) { m = document.createElement('div'); m.id = 'docLinkModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden'); m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  m.innerHTML = `<div class="modal-card" style="width:min(700px,95vw)"><div class="empty">טוען חשבוניות פתוחות של ${escapeHtml(client)}…</div></div>`;
  const r = await api(`/api/invoicing/open-for-client?clientName=${encodeURIComponent(client)}`).catch(() => ({ docs: [] }));
  const docs = r.docs || [];
  const body = docs.length
    ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">${docs.map(d => linkDocRow(d)).join('')}</div>`
    : `<div class="empty" style="margin-top:10px">אין חשבוניות עסקה/מס פתוחות ללקוח זה. לחץ "הצג מסמכים אחרונים" כדי לשייך למסמך קיים.</div>`;
  m.innerHTML = `<div class="modal-card" style="width:min(700px,95vw);max-height:88vh;overflow:auto">
    <div class="row-between"><h3>שיוך ${ids.length} אירועים למסמכים קיימים</h3><span class="muted">${escapeHtml(client)}</span></div>
    <p class="muted" style="font-size:12.5px">סמן עד 4 מסמכים של הלקוח לשיוך (הצעת מחיר / עסקה / מס / קבלה), ואז לחץ "שייך וסגור את האירוע". האירוע יסומן כחויב ויוסר מרשימת החיוב.</p>
    <div id="linkBody">${body}</div>
    <div style="margin-top:10px"><button class="btn ghost" onclick="loadRecentDocs()">📄 הצג מסמכים אחרונים (הצעות מחיר / עסקה / מס / קבלה)</button></div>
    <div id="linkStatus" style="font-size:13px;min-height:18px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('docLinkModal').classList.add('hidden')">ביטול</button>
      <button class="btn success" id="linkConfirmBtn" disabled onclick="linkConfirm()">✓ שייך וסגור את האירוע</button>
    </div>
  </div>`;
};
// מציג את המסמכים האחרונים של הלקוח (כל הסוגים) לשיוך
window.loadRecentDocs = async () => {
  if (!_linkCtx) return;
  const box = document.getElementById('linkBody'); if (box) box.innerHTML = '<div class="empty">טוען מסמכים אחרונים…</div>';
  const q = `clientName=${encodeURIComponent(_linkCtx.client)}${_linkCtx.clientId ? `&clientId=${encodeURIComponent(_linkCtx.clientId)}` : ''}`;
  const r = await api(`/api/invoicing/recent-for-client?${q}`).catch(() => ({ docs: [] }));
  const docs = r.docs || [];
  if (box) box.innerHTML = docs.length
    ? `<div class="muted" style="font-size:12px;margin:6px 0">מסמכים אחרונים של הלקוח — סמן עד 4:</div><div style="display:flex;flex-direction:column;gap:8px">${docs.map(d => linkDocRow(d)).join('')}</div>`
    : `<div class="empty">לא נמצאו מסמכים אחרונים ללקוח זה.</div>`;
  linkChkChanged({ checked: false });
};
window.linkConfirm = async () => {
  if (!_linkCtx) return;
  const docs = [...document.querySelectorAll('.linkchk:checked')].map(x => ({ id: x.dataset.id, number: x.dataset.number, type: +x.dataset.type }));
  if (!docs.length) { alert('סמן לפחות מסמך אחד לשיוך.'); return; }
  const st = document.getElementById('linkStatus'); if (st) st.innerHTML = '<span class="muted">משייך…</span>';
  const r = await fetch('/api/invoicing/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventIds: _linkCtx.ids, docs }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) {
    if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ האירוע שויך ל-${r.docs} מסמכים וסומן כחויב.</span>`;
    const done = (_linkCtx && _linkCtx.onDone) || renderInvoicing;
    setTimeout(() => { document.getElementById('docLinkModal').classList.add('hidden'); done($('#content')); }, 1200);
  } else if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
};
window.openInvoicePreview = async (safe, clientEnc, clientId) => {
  const ids = [...document.querySelectorAll(`.invchk[data-c="${safe}"]:checked`)].map(x => x.value);
  if (!ids.length) { alert('לא נבחרו אירועים לחיוב'); return; }
  const pv = await fetch('/api/invoicing/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: state.company, eventIds: ids }) }).then(r => r.json()).catch(() => null);
  if (!pv) { alert('שגיאה בטעינת התצוגה המקדימה'); return; }
  _invPreview = { ids, client: decodeURIComponent(clientEnc), clientId: clientId || null,
    items: (pv.items || []).map(it => ({ description: it.description, quantity: it.quantity ?? 1, price: it.price ?? 0 })),
    subject: pv.subject || '', type: 305, docDate: todayIso(), sendEmail: false, email: pv.clientEmail || '' };
  showInvoicePreviewModal();
};
function invTotals() {
  const sub = _invPreview.items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  return { sub, vat: sub * 0.18, total: sub * 1.18 };
}
function showInvoicePreviewModal() {
  let m = document.getElementById('invPvModal');
  if (!m) { m = document.createElement('div'); m.id = 'invPvModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  renderInvoicePreviewModal();
}
function renderInvoicePreviewModal() {
  const m = document.getElementById('invPvModal'); if (!m) return;
  const p = _invPreview; const t = invTotals();
  const needDue = [300, 305].includes(+p.type);
  const isReceipt = [320, 400].includes(+p.type);
  const rows = p.items.map((it, i) => `<tr>
    <td><input value="${escAttr(it.description)}" oninput="invEdit(${i},'description',this.value)" style="width:100%"/></td>
    <td><input type="number" value="${it.quantity ?? 1}" oninput="invEdit(${i},'quantity',this.value)" style="width:56px" dir="ltr"/></td>
    <td><input type="number" value="${it.price ?? 0}" oninput="invEdit(${i},'price',this.value)" style="width:96px" dir="ltr"/></td>
    <td id="rt_${i}" style="white-space:nowrap">${money((Number(it.price) || 0) * (Number(it.quantity) || 1))}</td>
    <td><button class="btn ghost" style="padding:2px 8px" onclick="invDelRow(${i})">✕</button></td>
  </tr>`).join('');
  m.innerHTML = `<div class="modal-card" style="width:min(780px,96vw);max-height:92vh;overflow:auto">
    <div class="row-between"><h3>תצוגה מקדימה — הפקת מסמך</h3><span class="muted">${escapeHtml(p.client)}</span></div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
      <label style="display:flex;flex-direction:column;font-size:12px;color:var(--muted)">סוג מסמך
        <select id="invType" onchange="invSetType(this.value)">${INV_TYPES.map(([v, l]) => `<option value="${v}" ${+p.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label style="display:flex;flex-direction:column;font-size:12px;color:var(--muted);flex:1;min-width:220px">נושא / תיאור המסמך
        <input value="${escAttr(p.subject)}" oninput="_invPreview.subject=this.value"/></label>
      <label style="display:flex;flex-direction:column;font-size:12px;color:var(--muted)">תאריך המסמך
        <input type="date" value="${p.docDate || todayIso()}" oninput="_invPreview.docDate=this.value"/></label>
    </div>
    ${isReceipt ? `<div class="warn-banner" style="margin-bottom:10px">שים לב: ${DOC_TYPE_SHORT[+p.type]} מתעדת קבלת תשלום. תיווצר שורת תקבול של העברה בנקאית על מלוא הסכום.</div>` : ''}
    <table><thead><tr><th>פירוט</th><th>כמות</th><th>מחיר</th><th>סה"כ</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:8px"><button class="btn ghost" onclick="invAddRow()">+ הוסף שורה</button></div>
    <div style="margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:10px">
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer">
        <input type="checkbox" ${p.sendEmail ? 'checked' : ''} onchange="invToggleEmail(this.checked)"/>
        שלח את המסמך ללקוח במייל עם ההפקה${p.email ? ` <span class="muted" style="font-size:12px">· מייל שמור: ${escapeHtml(p.email)}</span>` : ' <span class="muted" style="font-size:12px">· אין מייל שמור ללקוח</span>'}</label>
      <div id="invEmailRow" class="${p.sendEmail ? '' : 'hidden'}" style="margin-top:8px">
        <input type="email" dir="ltr" placeholder="mail@example.com" value="${escAttr(p.email)}" oninput="_invPreview.email=this.value" style="width:100%"/>
      </div>
    </div>
    <div id="invSummary" style="margin-top:12px;text-align:left;font-size:14px">${invSummaryHtml(t)}</div>
    <div id="invPvStatus" style="min-height:18px;font-size:13px;margin:6px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('invPvModal').classList.add('hidden')">ביטול</button>
      <button class="btn success" onclick="generateInvoice(this)">✓ הפק בחשבונית ירוקה</button>
    </div>
  </div>`;
}
function invSummaryHtml(t) {
  return `<div>סכום ביניים: <b>${money(t.sub)}</b></div>
    <div>מע"מ 18%: <b>${money(t.vat)}</b></div>
    <div style="font-size:16px">סה"כ לתשלום: <b>${money(t.total)}</b></div>`;
}
window.invEdit = (i, k, v) => {
  _invPreview.items[i][k] = (k === 'description') ? v : (v === '' ? 0 : +v);
  const it = _invPreview.items[i];
  const rt = document.getElementById('rt_' + i); if (rt) rt.textContent = money((Number(it.price) || 0) * (Number(it.quantity) || 1));
  const sum = document.getElementById('invSummary'); if (sum) sum.innerHTML = invSummaryHtml(invTotals());
};
window.invSetType = (v) => { _invPreview.type = +v; renderInvoicePreviewModal(); };
window.invToggleEmail = (on) => { _invPreview.sendEmail = on; const r = document.getElementById('invEmailRow'); if (r) r.classList.toggle('hidden', !on); };
window.invAddRow = () => { _invPreview.items.push({ description: '', quantity: 1, price: 0 }); renderInvoicePreviewModal(); };
window.invDelRow = (i) => { _invPreview.items.splice(i, 1); renderInvoicePreviewModal(); };
window.generateInvoice = async (btn) => {
  const p = _invPreview;
  const items = p.items.filter(it => (it.description || '').trim() && (Number(it.price) || 0) !== 0);
  if (!items.length) { document.getElementById('invPvStatus').innerHTML = '<span style="color:var(--danger)">אין שורות תקינות.</span>'; return; }
  const typeName = (INV_TYPES.find(x => x[0] === +p.type) || [, ''])[1];
  if (p.sendEmail && !(p.email || '').trim()) { document.getElementById('invPvStatus').innerHTML = '<span style="color:var(--danger)">סימנת שליחה במייל אך לא הזנת כתובת.</span>'; return; }
  const emailNote = p.sendEmail ? `\nהמסמך יישלח במייל אל ${p.email}.` : '';
  if (!confirm(`להפיק ${typeName} על סך ${money(invTotals().total)} עבור ${p.client}?\nהמסמך ייווצר בחשבונית ירוקה ולא ניתן למחיקה (רק לזכות).${emailNote}`)) return;
  btn.disabled = true; btn.textContent = 'מפיק…';
  const st = document.getElementById('invPvStatus'); st.innerHTML = '<span class="muted">יוצר מסמך בחשבונית ירוקה…</span>';
  const r = await fetch('/api/invoicing/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyId: state.company, eventIds: p.ids, clientName: p.client, clientId: p.clientId,
      type: p.type, items, description: p.subject, date: p.docDate || null,
      sendEmail: p.sendEmail, email: p.sendEmail ? p.email : null }) }).then(r => r.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = '✓ הפק בחשבונית ירוקה';
  if (r.ok) {
    document.getElementById('invPvModal').classList.add('hidden');
    showInvoiceDoneDialog(typeName, r.doc?.number, r.doc?.url);
    renderInvoicing($('#content'));
  } else {
    st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};
// חלון "החשבונית הופקה בהצלחה" עם אפשרות הורדה מיידית
function showInvoiceDoneDialog(typeName, number, url) {
  let m = document.getElementById('invDoneModal');
  if (!m) { m = document.createElement('div'); m.id = 'invDoneModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(420px,94vw);text-align:center">
    <div style="font-size:42px;line-height:1">✅</div>
    <h3 style="margin:8px 0 2px">החשבונית הופקה בהצלחה</h3>
    <p class="muted" style="font-size:13.5px">${escapeHtml(typeName || 'מסמך')}${number ? ` #${escapeHtml(String(number))}` : ''}</p>
    <div class="modal-actions" style="justify-content:center;gap:10px;margin-top:16px">
      ${url ? `<a class="btn primary" href="${url}" target="_blank" rel="noopener" onclick="document.getElementById('invDoneModal').classList.add('hidden')">⬇ להורדה לחץ כאן</a>` : ''}
      <button class="btn ghost" onclick="document.getElementById('invDoneModal').classList.add('hidden')">סגור</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
}

// ---- הצעות מחיר ----
async function renderQuotes(c) {
  c.innerHTML = `<div class="panel"><div class="empty">טוען הצעות מחיר…</div></div>`;
  const r = await api('/api/open-quotes').catch(() => ({ docs: [], error: 'שגיאת טעינה' }));
  const docs = r.docs || [];
  const total = docs.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  c.innerHTML = `<div class="panel">
    <div class="row-between"><div><h2>הצעות מחיר פתוחות</h2>
      <span class="muted">${docs.length} הצעות · ${money(total)}. סמן הצעות וסגור אותן יחד, או הפק מכל אחת מסמך המשך.</span></div>
      <button class="btn ghost" id="closeSelBtn" onclick="quoteCloseSelected()" disabled>🔒 סגור נבחרות</button></div>
    ${r.error ? `<div class="warn-banner" style="margin-top:10px">${escapeHtml(r.error)}</div>` : ''}
    ${docs.length ? `<div style="overflow-x:auto;margin-top:12px"><table><thead><tr><th style="width:34px"><input type="checkbox" onchange="quoteToggleAll(this.checked)"/></th><th>תאריך</th><th>מספר</th><th>לקוח</th><th>תיאור</th><th>סכום</th><th></th></tr></thead>
      <tbody>${docs.map(quoteRow).join('')}</tbody></table></div>`
      : `<div class="empty">אין הצעות מחיר פתוחות 👌</div>`}
  </div>`;
}
function quoteRow(d) {
  const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : '';
  const follow = `<button class="btn primary" style="padding:2px 9px;font-size:12px" onclick="quoteFollowup('${d.id}','${encodeURIComponent(d.clientName || '')}','${d.number}')">הפק מסמך המשך</button>`;
  const close = `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="quoteClose('${d.id}','${d.number}')">סגור הצעה</button>`;
  return `<tr>
    <td style="text-align:center"><input type="checkbox" class="qchk" value="${d.id}" onchange="quoteSelChanged()"/></td>
    <td style="white-space:nowrap">${fmtDate(d.date)}</td><td>#${d.number}</td>
    <td>${escapeHtml(d.clientName || '')}</td><td>${d.description ? escapeHtml(d.description) : '<span class="muted">—</span>'}</td>
    <td style="white-space:nowrap;font-weight:600">${money(d.amount)}</td>
    <td style="text-align:left"><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">${pv}${follow}${close}</div></td></tr>`;
}
window.quoteToggleAll = (on) => { document.querySelectorAll('.qchk').forEach(x => { x.checked = on; }); quoteSelChanged(); };
window.quoteSelChanged = () => {
  const n = document.querySelectorAll('.qchk:checked').length;
  const b = document.getElementById('closeSelBtn');
  if (b) { b.disabled = !n; b.textContent = n ? `🔒 סגור נבחרות (${n})` : '🔒 סגור נבחרות'; }
};
window.quoteCloseSelected = async () => {
  const boxes = [...document.querySelectorAll('.qchk:checked')];
  if (!boxes.length) return;
  if (!confirm(`לסגור ${boxes.length} הצעות מחיר?\nהן יסומנו כסגורות ויוסרו מהרשימה (אפשר לפתוח מחדש בחשבונית ירוקה).`)) return;
  const ids = boxes.map(b => b.value);
  const btn = document.getElementById('closeSelBtn'); if (btn) { btn.disabled = true; btn.textContent = 'סוגר…'; }
  const r = await fetch('/api/quotes/close-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) renderQuotes($('#content'));
  else { alert('שגיאה בסגירה: ' + (r.error || '')); if (btn) { btn.disabled = false; } }
};
const FOLLOWUP_TYPES = [[300, 'חשבון עסקה'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה']];
window.quoteClose = async (id, number) => {
  if (!confirm(`לסגור את הצעת מחיר #${number}?\nההצעה תסומן כסגורה ותוסר מהרשימה (אפשר לפתוח מחדש בחשבונית ירוקה).`)) return;
  const r = await fetch(`/api/quotes/${id}/close`, { method: 'POST' }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) renderQuotes($('#content')); else alert('שגיאה בסגירה: ' + (r.error || ''));
};
window.quoteFollowup = (id, clientEnc, number) => {
  let m = document.getElementById('fuModal');
  if (!m) { m = document.createElement('div'); m.id = 'fuModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(440px,94vw)">
    <h3>מסמך המשך מהצעה #${number}</h3>
    <p class="muted" style="font-size:13px">${escapeHtml(decodeURIComponent(clientEnc))} — בחר את סוג המסמך שייווצר מההצעה (עם אותן שורות, מקושר להצעה):</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
      ${FOLLOWUP_TYPES.map(([v, l]) => `<button class="btn ghost" style="justify-content:flex-start;text-align:right" onclick="doFollowup('${id}',${v},this)">${l}</button>`).join('')}
    </div>
    <div id="fuStatus" style="font-size:13px;min-height:18px;margin-top:10px"></div>
    <div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('fuModal').classList.add('hidden')">ביטול</button></div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
};
window.doFollowup = async (id, type, btn) => {
  const st = document.getElementById('fuStatus');
  const typeName = (FOLLOWUP_TYPES.find(x => x[0] === type) || [, ''])[1];
  if (!confirm(`להפיק ${typeName} מההצעה?\nהמסמך ייווצר בחשבונית ירוקה עם שורות ההצעה ולא ניתן למחיקה (רק לזכות).`)) return;
  [...document.querySelectorAll('#fuModal button')].forEach(b => b.disabled = true);
  st.innerHTML = '<span class="muted">מפיק מסמך…</span>';
  const r = await fetch(`/api/quotes/${id}/followup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) {
    st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''}</span>`;
    setTimeout(() => { document.getElementById('fuModal').classList.add('hidden'); renderQuotes($('#content')); }, 1300);
  } else {
    [...document.querySelectorAll('#fuModal button')].forEach(b => b.disabled = false);
    st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};

// ---- קבלנים ----
let _suppliers = [];
async function renderContractors(c) {
  c.innerHTML = `<div class="panel"><div class="empty">טוען קבלנים…</div></div>`;
  const [pay, sup, dr] = await Promise.all([
    api(`/api/contractors/payables?companyId=${state.company}`),
    api('/api/suppliers').catch(() => []),
    api('/api/expense-drafts').catch(() => ({ drafts: [] })),
  ]);
  const payables = Array.isArray(pay) ? pay : [];
  _suppliers = Array.isArray(sup) ? sup : [];
  _drafts = Array.isArray(dr?.drafts) ? dr.drafts : [];
  const totalUnpaid = payables.reduce((s, x) => s + (x.unpaidTotal || 0), 0);
  const totalPaid = payables.reduce((s, x) => s + (x.paidTotal || 0), 0);
  c.innerHTML = `<div class="panel" id="draftsPanel">${draftsSection()}</div>
  <div class="panel">
    <div class="row-between"><div><h2>קבלנים לתשלום</h2>
      <span class="muted">${payables.length} קבלנים · שולם ${money(totalPaid)} · נותר לתשלום <b style="color:var(--danger)">${money(totalUnpaid)}</b>. סמן אירועים (או הכל), לחץ "סמן כשולם" והזן מספר חשבונית.</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn success" onclick="pickExpenseFile()">📎 העלה קובץ הוצאה</button><button class="btn primary" onclick="openContactForm('supplier')">+ הוסף ספק/קבלן</button></div></div>
    ${payables.length ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">${payables.map(contractorCard).join('')}</div>`
      : `<div class="empty">אין קבלנים עם סכומים עדיין. הוסף סכום לקבלן באירוע.</div>`}
  </div>
  <div class="panel">
    <div class="row-between"><div><h2>רשימת קבלנים</h2>
      <span class="muted">${_suppliers.length} קבלנים · מתוך הספקים בחשבונית ירוקה. לחיצה על קבלן מציגה את כל המסמכים שלו.</span></div>
      <button class="btn ghost" onclick="refreshSuppliers(this)">↻ רענן מחשבונית ירוקה</button></div>
    <div style="display:flex;gap:16px;align-items:stretch;min-height:56vh;margin-top:12px">
      <div style="flex:0 0 300px;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;overflow:hidden">
        <input id="supSearch" placeholder="חיפוש קבלן…" style="border:none;border-bottom:1px solid var(--line);border-radius:0"/>
        <div id="supList" style="overflow-y:auto;flex:1;max-height:62vh">${supplierRows(_suppliers)}</div>
      </div>
      <div id="supDetail" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;padding:18px;overflow:auto;max-height:66vh">
        <div class="empty">בחר קבלן כדי לראות את כל המסמכים שלו</div>
      </div>
    </div>
  </div>`;
  const inp = $('#supSearch');
  if (inp) inp.oninput = () => { $('#supList').innerHTML = supplierRows((_suppliers || []).filter(s => !inp.value || (s.name || '').includes(inp.value))); };
  kickDraftsAi(); // AI קורא את הטיוטות ברקע כדי שהכרטיסים יציגו ספק/סכום/תיאור והמסך יהיה מוכן מראש
}
function contractorCard(x) {
  const safe = 'ct_' + String(x.name).replace(/[^a-zA-Z0-9֐-׿]/g, '_');
  const rows = x.events.map(ev => {
    const sel = ev.paid
      ? `<span class="tag invoiced" style="white-space:nowrap">שולם${ev.paidInvoice ? ` · חשבונית ${escapeHtml(String(ev.paidInvoice))}` : ''}</span>`
      : `<input type="checkbox" class="ctchk" data-c="${safe}" data-ev="${ev.eventId}" data-ix="${ev.index}"/>`;
    return `<div style="display:flex;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--line);font-size:13px">
      <span style="width:28px;text-align:center">${sel}</span>
      <span class="muted" style="white-space:nowrap">${ddmy(ev.date)}</span>
      <span>${escapeHtml(ev.artist || '')}${ev.location ? ` · ${escapeHtml(ev.location)}` : ''}</span>
      <span style="margin-inline-start:auto;font-weight:600">${money(ev.amount)}</span>
      <button class="btn ${ev.paid ? 'success' : 'ghost'}" style="padding:3px 10px;font-size:12px" onclick="toggleContractorPaid('${ev.eventId}',${ev.index},${ev.paid ? 0 : 1})">${ev.paid ? 'בטל תשלום' : 'שולם'}</button>
    </div>`;
  }).join('');
  return `<div class="card" style="padding:0;overflow:hidden">
    <div class="row-between" style="margin:0;padding:11px 13px;cursor:pointer" onclick="document.getElementById('${safe}').classList.toggle('hidden')">
      <div><b>${escapeHtml(x.name)}</b> <span class="muted">· ${x.events.length} אירועים</span></div>
      <div style="font-size:13px">שולם ${money(x.paidTotal)} · <span style="color:var(--danger)">נותר ${money(x.unpaidTotal)}</span></div>
    </div>
    <div id="${safe}" class="${x.events.length > 3 ? 'hidden' : ''}">
      <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);background:var(--panel2)">
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" onchange="ctSelectAll('${safe}',this.checked)"/> בחר הכל</label>
        <button class="btn success" style="margin-inline-start:auto;padding:4px 12px;font-size:12px" onclick="ctMarkPaid('${safe}')">✓ סמן נבחרים כשולם + מס' חשבונית</button>
      </div>
      ${rows}
    </div>
  </div>`;
}
window.ctSelectAll = (safe, on) => { document.querySelectorAll(`.ctchk[data-c="${safe}"]`).forEach(x => { x.checked = on; }); };
window.ctMarkPaid = async (safe) => {
  const boxes = [...document.querySelectorAll(`.ctchk[data-c="${safe}"]:checked`)];
  if (!boxes.length) { alert('לא נבחרו אירועים'); return; }
  const inv = prompt(`מספר חשבונית הקבלן עבור ${boxes.length} אירועים (אפשר להשאיר ריק):`, '');
  if (inv === null) return;
  const items = boxes.map(b => ({ eventId: b.dataset.ev, index: +b.dataset.ix }));
  await fetch('/api/contractors/mark-paid-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, invoiceNumber: inv.trim() || null, paid: true }) }).catch(() => {});
  renderContractors($('#content'));
};
window.toggleContractorPaid = async (eventId, index, paid) => {
  await fetch('/api/contractors/toggle-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, index, paid: !!paid }) }).catch(() => {});
  renderContractors($('#content'));
};
window.refreshSuppliers = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'מרענן…'; }
  _suppliers = await api('/api/suppliers?fresh=1').catch(() => _suppliers);
  const list = $('#supList'); if (list) list.innerHTML = supplierRows(_suppliers || []);
  if (btn) { btn.disabled = false; btn.textContent = '↻ רענן מחשבונית ירוקה'; }
};
function supplierRows(list) {
  if (!list.length) return `<div class="empty">לא נמצאו קבלנים.</div>`;
  return list.map(s => `<div class="chat-item" id="sup-${s.id}" style="margin:0;border-radius:0;border-bottom:1px solid var(--line)" onclick="selectSupplier('${s.id}','${encodeURIComponent(s.name || '')}')">
    <span style="font-size:15px">🎛️</span><div style="font-weight:600;font-size:14px">${escapeHtml(s.name)}</div>
    <span class="muted" style="margin-inline-start:auto;font-size:14px">‹</span></div>`).join('');
}
let _supDocs = [], _supName = '', _supYear = 'all', _supId = '';
let _drafts = [];
const _aiByDraft = {};      // מטמון תוצאות ה-AI לכל טיוטה (id -> fields)
const _aiInFlight = {};     // מונע קריאות כפולות במקביל
let _openApproveId = null;  // איזו טיוטה פתוחה כרגע במסך הקליטה
// מריץ קריאת AI ברקע לכל הטיוטות שעדיין לא נקראו, ואז מרענן את הכרטיסים
window.kickDraftsAi = async () => {
  const list = (_drafts || []).slice();
  let changed = false;
  await Promise.all(list.map(async (d) => {
    if (_aiByDraft[d.id] || _aiInFlight[d.id]) return;
    _aiInFlight[d.id] = true;
    try {
      const r = await fetch(`/api/expense-drafts/${d.id}/ai-extract`, { method: 'POST' }).then(x => x.json());
      if (r && r.ok && r.fields) { _aiByDraft[d.id] = r.fields; const dd = (_drafts || []).find(x => x.id === d.id); if (dd) dd.ai = r.fields; changed = true; }
    } catch { } finally { delete _aiInFlight[d.id]; }
  }));
  if (changed) {
    const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection();
    if (_openApproveId && _aiByDraft[_openApproveId] && document.getElementById('apAi')) {
      applyAiFields(_aiByDraft[_openApproveId]); document.getElementById('apAi').innerHTML = aiNote(_aiByDraft[_openApproveId]);
    }
  }
};
// ===== טיוטות הוצאה (OCR) — צפייה ואישור מתוך האתר =====
const DRAFT_TYPE_NAMES = { 20: 'חשבון/אישור', 305: 'חשבונית מס', 320: 'מס-קבלה', 330: 'זיכוי', 400: 'קבלה', 405: 'קבלה תרומה' };
function draftsSection() {
  const list = _drafts || [];
  return `<div class="row-between"><div><h2>🧾 טיוטות הוצאה לאישור</h2>
      <span class="muted">${list.length ? `${list.length} טיוטות שהעלית וממתינות לאישור. בדוק את מה שהזיהוי האוטומטי קלט, תקן אם צריך, ואשר — תיווצר הוצאה אמיתית שמשויכת לספק.` : 'אין טיוטות ממתינות. העלה קובץ הוצאה כדי שיופיע כאן אחרי זיהוי אוטומטי (OCR).'}</span></div>
      <button class="btn ghost" onclick="reloadDrafts(this)">↻ רענן</button></div>
    ${list.length ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">${list.map(draftCard).join('')}</div>` : `<div class="empty">אין טיוטות ממתינות לאישור.</div>`}`;
}
function draftCard(d) {
  const ai = _aiByDraft[d.id] || d.ai || null;   // מה שה-AI קרא מהחשבונית (גובר על ה-OCR הכללי של מורנינג)
  const failed = d.status === 50 || d.status === 200;
  const supName = (ai && ai.supplierName) || d.supplierName;
  const amtVal = (ai && ai.amountInclVat) ? ai.amountInclVat : d.amount;
  const desc = (ai && ai.description) || d.description || '';
  const number = (ai && ai.invoiceNumber) || d.number;
  const date = (ai && ai.date) || d.date;
  const docType = (ai && ai.documentType) || d.documentType;
  const amt = (amtVal != null && amtVal !== '') ? money(amtVal) : '<span class="muted">—</span>';
  const supTxt = supName ? escapeHtml(supName) : '<span class="muted">ספק לא זוהה</span>';
  const typeTxt = DRAFT_TYPE_NAMES[docType] || '';
  const file = d.url ? `<a class="btn ghost" style="padding:3px 10px;font-size:12px" href="/api/expense-drafts/${d.id}/file" target="_blank" rel="noopener">📄 צפה</a>` : '';
  const aiBadge = ai
    ? '<span class="tag" style="background:#e7f7ee;color:var(--accent2)">🤖 נקרא — מוכן לקליטה</span>'
    : '<span class="tag muted">🤖 קורא…</span>';
  const statusTag = failed ? ` <span class="tag" style="background:#fde8e8;color:var(--danger)">${escapeHtml(d.statusText)}</span>` : '';
  return `<div class="card" style="padding:12px 14px">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="min-width:190px"><b>${supTxt}</b> ${aiBadge}${statusTag}<br><span class="muted" style="font-size:12.5px">${typeTxt}${number ? ` · מס' ${escapeHtml(String(number))}` : ''}${date ? ` · ${ddmy(date)}` : ''}</span></div>
      <div style="font-weight:700;font-size:15px;min-width:90px">${amt}</div>
      <div style="flex:1;min-width:120px" class="muted">${escapeHtml(desc)}</div>
      <div style="display:flex;gap:6px;margin-inline-start:auto">
        ${file}
        <button class="btn success" style="padding:4px 12px;font-size:13px" onclick="openApproveDraft('${d.id}')">📥 קליטת חשבונית</button>
        <button class="btn ghost" style="padding:4px 10px;font-size:13px;color:var(--danger)" onclick="deleteDraft('${d.id}')">🗑 מחק</button>
      </div>
    </div>
  </div>`;
}
window.reloadDrafts = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'מרענן…'; }
  const dr = await api('/api/expense-drafts?fresh=1').catch(() => ({ drafts: [] }));
  _drafts = Array.isArray(dr?.drafts) ? dr.drafts : [];
  const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection();
  if (btn) { btn.disabled = false; btn.textContent = '↻ רענן'; }
  kickDraftsAi(); // AI קורא את כל הטיוטות ברקע כדי שהכרטיסים והמסך יהיו מוכנים מראש
};
window.dismissDraft = async (id) => {
  if (!confirm('להסתיר את הטיוטה הזו מהרשימה? (הקובץ יישאר בחשבונית ירוקה, לא תיווצר הוצאה)')) return;
  await fetch(`/api/expense-drafts/${id}/dismiss`, { method: 'POST' }).catch(() => {});
  _drafts = _drafts.filter(x => x.id !== id);
  const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection();
};
// סוגי מסמך להוצאה (כמו בחשבונית ירוקה): חשבון עסקה / מס / מס-קבלה / קבלה
const APPROVE_DOC_TYPES = [[20, 'חשבון עסקה / אישור תשלום'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה']];
window.recalcApprVat = () => {
  const g = (x) => document.getElementById(x);
  const amount = +(g('apAmount')?.value) || 0;
  const netIn = g('apNet')?.value;
  const net = netIn !== '' && netIn != null ? +netIn : (amount ? +(amount / 1.18).toFixed(2) : 0);
  const vat = +(amount - net).toFixed(2);
  const el = g('apVat'); if (el) el.textContent = amount ? `מע"מ מחושב: ${money(vat)} · ללא מע"מ: ${money(net)}` : '';
};
window.openApproveDraft = (id) => {
  const d = (_drafts || []).find(x => x.id === id); if (!d) return;
  let m = document.getElementById('apprModal');
  if (!m) { m = document.createElement('div'); m.id = 'apprModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const fld = (l, i) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted);margin-bottom:9px">${l}${i}</label>`;
  const supOpts = (_suppliers || []).map(s => `<option value="${s.id}" ${s.id === d.supplierId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  const typeSel = APPROVE_DOC_TYPES.map(([v, l]) => `<option value="${v}" ${v === d.documentType ? 'selected' : ''}>${l}</option>`).join('');
  const preview = d.url
    ? `<iframe src="/api/expense-drafts/${d.id}/file#toolbar=1&navpanes=0" style="width:100%;height:100%;border:0;background:#fff" title="תצוגה מקדימה"></iframe>`
    : `<div class="empty" style="height:100%;display:flex;align-items:center;justify-content:center">אין קובץ לתצוגה</div>`;
  m.innerHTML = `<div class="modal-card" style="width:min(1120px,97vw);max-width:97vw">
    <div class="row-between" style="margin-bottom:6px"><h3 style="margin:0">אישור וקליטת הוצאה</h3>
      <button class="btn ghost" style="padding:2px 10px" onclick="document.getElementById('apprModal').classList.add('hidden')">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 10px">ה-AI קורא את החשבונית וממלא את השדות אוטומטית — עליך רק לוודא ולאשר. תיווצר הוצאה בחשבונית ירוקה שתשויך לספק.</p>
    <div style="display:flex;gap:16px;align-items:stretch;flex-wrap:wrap">
      <div style="flex:1 1 340px;min-width:300px;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:64vh">${preview}</div>
      <div style="flex:1 1 320px;min-width:280px;display:flex;flex-direction:column">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <div id="apAi" style="font-size:12.5px;flex:1"></div>
          <button class="btn ghost" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="aiFillDraft('${d.id}',true)">🤖 קרא עם AI</button>
        </div>
        <div style="overflow:auto;padding-inline-start:2px">
          ${fld('שם הספק / קבלן *', `<select id="apSup"><option value="">— בחר ספק —</option>${supOpts}</select>`)}
          ${fld('מספר עוסק / ח.פ', `<input id="apTax" dir="ltr" value="${escAttr(String(d.supplierTaxId || ''))}" placeholder="ח.פ / ע.מ"/>`)}
          ${fld('סוג המסמך *', `<select id="apType">${typeSel}</select>`)}
          ${fld('מספר המסמך *', `<input id="apNum" dir="ltr" value="${escAttr(String(d.number || ''))}" placeholder="מספר"/>`)}
          ${fld('תאריך המסמך *', `<input id="apDate" type="date" value="${d.date || todayIso()}"/>`)}
          ${fld('סכום ההוצאה (כולל מע"מ) ₪ *', `<input id="apAmount" type="number" inputmode="decimal" dir="ltr" value="${d.amount != null ? d.amount : ''}" placeholder="0" oninput="recalcApprVat()"/>`)}
          ${fld('סכום ללא מע"מ ₪', `<input id="apNet" type="number" inputmode="decimal" dir="ltr" value="${d.amountExcludeVat != null ? d.amountExcludeVat : ''}" placeholder="ריק = חישוב אוטומטי 18%" oninput="recalcApprVat()"/>`)}
          <div id="apVat" class="muted" style="font-size:12.5px;margin:-2px 0 10px"></div>
          ${fld('תיאור ההוצאה', `<input id="apDesc" value="${escAttr(String(d.description || ''))}" placeholder="תיאור"/>`)}
        </div>
        <div id="apStatus" style="font-size:13px;min-height:18px;margin:6px 0"></div>
        <div class="modal-actions" style="margin-top:auto">
          <button class="btn ghost" onclick="document.getElementById('apprModal').classList.add('hidden')">ביטול</button>
          <button class="btn primary" onclick="approveDraft('${d.id}',this)">✓ אשר וצור הוצאה</button>
        </div>
      </div>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  _openApproveId = d.id;
  setTimeout(() => { recalcApprVat(); aiFillDraft(d.id); }, 30);
};
// קליטה חכמה: AI קורא את קובץ החשבונית וממלא את השדות (עם מטמון לכל טיוטה)
function applyAiFields(f) {
  const g = (x) => document.getElementById(x);
  if (!g('apSup')) return;
  if (f.supplierId && [...g('apSup').options].some(o => o.value === String(f.supplierId))) g('apSup').value = String(f.supplierId);
  if (f.taxId && !g('apTax').value) g('apTax').value = f.taxId;
  if (f.documentType && [...g('apType').options].some(o => +o.value === +f.documentType)) g('apType').value = String(f.documentType);
  if (f.invoiceNumber) g('apNum').value = f.invoiceNumber;
  if (f.date) g('apDate').value = f.date;
  if (f.amountInclVat) g('apAmount').value = f.amountInclVat;
  if (f.amountExcludeVat) g('apNet').value = f.amountExcludeVat;
  if (f.description && !g('apDesc').value) g('apDesc').value = f.description;
  recalcApprVat();
}
window.aiFillDraft = async (id, force) => {
  const el = document.getElementById('apAi');
  const cached = !force && (_aiByDraft[id] || (_drafts || []).find(x => x.id === id)?.ai);
  if (cached) { applyAiFields(cached); if (el) el.innerHTML = aiNote(cached); return; }  // כבר נקרא מראש — מיידי
  if (el) el.innerHTML = '<span class="muted">🤖 קורא את החשבונית עם AI…</span>';
  const r = await fetch(`/api/expense-drafts/${id}/ai-extract${force ? '?force=1' : ''}`, { method: 'POST' }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (!document.getElementById('apAi')) return; // המשתמש סגר
  if (r.ok && r.fields) { _aiByDraft[id] = r.fields; const d = (_drafts || []).find(x => x.id === id); if (d) d.ai = r.fields; applyAiFields(r.fields); if (el) el.innerHTML = aiNote(r.fields); }
  else if (el) el.innerHTML = `<span style="color:var(--warn)">🤖 AI לא זמין (${escapeHtml(String(r.error || ''))}) — מלא ידנית</span>`;
};
function aiNote(f) {
  const g = document.getElementById('apSup');
  const matched = f.supplierId && g && [...g.options].some(o => o.value === String(f.supplierId));
  if (f.supplierName && !matched) return `<span style="color:var(--warn)">🤖 זוהה ע"י AI · ספק "${escapeHtml(f.supplierName)}" לא קיים ברשימה — בחר או הוסף</span>`;
  return '<span style="color:var(--accent2)">🤖 מולא ע"י AI — אנא ודא את הפרטים</span>';
}
window.deleteDraft = async (id) => {
  if (!confirm('למחוק את מסמך ההוצאה הזה? הפעולה תמחק את הטיוטה מחשבונית ירוקה ולא תיווצר הוצאה.')) return;
  await fetch(`/api/expense-drafts/${id}/delete`, { method: 'POST' }).catch(() => {});
  _drafts = _drafts.filter(x => x.id !== id);
  const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection();
};
window.approveDraft = async (id, btn) => {
  const g = (x) => document.getElementById(x);
  const st = g('apStatus');
  const supplierId = g('apSup').value;
  const number = g('apNum').value.trim();
  const amount = +g('apAmount').value;
  const net = g('apNet').value !== '' ? +g('apNet').value : null;
  if (!supplierId) { st.innerHTML = '<span style="color:var(--danger)">יש לבחור ספק.</span>'; return; }
  if (!number) { st.innerHTML = '<span style="color:var(--danger)">חסר מספר מסמך.</span>'; return; }
  if (!amount || amount <= 0) { st.innerHTML = '<span style="color:var(--danger)">חסר סכום תקין.</span>'; return; }
  const body = { supplierId, number, amount, amountExcludeVat: net, taxId: g('apTax').value.trim() || null, date: g('apDate').value || todayIso(), documentType: +g('apType').value, description: g('apDesc').value.trim() };
  btn.disabled = true; btn.textContent = 'מאשר…'; st.innerHTML = '<span class="muted">יוצר הוצאה בחשבונית ירוקה…</span>';
  const r = await fetch(`/api/expense-drafts/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = '✓ אשר וצור הוצאה';
  if (r.ok) {
    st.innerHTML = r.duplicate
      ? '<span style="color:var(--accent2)">✓ החשבונית כבר נקלטה במערכת — הקובץ הכפול נמחק.</span>'
      : '<span style="color:var(--accent2)">✓ ההוצאה נוצרה ושויכה לספק!</span>';
    _drafts = _drafts.filter(x => x.id !== id);
    setTimeout(() => { document.getElementById('apprModal').classList.add('hidden'); const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection(); }, 1400);
  } else st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
};
window.selectSupplier = async (id, nameEnc) => {
  document.querySelectorAll('.chat-item.active').forEach(x => x.classList.remove('active'));
  const item = document.getElementById('sup-' + id); if (item) item.classList.add('active');
  const detail = document.getElementById('supDetail'); if (!detail) return;
  detail.innerHTML = `<div class="muted" style="font-size:13px">טוען מסמכים…</div>`;
  _supName = decodeURIComponent(nameEnc); _supYear = 'all'; _supId = id;
  const docs = await api(`/api/contractors/${id}/documents`).catch(() => []);
  _supDocs = Array.isArray(docs) ? docs : [];
  renderSupplierDetail();
};
window.setSupYear = (v) => { _supYear = v; renderSupplierDetail(); };
function renderSupplierDetail() {
  const detail = document.getElementById('supDetail'); if (!detail) return;
  const years = [...new Set(_supDocs.map(d => (d.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  let docs = _supDocs;
  if (_supYear !== 'all') docs = docs.filter(d => (d.date || '').slice(0, 4) === _supYear);
  docs = [...docs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = docs.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const yearSel = `<select onchange="setSupYear(this.value)" style="padding:6px 10px"><option value="all" ${_supYear === 'all' ? 'selected' : ''}>כל השנים</option>${years.map(y => `<option value="${y}" ${_supYear === y ? 'selected' : ''}>${y}</option>`).join('')}</select>`;
  detail.innerHTML = `<div class="row-between"><h2 style="font-size:17px">${escapeHtml(_supName)}</h2>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" style="padding:5px 12px;font-size:13px" onclick="openExpenseForm()">+ רשום הוצאה</button><span class="muted" style="font-size:13px">שנה:</span>${yearSel}<span class="muted">${docs.length} מסמכים · ${money(total)}</span></div></div>
    ${docs.length ? `<div style="overflow-x:auto;margin-top:10px"><table style="min-width:520px"><thead><tr><th>תאריך</th><th>מספר</th><th>קטגוריה</th><th>סכום</th><th></th></tr></thead>
      <tbody>${docs.map(supDocRow).join('')}</tbody></table></div>`
      : `<div class="empty">לא נמצאו מסמכי הוצאה לקבלן זה בחשבונית ירוקה.</div>`}`;
}
function supDocRow(d) {
  const acts = d.url ? `<div style="display:flex;gap:6px"><a class="btn ghost" style="padding:2px 8px;font-size:12px" href="${d.url}" target="_blank" rel="noopener">תצוגה 👁</a>
    <a class="btn ghost" style="padding:2px 8px;font-size:12px" href="${d.url}" download target="_blank" rel="noopener">הורדה ↓</a></div>` : '<span class="muted">—</span>';
  return `<tr><td style="white-space:nowrap">${fmtDate(d.date)}</td><td>${escapeHtml(String(d.number || '—'))}</td>
    <td>${escapeHtml(d.category || '')}</td><td style="white-space:nowrap">${money(d.amount)}</td><td>${acts}</td></tr>`;
}
// העלאת קובץ חשבונית של קבלן → נכנס לחשבונית ירוקה כטיוטת הוצאה (OCR), ממתין לאישור
window.pickExpenseFile = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.pdf,.png,.jpg,.jpeg,application/pdf,image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) { alert('הקובץ גדול מדי (עד 10MB)'); return; }
    let toast = document.getElementById('expToast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'expToast'; toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 18px;font-size:14px;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,.15)'; document.body.appendChild(toast); }
    toast.style.display = 'block'; toast.innerHTML = `מעלה את "${escapeHtml(f.name)}" לחשבונית ירוקה…`;
    const data = await fileToB64(f);
    const r = await fetch('/api/expenses/upload-file', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileBase64: data, fileName: f.name, mime: f.type || 'application/pdf' }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
    if (r.ok) {
      // הזיהוי האוטומטי (OCR) של חשבונית ירוקה עשוי לקחת עד ~דקה — לכן נבדוק שוב ושוב עד שהטיוטה מופיעה
      const baseline = (_drafts || []).length;
      toast.innerHTML = '✓ הקובץ הועלה! מזהה את החשבונית אוטומטית (OCR)… זה עשוי לקחת עד דקה.';
      let tries = 0;
      const poll = async () => {
        tries++;
        const dr = await api('/api/expense-drafts?fresh=1').catch(() => null);
        const list = Array.isArray(dr?.drafts) ? dr.drafts : null;
        if (list) { _drafts = list; const p = document.getElementById('draftsPanel'); if (p) p.innerHTML = draftsSection(); }
        if ((list && list.length > baseline)) {
          toast.innerHTML = '✓ החשבונית זוהתה ונוספה ל"טיוטות הוצאה לאישור". ה-AI קורא אותה עכשיו…';
          kickDraftsAi(); // מיד קורא את החשבונית עם AI כדי שהכרטיס והמסך יהיו מוכנים
          setTimeout(() => { toast.style.display = 'none'; }, 4000);
        } else if (tries >= 15) {
          toast.innerHTML = 'הקובץ הועלה בהצלחה. הזיהוי האוטומטי עדיין מתעבד — לחץ "↻ רענן" בעוד רגע כדי לראות אותו.';
          setTimeout(() => { toast.style.display = 'none'; }, 6000);
        } else {
          toast.innerHTML = `✓ הקובץ הועלה! מזהה את החשבונית אוטומטית (OCR)… (${tries*5} שנ')`;
          setTimeout(poll, 5000);
        }
      };
      setTimeout(poll, 4000);
    } else { toast.innerHTML = `<span style="color:var(--danger)">שגיאה בהעלאה: ${escapeHtml(String(r.error || ''))}</span>`; setTimeout(() => { toast.style.display = 'none'; }, 5000); }
  };
  inp.click();
};
// רישום הוצאה של קבלן ישירות בחשבונית ירוקה
const EXPENSE_DOC_TYPES = [[305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה']];
window.openExpenseForm = () => {
  if (!_supId) return;
  let m = document.getElementById('expModal');
  if (!m) { m = document.createElement('div'); m.id = 'expModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const fld = (l, i) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:10px">${l}${i}</label>`;
  m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)">
    <h3>רישום הוצאה — ${escapeHtml(_supName)}</h3>
    <p class="muted" style="font-size:12.5px">רושם הוצאה בחשבונית ירוקה עבור הקבלן, בלי להיכנס למערכת.</p>
    <div style="margin-top:10px">
      ${fld('מספר חשבונית של הקבלן *', `<input id="expNum" dir="ltr" placeholder="מספר"/>`)}
      ${fld('סכום כולל מע"מ ₪ *', `<input id="expAmount" type="number" inputmode="decimal" dir="ltr" placeholder="0"/>`)}
      ${fld('תאריך', `<input id="expDate" type="date" value="${todayIso()}"/>`)}
      ${fld('סוג מסמך', `<select id="expType">${EXPENSE_DOC_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}
      ${fld('תיאור', `<input id="expDesc" placeholder="למשל: הגברה יוני"/>`)}
    </div>
    <div id="expStatus" style="font-size:13px;min-height:18px;margin:4px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('expModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="saveExpense(this)">רשום הוצאה</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  setTimeout(() => document.getElementById('expNum')?.focus(), 50);
};
window.saveExpense = async (btn) => {
  const g = (id) => document.getElementById(id);
  const st = g('expStatus');
  const number = g('expNum').value.trim();
  const amount = +g('expAmount').value;
  if (!number) { st.innerHTML = '<span style="color:var(--danger)">חסר מספר חשבונית.</span>'; return; }
  if (!amount || amount <= 0) { st.innerHTML = '<span style="color:var(--danger)">חסר סכום תקין.</span>'; return; }
  const body = { number, amount, vatIncluded: true, date: g('expDate').value || todayIso(), documentType: +g('expType').value, description: g('expDesc').value.trim() };
  btn.disabled = true; btn.textContent = 'רושם…'; st.innerHTML = '<span class="muted">יוצר הוצאה בחשבונית ירוקה…</span>';
  const r = await fetch(`/api/contractors/${_supId}/expense`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = 'רשום הוצאה';
  if (r.ok) { st.innerHTML = '<span style="color:var(--accent2)">✓ ההוצאה נרשמה בחשבונית ירוקה!</span>'; setTimeout(() => { document.getElementById('expModal').classList.add('hidden'); selectSupplier(_supId, encodeURIComponent(_supName)); }, 1100); }
  else st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
};

// טופס הוספת לקוח/ספק לחשבונית ירוקה
window.openContactForm = (kind) => {
  const isClient = kind === 'client';
  let m = document.getElementById('contactModal');
  if (!m) { m = document.createElement('div'); m.id = 'contactModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const fld = (lbl, inner) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:10px">${lbl}${inner}</label>`;
  m.innerHTML = `<div class="modal-card" style="width:min(480px,94vw)">
    <h3>${isClient ? 'הוספת לקוח לחשבונית ירוקה' : 'הוספת ספק / קבלן לחשבונית ירוקה'}</h3>
    <div style="margin-top:12px">
      ${fld('שם חברה *', `<input id="ctName" placeholder="שם החברה / העסק"/>`)}
      ${fld('מס\' ח.פ / ע.מ / ע.פ / ת"ז', `<input id="ctTax" dir="ltr" placeholder="מספר"/>`)}
      ${fld('איש קשר', `<input id="ctContact" placeholder="שם איש קשר"/>`)}
      ${fld('מס\' טלפון', `<input id="ctPhone" type="tel" dir="ltr" placeholder="050-0000000"/>`)}
      ${fld('כתובת מייל', `<input id="ctEmail" type="email" dir="ltr" placeholder="mail@example.com"/>`)}
    </div>
    <div id="ctStatus" style="font-size:13px;min-height:18px;margin:4px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('contactModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="saveContact('${kind}',this)">שמור ל-Green Invoice</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  setTimeout(() => document.getElementById('ctName')?.focus(), 60);
};
window.saveContact = async (kind, btn) => {
  const g = (id) => document.getElementById(id);
  const st = g('ctStatus');
  const name = g('ctName').value.trim();
  if (!name) { st.innerHTML = '<span style="color:var(--danger)">חובה להזין שם חברה.</span>'; return; }
  const body = { name, taxId: g('ctTax').value.trim() || null, contactPerson: g('ctContact').value.trim() || null, phone: g('ctPhone').value.trim() || null, emails: [g('ctEmail').value.trim()].filter(Boolean) };
  btn.disabled = true; btn.textContent = 'שומר…'; st.innerHTML = '<span class="muted">שולח ל-Green Invoice…</span>';
  const url = kind === 'client' ? '/api/clients' : '/api/suppliers';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = 'שמור ל-Green Invoice';
  if (r.ok) {
    st.innerHTML = '<span style="color:var(--accent2)">✓ נוסף בהצלחה ל-Green Invoice!</span>';
    if (kind === 'client') { state.clientsList = null; _evClients = null; _linkClients = null; } else { _evSuppliers = null; }
    setTimeout(() => { document.getElementById('contactModal').classList.add('hidden'); render(); }, 1000);
  } else { st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא נשמר'))}</span>`; }
};

// ---- עובדים ----
const monthLabelFromKey = (k) => { const m = String(k || '').match(/^(\d{4})-(\d{2})$/); return m ? `${MONTHS_HE[+m[2] - 1]} ${m[1]}` : k; };
const FACTOR_LABEL = (f) => ({ '0.5': 'חצי יומית', '1': 'יומית', '1.5': 'יומית וחצי', '2': 'כפולה' }[String(f)] || (f != null ? '×' + f : 'יומית'));
function payPeriodControls() {
  const [y, mm] = state.payMonth.split('-'); const cy = new Date().getFullYear(); const years = [];
  for (let yy = cy + 1; yy >= cy - 5; yy--) years.push(yy);
  return `<div style="display:flex;gap:8px;align-items:center">
    <select onchange="setPayPart('m',this.value)">${MONTHS_HE.map((mn, i) => `<option value="${String(i + 1).padStart(2, '0')}"${(+mm === i + 1) ? ' selected' : ''}>${mn}</option>`).join('')}</select>
    <select onchange="setPayPart('y',this.value)">${years.map(yy => `<option${(+y === yy) ? ' selected' : ''}>${yy}</option>`).join('')}</select></div>`;
}
window.setPayPart = (part, val) => { let [y, mm] = state.payMonth.split('-'); if (part === 'm') mm = val; else y = val; state.payMonth = `${y}-${mm}`; renderPayroll($('#content')); };
function fileToB64(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); }); }
window.empUploadDoc = (empId, kind) => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,application/pdf';
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; if (f.size > 8 * 1024 * 1024) { alert('הקובץ גדול מדי (עד 8MB)'); return; }
    const data = await fileToB64(f);
    await fetch(`/api/employees/${empId}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, filename: f.name, mime: f.type, data }) }).catch(() => {});
    renderPayroll($('#content')); };
  inp.click();
};
window.empDelDoc = async (fid) => { if (!confirm('למחוק מסמך?')) return; await fetch(`/api/files/${fid}`, { method: 'DELETE' }); renderPayroll($('#content')); };
window.empJobs = async (empId, nameEnc) => { const r = await api(`/api/employees/${empId}/jobs?month=${state.payMonth}`); openEmpJobsModal(decodeURIComponent(nameEnc), r); };
window.empJobsByName = (nameEnc) => { const name = decodeURIComponent(nameEnc); const e = (window._payEmps || []).find(x => x.name === name); if (e) empJobs(e.id, nameEnc); else alert('העובד לא נמצא ברשימת העובדים. לחץ "ייבא מהאירועים".'); };
const dmy = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : (iso || ''); };
let _report = null;
function openEmpJobsModal(name, r) {
  const emp = r.employee || {};
  const shifts = (r.pay && r.pay.shifts) || [];
  _report = {
    empId: emp.id, empName: name, month: state.payMonth,
    salaryType: emp.salaryType || 'gross',
    rows: shifts.map(s => ({ eventId: s.eventId, artist: s.artist || '', date: s.date, location: s.location || '', payment: Number(s.base) || 0, bonus: Number(s.bonus) || 0, food: Number(s.food) || 0, note: s.note || '' })),
  };
  let m = document.getElementById('jobsModal'); if (!m) { m = document.createElement('div'); m.id = 'jobsModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(900px,96vw);max-height:90vh;overflow:auto">
    <div class="row-between" style="align-items:center">
      <div><h3 style="margin:0">${escapeHtml(name)}</h3><span class="muted" style="font-size:13.5px">דוח עבודות · ${monthLabelFromKey(_report.month)} · ${_report.salaryType === 'net' ? 'נטו' : 'ברוטו'} · לחיצה על תא לעריכה</span></div>
      <button class="btn ghost" style="padding:6px 13px" onclick="printJobsReport()">🖨 הדפס / PDF</button>
    </div>
    <div id="jobsReport" style="margin-top:14px;background:#fff;border-radius:10px;padding:16px"></div>
    <div class="modal-actions" style="margin-top:14px"><button class="btn primary" onclick="document.getElementById('jobsModal').classList.add('hidden')">סגור</button></div>
  </div>`;
  renderJobsReport();
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
}
const _nisFmt = (n) => '₪' + (Number(n) || 0).toLocaleString('he-IL');
function renderJobsReport() {
  const el = document.getElementById('jobsReport'); if (!el || !_report) return;
  const rows = _report.rows;
  const label = _report.salaryType === 'net' ? 'נטו' : 'ברוטו';
  const th = (t, w) => `<th style="border:1px solid #d8dced;padding:9px 10px;text-align:right;background:#eef0fb;font-size:13px;font-weight:700${w ? `;width:${w}` : ''}">${t}</th>`;
  const cell = (inner, opt = '', id = '') => `<td${id ? ` id="${id}"` : ''} style="border:1px solid #d8dced;padding:6px 9px;text-align:right;font-size:13.5px;${opt}">${inner}</td>`;
  const inTxt = (i, f) => `<input value="${String(_report.rows[i][f] || '').replace(/"/g, '&quot;')}" onchange="editReport(${i},'${f}',this.value)" style="border:none;background:transparent;width:100%;text-align:right;font:inherit;color:inherit;padding:2px 0"/>`;
  const inNum = (i, f) => `<input type="number" inputmode="decimal" value="${_report.rows[i][f] || 0}" onchange="editReport(${i},'${f}',this.value)" style="border:none;background:transparent;width:100%;text-align:right;font:inherit;color:inherit;padding:2px 0"/>`;
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const grand = sum('payment') + sum('bonus') + sum('food');
  const head = `<div style="font-size:16px;font-weight:800;margin-bottom:2px">${escapeHtml(_report.empName)}</div>
    <div style="color:#6b7488;font-size:13px;margin-bottom:12px">דוח עבודות חודשי · ${monthLabelFromKey(_report.month)} · ${label}</div>`;
  if (!rows.length) { el.innerHTML = head + `<div class="empty">אין עבודות לחודש זה.</div>`; return; }
  el.innerHTML = head + `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;background:#fff">
      <thead><tr>${th('#', '34px')}${th('אמן')}${th('תאריך', '92px')}${th('מיקום')}${th('תשלום', '96px')}${th('בונוס', '88px')}${th('אוכל', '88px')}${th('הערות')}</tr></thead>
      <tbody>
        ${rows.map((r, i) => `<tr${i % 2 ? ' style="background:#fafbff"' : ''}>${cell(i + 1)}${cell(inTxt(i, 'artist'))}${cell(dmy(r.date), 'white-space:nowrap')}${cell(inTxt(i, 'location'))}${cell(inNum(i, 'payment'))}${cell(inNum(i, 'bonus'))}${cell(inNum(i, 'food'))}${cell(inTxt(i, 'note'))}</tr>`).join('')}
        <tr>${cell('<b>סה"כ</b>', 'border-top:2px solid #c7cce0;text-align:center')}<td colspan="3" style="border:1px solid #d8dced;border-top:2px solid #c7cce0"></td>${cell('<b>' + _nisFmt(sum('payment')) + '</b>', 'border-top:2px solid #c7cce0', 'sumPay')}${cell('<b>' + _nisFmt(sum('bonus')) + '</b>', 'border-top:2px solid #c7cce0', 'sumBonus')}${cell('<b>' + _nisFmt(sum('food')) + '</b>', 'border-top:2px solid #c7cce0', 'sumFood')}<td style="border:1px solid #d8dced;border-top:2px solid #c7cce0"></td></tr>
        <tr style="background:#eef0fb"><td colspan="4" style="border:1px solid #d8dced;padding:8px 10px;text-align:start;white-space:nowrap"><b>סה"כ כולל הכל (${label})</b></td><td colspan="4" id="grandTotal" style="border:1px solid #d8dced;padding:8px 10px;text-align:right"><b style="color:#4338ca;font-size:15.5px">${_nisFmt(grand)}</b></td></tr>
      </tbody>
    </table></div>`;
}
window.editReport = async (i, f, val) => {
  const row = _report.rows[i]; if (!row) return;
  if (['payment', 'bonus', 'food'].includes(f)) row[f] = val === '' ? 0 : +val; else row[f] = val;
  // עדכון הסכומים בלבד (שומר על הפוקוס)
  const sum = (k) => _report.rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const grand = sum('payment') + sum('bonus') + sum('food');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
  set('sumPay', '<b>' + _nisFmt(sum('payment')) + '</b>'); set('sumBonus', '<b>' + _nisFmt(sum('bonus')) + '</b>'); set('sumFood', '<b>' + _nisFmt(sum('food')) + '</b>');
  set('grandTotal', '<b style="color:#4338ca;font-size:15px">' + _nisFmt(grand) + '</b>');
  // שמירה לשרת: שדות משותפים על האירוע, שדות עובד על employeeDetails
  const ev = await fetchEventById(row.eventId); if (!ev) return;
  if (f === 'artist' || f === 'location') { ev[f] = val; }
  else {
    ev.employeeDetails = ev.employeeDetails || [];
    let d = ev.employeeDetails.find(x => x.name === _report.empName);
    if (!d) { d = { name: _report.empName }; ev.employeeDetails.push(d); ev.employees = ev.employees || []; if (!ev.employees.includes(_report.empName)) ev.employees.push(_report.empName); }
    if (f === 'payment') d.rate = val === '' ? null : +val;
    else if (f === 'bonus') d.bonus = val === '' ? null : +val;
    else if (f === 'food') d.food = val === '' ? null : +val;
    else if (f === 'note') d.note = val;
  }
  await fetch(`/api/events/${row.eventId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) }).catch(() => {});
};
window.printJobsReport = () => {
  const el = document.getElementById('jobsReport'); if (!el) return;
  const w = window.open('', '_blank', 'width=820,height=940');
  if (!w) { alert('כדי להדפיס — אשר חלונות קופצים בדפדפן, או פשוט צלם מסך את הדוח.'); return; }
  // ממירים שדות קלט לטקסט להדפסה נקייה
  const clone = el.cloneNode(true);
  clone.querySelectorAll('input').forEach(inp => { const span = document.createElement('span'); span.textContent = inp.value; inp.replaceWith(span); });
  w.document.write(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>דוח עבודות</title>
    <style>body{font-family:'Heebo',Arial,sans-serif;color:#1c2333;padding:26px;margin:0}</style></head>
    <body>${clone.innerHTML}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 350);
};
function empDocChip(e, kind, label) {
  const fid = e.docs && e.docs[kind];
  return fid
    ? `<span style="white-space:nowrap"><a href="/api/files/${fid}" target="_blank" class="tag match" style="text-decoration:none">${label} 👁</a><a onclick="empDelDoc('${fid}')" style="cursor:pointer;color:var(--danger);margin-inline-start:3px">×</a></span>`
    : `<button class="btn ghost" style="padding:2px 8px;font-size:11px;white-space:nowrap" onclick="empUploadDoc('${e.id}','${kind}')">${label} ↑</button>`;
}
function empRow(e) {
  const val = (f) => (e[f] == null ? '' : String(e[f])).replace(/"/g, '&quot;');
  return `<tr>
    <td><div style="display:flex;gap:4px;align-items:center"><input value="${val('name')}" placeholder="שם פרטי" onchange="saveEmp('${e.id}',{name:this.value})" style="width:105px"/><button class="btn ghost" style="padding:4px 7px;font-size:13px" title="ראה עבודות לחודש" onclick="empJobs('${e.id}','${encodeURIComponent(e.name || '')}')">📋</button></div></td>
    <td><input value="${val('lastName')}" placeholder="שם משפחה" onchange="saveEmp('${e.id}',{lastName:this.value})" style="width:110px"/></td>
    <td><input type="number" value="${e.baseRate ?? ''}" placeholder="₪ ליום" onchange="saveEmp('${e.id}',{baseRate:this.value===''?null:+this.value})" style="width:95px"/></td>
    <td><select onchange="saveEmp('${e.id}',{salaryType:this.value})" style="width:88px"><option value="gross"${(e.salaryType || 'gross') === 'gross' ? ' selected' : ''}>ברוטו</option><option value="net"${e.salaryType === 'net' ? ' selected' : ''}>נטו</option></select></td>
    <td><input type="number" value="${e.travel ?? ''}" placeholder="₪" onchange="saveEmp('${e.id}',{travel:this.value===''?null:+this.value})" style="width:85px"/></td>
    <td><input value="${val('idNumber')}" placeholder="מספר זהות" onchange="saveEmp('${e.id}',{idNumber:this.value})" style="width:120px" dir="ltr"/></td>
    <td><input type="email" value="${val('email')}" placeholder="מייל" onchange="saveEmp('${e.id}',{email:this.value})" style="width:150px" dir="ltr"/></td>
    <td>${driveFolderCell(e)}</td>
    <td><button class="btn ghost" style="padding:4px 11px;color:var(--danger)" onclick="delEmp('${e.id}')">מחק</button></td></tr>`;
}
// קישור לתיקיית גוגל דרייב של העובד (ת"ז, אישור ניהול חשבון, טופס 101, רישיון וכו')
function driveFolderCell(e) {
  const url = e.driveFolderUrl || '';
  if (url) return `<div style="display:flex;gap:4px;align-items:center"><a class="btn ghost" style="padding:4px 9px;font-size:12px;white-space:nowrap" href="${url}" target="_blank" rel="noopener">📁 פתח תיקייה</a><button class="btn ghost" style="padding:4px 7px;font-size:12px" title="ערוך קישור" onclick="empSetDrive('${e.id}')">✎</button></div>`;
  return `<button class="btn ghost" style="padding:4px 10px;font-size:12px;white-space:nowrap" onclick="empSetDrive('${e.id}')">🔗 קשר תיקייה</button>`;
}
window.empSetDrive = async (id) => {
  const e = (window._payEmps || []).find(x => x.id === id) || {};
  const url = prompt('הדבק את קישור השיתוף של תיקיית העובד בגוגל דרייב:', e.driveFolderUrl || '');
  if (url === null) return;
  await saveEmp(id, { driveFolderUrl: url.trim() || null });
  renderPayroll($('#content'));
};
window.saveEmp = (id, patch) => fetch(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
window.delEmp = async (id) => { if (!confirm('למחוק עובד מהרשימה?')) return; await fetch(`/api/employees/${id}`, { method: 'DELETE' }); renderPayroll($('#content')); };
window.addEmployeeRow = async () => {
  const name = prompt('שם פרטי של העובד:'); if (!name || !name.trim()) return;
  const lastName = (prompt('שם משפחה (לא חובה):') || '').trim();
  await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), lastName: lastName || null, baseRate: null, companyId: state.company }) });
  renderPayroll($('#content'));
};
window.syncEmployees = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = 'מייבא…'; }
  const r = await fetch(`/api/employees/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: state.company }) }).then(x => x.json()).catch(() => ({ added: 0 }));
  alert(`נוספו ${r.added || 0} עובדים מהאירועים.`);
  renderPayroll($('#content'));
};
async function renderPayroll(c) {
  if (!state.payMonth) state.payMonth = new Date().toISOString().slice(0, 7);
  const month = state.payMonth;
  const [emps, list] = await Promise.all([
    api(`/api/employees?companyId=${state.company}`),
    api(`/api/payroll?companyId=${state.company}&month=${month}`),
  ]);
  window._payEmps = emps;
  const tot = (k) => list.reduce((s, e) => s + (e[k] || 0), 0);
  c.innerHTML = `
    <div class="panel">
      <div class="warn-banner">מסך פנימי — נתוני שכר של עובד אינם נחשפים לעובדים אחרים.</div>
      <div class="row-between"><h2>שכר לתשלום — ${monthLabelFromKey(month)}</h2>${payPeriodControls()}</div>
      ${list.length ? `<div style="overflow-x:auto"><table style="min-width:680px"><thead><tr><th>עובד</th><th>שכר בסיס</th><th>משמרות</th><th>בסיס מצטבר</th><th>בונוס</th><th>סה"כ לתשלום</th></tr></thead>
        <tbody>${list.map(e => `<tr><td><a onclick="empJobsByName('${encodeURIComponent(e.name)}')" style="cursor:pointer;color:var(--accent);font-weight:600">${escapeHtml(e.name)}</a></td><td>${e.baseRate ? money(e.baseRate) : '<span class="muted">—</span>'}</td><td>${e.shifts.length}</td><td>${money(e.base)}</td><td>${money(e.bonus)}</td><td><b>${money(e.total)}</b></td></tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td colspan="3"><b>סה"כ</b></td><td><b>${money(tot('base'))}</b></td><td><b>${money(tot('bonus'))}</b></td><td><b style="color:var(--accent)">${money(tot('total'))}</b></td></tr>
        </tbody></table></div>` : `<div class="empty">אין נתוני שכר לחודש זה. שייך עובדים לאירועים והגדר שכר בסיס למטה.</div>`}
    </div>
    <div class="panel">
      <div class="row-between">
        <div><h2>רשימת עובדים</h2><span class="muted">שכר בסיס ופרטים. לחצן 📋 מציג את העבודות של העובד לחודש שנבחר למעלה. המסמכים (ת"ז/101/רישיון) בתיקיית הדרייב של כל עובד.</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn ghost" onclick="syncEmployees(this)">↺ ייבא מהאירועים</button>
          <button class="btn primary" onclick="addEmployeeRow()">+ עובד</button>
        </div>
      </div>
      <div style="overflow-x:auto"><table style="min-width:820px"><thead><tr>
        <th>שם פרטי</th><th>שם משפחה</th><th>שכר בסיס</th><th>סוג שכר</th><th>החזר נסיעות</th><th>מס ת"ז</th><th>מייל</th><th>תיקיית דרייב</th><th></th></tr></thead>
        <tbody>${emps.length ? emps.map(empRow).join('') : `<tr><td colspan="9"><div class="empty">אין עובדים עדיין. לחץ "ייבא מהאירועים" או "+ עובד".</div></td></tr>`}</tbody></table></div>
    </div>`;
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

const DOC_TYPE_SHORT = { 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 300: 'חשבון עסקה', 330: 'זיכוי', 10: 'הצעת מחיר' };
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
  // מדויק = מספר חשבונית תואם או סכום זהה בדיוק. אחרת (5%/צירוף/שם בלבד) = לבדיקה.
  if (reasons.some(r => r.includes('מספר חשבונית')) || reasons.some(r => r.includes('סכום זהה'))) return 'strong';
  return 'weak';
}
async function bankAction(id, body) {
  const r = await fetch(`/api/bank/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => null);
  const tx = r && r.tx;
  if (tx) { const i = _bankList.findIndex(t => t.id === id); if (i >= 0) _bankList[i] = tx; updateBankRow(tx); }
}
window.approveAllStrong = async (btn) => {
  const strong = bankVisibleRows().filter(t => t.matchStatus === 'auto' && bankConfidence(t) === 'strong');
  if (!strong.length) { alert('אין התאמות מדויקות שממתינות לאישור בתצוגה הנוכחית.'); return; }
  if (!confirm(`לאשר ${strong.length} התאמות מדויקות (סכום זהה או מספר חשבונית)?`)) return;
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
      ${th('date', 'תאריך')}${th('amount', 'סכום בבנק')}${p('סכום חשבונית')}${p('ניכוי במקור')}${th('name', 'שם עסק')}
      ${p('חשבונית מס / מס-קבלה')}${p('קבלה')}${p('הערות')}${p('אישור')}
    </tr></thead><tbody>${rows.map(bankTr).join('')}</tbody></table></div>`
    : `<div class="empty" style="margin-top:14px">אין תנועות בתצוגה הנוכחית.</div>`;
  c.innerHTML = `<div class="panel">
    <div class="row-between">
      <div><h2>🏦 בנק — התאמה לחשבוניות</h2><span class="muted">התאמת תנועות הבנק לחשבוניות ההכנסה מחשבונית ירוקה</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn success" onclick="approveAllStrong(this)">✓ אשר את כל ההתאמות המדויקות</button>
        <button class="btn primary" onclick="openBankImport()">ייבא תנועות</button>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">${bankDirControls()}${bankPeriodControls()}</div>
    ${summary}
    <p class="muted" style="font-size:12.5px;margin-top:10px">תגית ירוקה <b>"מדויק"</b> = סכום זהה או מספר חשבונית (בטוח לאישור) · צהובה <b>"לבדיקה"</b> = ניכוי 5% / צירוף / שם בלבד (כדאי לוודא בתצוגה) · שורות אדומות = לא מותאמות · 🔗 שייך לשיוך ידני.</p>
    ${table}
  </div>`;
}
function bankTr(t) {
  const credit = t.direction === 'credit';
  const amt = `${credit ? '' : '−'}${money(t.absAmount)}`;
  const esc = (u) => String(u).replace(/'/g, '%27');
  const mis = t.matchedInvoices || [];
  const isMatched = credit && mis.length && (t.matchStatus === 'auto' || t.matchStatus === 'manual');
  const notesInput = `<input value="${(t.notes || '').replace(/"/g, '&quot;')}" placeholder="הערה…" onchange="saveBankNotes('${t.id}', this.value)" style="width:120px;padding:4px 7px;font-size:12px"/>`;
  const stack = (arr) => arr.map(x => `<div style="padding:2px 0${arr.length > 1 ? ';border-bottom:1px dashed var(--line)' : ''}">${x}</div>`).join('');
  // תצוגה 👁 + הורדה ↓ צמודים לשם המסמך (במקום עמודות נפרדות)
  const act = (url) => url ? ` <button class="btn ghost" style="padding:1px 7px;font-size:11px" onclick="previewDoc('${esc(url)}')">תצוגה 👁</button> <a href="${url}" target="_blank" class="btn ghost" style="padding:1px 7px;font-size:11px;text-decoration:none;white-space:nowrap">להורדה ↓</a>` : '';
  let biz = '<span class="muted">—</span>', invNo = '—', recNo = '—', invAmt = '—', wh = '—', action = '';

  if (isMatched) {
    biz = stack(mis.map(i => `<b>${escapeHtml(i.clientName || '')}</b>`));
    invNo = stack(mis.map(i => `<span style="white-space:nowrap">${DOC_TYPE_SHORT[i.type] || 'מסמך'} #${i.number}${act(i.url)}</span>`));
    recNo = stack(mis.map(i => i.receipt ? `<span style="white-space:nowrap">קבלה #${i.receipt.number}${act(i.receipt.url)}</span>` : ((i.type == 320) ? '<span class="muted" style="font-size:11px">כלול בחשבונית</span>' : '—')));
    invAmt = stack(mis.map(i => money(i.amount)));
    const sumInv = mis.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const whAmt = sumInv - t.absAmount;
    wh = (whAmt > 1 && whAmt < sumInv * 0.08) ? `<span style="color:var(--warn)">${money(whAmt)}</span>` : '—';
    const conf = bankConfidence(t);
    const confBadge = t.matchStatus === 'auto' && conf ? `<span class="tag ${conf === 'strong' ? 'match' : 'invoiced'}" style="font-size:10px;margin-inline-end:4px">${conf === 'strong' ? 'מדויק' : 'לבדיקה'}</span>` : (t.matchStatus === 'manual' ? '<span class="tag match" style="font-size:10px;margin-inline-end:4px">אושר</span>' : '');
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
    <td style="white-space:nowrap">${invAmt}</td>
    <td style="white-space:nowrap">${wh}</td>
    <td>${biz}</td>
    <td>${invNo}</td>
    <td>${recNo}</td>
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
let _linkTxId = null, _linkSel = [], _linkClients = null, _linkClientDocs = [], _linkClientName = '';
// התאמת סכום בין קבלה לחשבונית (מלא או פחות 5% ניכוי)
const _amtClose = (a, b) => { const t = Math.max(3, (a || 0) * 0.004); return Math.min(Math.abs(a - b), Math.abs(a - b * 0.95)) <= t; };
function linkSelHtml() {
  if (!_linkSel.length) return '<span class="muted">אין מסמכים מקושרים.</span>';
  return _linkSel.map((d, i) => `<div style="padding:3px 0">
    <div style="display:flex;gap:8px;align-items:center;font-size:13px">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${money(d.amount)}</span>
      ${d.url ? `<button class="btn ghost" style="padding:1px 8px;font-size:12px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : ''}
      <button class="btn ghost" style="padding:1px 8px;font-size:12px" onclick="linkRemove(${i})">הסר ×</button></div>
    ${d.receipt ? `<div class="muted" style="font-size:11.5px;margin-top:1px">🧾 קבלה #${d.receipt.number} · ${money(d.receipt.amount)}${d.receipt.url ? ` <button class="btn ghost" style="padding:0 6px;font-size:11px" onclick="previewDoc('${String(d.receipt.url).replace(/'/g, '%27')}')">👁</button>` : ''} <a onclick="linkDetachRec(${i})" style="cursor:pointer;color:var(--danger)">הסר קבלה ×</a></div>` : (Number(d.type) === 320 ? '<div class="muted" style="font-size:11.5px;margin-top:1px">🧾 קבלה כלולה בחשבונית</div>' : '')}
  </div>`).join('');
}
window.openLinkModal = async (txId) => {
  const tx = (_bankList || []).find(t => t.id === txId);
  _linkTxId = txId;
  _linkSel = tx ? JSON.parse(JSON.stringify(tx.matchedInvoices || [])) : [];
  _linkClientDocs = []; _linkClientName = '';
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
  _linkClientDocs = Array.isArray(docs) ? docs : [];
  _linkClientName = decodeURIComponent(name);
  renderLinkDocs();
};
// מציג רק מסמכים פנויים (חשבונית מס / מס-קבלה / קבלה) שלא שויכו עדיין
window.renderLinkDocs = () => {
  const box = document.getElementById('linkDocs'); if (!box) return;
  const { ids, recs } = linkedDocIds();
  const allowed = [305, 320, 400];
  const avail = _linkClientDocs.filter(d => allowed.includes(Number(d.type)) && !ids.has(d.id)
    && !(Number(d.type) === 400 && recs.has(String(d.number))));
  const rows = avail.map(d => {
    const j = encodeURIComponent(JSON.stringify({ id: d.id, number: d.number, type: d.type, clientName: d.clientName, amount: d.amountIncVat, date: d.date, url: d.url }));
    const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : '';
    const dl = d.url ? `<a href="${d.url}" target="_blank" class="btn ghost" style="padding:2px 9px;font-size:11px;text-decoration:none;white-space:nowrap">להורדה ↓</a>` : '';
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${fmtDate(d.date)} · ${money(d.amountIncVat)}</span>
      ${pv}${dl}<button class="btn primary" style="padding:2px 12px;font-size:11px" onclick="linkAdd('${j}')">הוסף</button></div>`;
  }).join('');
  box.innerHTML = `<b style="font-size:13px">מסמכים פנויים של ${escapeHtml(_linkClientName)} (חשבונית מס / מס-קבלה / קבלה):</b>
    <div class="muted" style="font-size:11.5px;margin:2px 0 4px">מוצגים רק מסמכים שאינם משויכים עדיין. קבלה שתוסיף תצורף אוטומטית לחשבונית התואמת.</div>
    ${rows || '<div class="muted" style="font-size:13px;margin-top:4px">אין מסמכים פנויים — כולם כבר משויכים לתנועות אחרות.</div>'}`;
};
const _refreshLink = () => { const b = document.getElementById('linkSelBox'); if (b) b.innerHTML = linkSelHtml(); if (_linkClientDocs.length) renderLinkDocs(); };
window.linkAdd = (j) => {
  const d = JSON.parse(decodeURIComponent(j));
  if (_linkSel.find(x => x.id === d.id)) return;
  if (Number(d.type) === 400) {
    // קבלה — לצרף לחשבונית שנבחרה ללא קבלה, לפי סכום; אחרת להוסיף כשורה נפרדת
    const inv = _linkSel.find(x => Number(x.type) !== 400 && !x.receipt && _amtClose(x.amount, d.amount));
    if (inv) inv.receipt = { number: d.number, url: d.url || null, amount: d.amount };
    else _linkSel.push(d);
  } else {
    // חשבונית — לצרף אליה קבלה תואמת שכבר נבחרה (אם יש)
    const rIdx = _linkSel.findIndex(x => Number(x.type) === 400 && _amtClose(d.amount, x.amount));
    if (rIdx >= 0) { const r = _linkSel[rIdx]; d.receipt = { number: r.number, url: r.url || null, amount: r.amount }; _linkSel.splice(rIdx, 1); }
    _linkSel.push(d);
  }
  _refreshLink();
};
window.linkRemove = (i) => { _linkSel.splice(i, 1); _refreshLink(); };
window.linkDetachRec = (i) => { if (_linkSel[i]) delete _linkSel[i].receipt; _refreshLink(); };
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
  $('#ingestSave').onclick = async (e) => {
    const text = $('#ingestText').value.trim();
    if (!text) return;
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'מנתח…';
    const r = await fetch('/api/events/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, companyId: state.company }) }).then(x => x.json()).catch(() => null);
    btn.disabled = false; btn.textContent = 'נתח ושמור';
    const n = Array.isArray(r) ? r.length : (r ? 1 : 0);
    $('#ingestText').value = ''; $('#ingestModal').classList.add('hidden');
    if (n) alert(`נוספו ${n} אירועים.`);
    state.tab = 'events'; render();
  };
}

boot();
