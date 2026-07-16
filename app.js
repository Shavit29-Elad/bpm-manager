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
  ({ events: renderCombined, invoicing: renderInvoicing, team: renderTeam,
     contractors: renderContractors, payroll: renderPayroll, connections: renderConnections }[state.tab])(c);
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
    </div>`;
  const activeName = state.activeChat === 'group' ? 'כל הצוות' : (members.find(m => m.id === state.activeChat)?.name || '');
  const notice = data.configured ? '' : `<div class="warn-banner">כדי לשוחח עם הצוות צריך מפתח Anthropic. הוסף <b>ANTHROPIC_API_KEY</b> כמשתנה סביבה ב-Render (כמו שאר החיבורים).</div>`;
  c.innerHTML = `<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
    ${sidebar}
    <div class="panel" style="flex:1;min-width:320px;display:flex;flex-direction:column;height:600px">
      <div class="row-between" style="margin-bottom:12px"><h2>${activeName}</h2></div>
      ${notice}
      <div id="chatMsgs" style="flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:4px"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <input id="chatInput" placeholder="כתוב הודעה..." style="flex:1" ${data.configured ? '' : 'disabled'} onkeydown="if(event.key==='Enter')sendChat()"/>
        <button class="btn primary" onclick="sendChat()" ${data.configured ? '' : 'disabled'}>שלח</button>
      </div>
    </div>
  </div>`;
  loadChat();
}

async function loadChat() {
  const msgs = await api(`/api/team/${state.activeChat}/messages`);
  renderMsgs(msgs);
}

function bubble(m) {
  const mine = m.role === 'user';
  const who = mine ? 'אתה' : `${m.emoji || '🤖'} ${m.name || 'עוזר'}`;
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
