// app.js — לוגיקת הממשק (SPA פשוט ללא ספריות)
const state = { company: null, companies: [], tab: 'events' };
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
    pill('ווטסאפ', h.whatsapp === 'connected', h.whatsapp),
  ].join('');
}
const pill = (label, ok, text) =>
  `<span class="pill ${ok ? 'ok' : 'off'}">${label}: ${ok ? 'מחובר' : (text || 'לא מחובר')}</span>`;

function render() {
  const c = $('#content');
  ({ events: renderEvents, calendar: renderCalendar, invoicing: renderInvoicing,
     contractors: renderContractors, payroll: renderPayroll, connections: renderConnections }[state.tab])(c);
}

// ---- אירועים ----
async function renderEvents(c) {
  const events = await api(`/api/events?companyId=${state.company}`);
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
    </div>`;
  $('#addEvent').onclick = () => $('#ingestModal').classList.remove('hidden');
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

// ---- התאמת יומן ----
async function renderCalendar(c) {
  const m = await api(`/api/calendar/match?companyId=${state.company}`);
  const banner = m.calendarError ? `<div class="warn-banner">יומן גוגל לא מחובר עדיין (${m.calendarError}). חבר Access Token כדי לראות התאמות אמיתיות.</div>` : '';
  c.innerHTML = `<div class="panel">${banner}
    <h2>התאמת אירועים מול יומן גוגל</h2>
    <p class="muted">מזהה אירועים שנקלטו בווטסאפ אך חסרים ביומן, ולהיפך.</p>
    <div class="cards" style="margin:14px 0">
      <div class="card"><div class="label">חסר ביומן (יש בווטסאפ)</div><div class="big" style="color:var(--danger)">${m.missingInCalendar.length}</div></div>
      <div class="card"><div class="label">חסר בווטסאפ (יש ביומן)</div><div class="big" style="color:var(--warn)">${m.missingInWhatsapp.length}</div></div>
      <div class="card"><div class="label">הותאמו</div><div class="big" style="color:var(--accent2)">${m.matched.filter(x => x.calendar).length}</div></div>
    </div>
    <table><thead><tr><th>תאריך</th><th>אירוע (ווטסאפ)</th><th>אירוע (יומן)</th><th>סטטוס</th></tr></thead>
    <tbody>${m.matched.map(x => `<tr>
      <td>${x.whatsapp.date || '—'}</td>
      <td>${x.whatsapp.artist || '—'} / ${x.whatsapp.location || ''}</td>
      <td>${x.calendar ? x.calendar.title : '—'}</td>
      <td>${x.calendar ? `<span class="tag match">הותאם (${x.score})</span>` : `<span class="tag miss">חסר ביומן</span>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
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
