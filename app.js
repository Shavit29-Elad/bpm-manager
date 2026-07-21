// app.js — לוגיקת הממשק (SPA פשוט ללא ספריות)
const state = { company: null, companies: [], tab: 'home', user: null };
const $ = (s) => document.querySelector(s);
const money = (n) => (n == null ? '—' : '₪' + Number(n).toLocaleString('he-IL'));
const api = (p) => fetch(p).then(r => r.json());

const TAB_LABELS = { home: '🏠 בית', events: 'אירועים ויומן', clients: 'לקוחות', invoicing: '🧾 חשבוניות', quotes: '📄 הצעות מחיר', contractors: 'קבלנים', payroll: 'עובדים', bank: '🏦 בנק', team: '👥 הצוות', connections: '🔌 חיבורים' };

async function boot() {
  const st = await api('/api/auth/status').catch(() => ({ error: 'net' }));
  if (st && st.setupNeeded) return renderAuthScreen('setup');
  if (!st || !st.authenticated) return renderAuthScreen('login');
  state.user = st.user;
  await startApp();
}

// ---- מסך התחברות / הגדרה ראשונית ----
function renderAuthScreen(mode) {
  document.querySelectorAll('.topbar, .tabs').forEach(el => el.style.display = 'none');
  const isSetup = mode === 'setup';
  const c = $('#content');
  c.innerHTML = `<div style="min-height:70vh;display:flex;align-items:center;justify-content:center">
    <div class="panel" style="width:min(420px,94vw);padding:28px 26px">
      <div style="text-align:center;margin-bottom:6px"><div style="font-size:28px">🎛️</div><h2 style="margin:6px 0 2px">א.ש ניהול פיננסי</h2>
      <div class="muted" style="font-size:13px">${isSetup ? 'הגדרה ראשונית — יצירת משתמש הנהלה' : 'התחברות למערכת'}</div></div>
      ${isSetup ? '<div class="muted" style="font-size:12px;background:var(--panel2);border-radius:8px;padding:8px 10px;margin:8px 0">זו הכניסה הראשונה. בחר שם משתמש וסיסמה למנהל המערכת. הסיסמה נשמרת מוצפנת ונשארת רק אצלך.</div>' : ''}
      <label style="display:block;font-size:13px;margin:12px 0 3px">שם משתמש</label>
      <input id="authUser" autocomplete="username" dir="ltr" style="width:100%;padding:9px 10px" />
      <label style="display:block;font-size:13px;margin:12px 0 3px">סיסמה</label>
      <input id="authPass" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" dir="ltr" style="width:100%;padding:9px 10px" onkeydown="if(event.key==='Enter')doAuth('${mode}',this)" />
      ${isSetup ? `<label style="display:block;font-size:13px;margin:12px 0 3px">אימות סיסמה</label><input id="authPass2" type="password" dir="ltr" style="width:100%;padding:9px 10px" onkeydown="if(event.key==='Enter')doAuth('${mode}',this)" />` : ''}
      <div id="authStatus" style="font-size:13px;min-height:20px;margin:10px 0;color:var(--danger)"></div>
      <button class="btn primary" style="width:100%;padding:10px" onclick="doAuth('${mode}',this)">${isSetup ? 'צור והתחבר' : 'התחבר'}</button>
    </div></div>`;
  setTimeout(() => { const u = document.getElementById('authUser'); if (u) u.focus(); }, 50);
}
window.doAuth = async (mode, btn) => {
  const username = (document.getElementById('authUser').value || '').trim();
  const password = document.getElementById('authPass').value || '';
  const st = document.getElementById('authStatus');
  if (!username || !password) { st.textContent = 'יש למלא שם משתמש וסיסמה.'; return; }
  if (mode === 'setup') {
    if (password.length < 6) { st.textContent = 'הסיסמה חייבת להיות באורך 6 תווים לפחות.'; return; }
    if (password !== (document.getElementById('authPass2').value || '')) { st.textContent = 'הסיסמאות אינן תואמות.'; return; }
  }
  if (btn) btn.disabled = true; st.style.color = 'var(--muted)'; st.textContent = 'מתחבר…';
  const r = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) { document.querySelectorAll('.topbar, .tabs').forEach(el => el.style.display = ''); state.user = r.user; await startApp(); }
  else { if (btn) btn.disabled = false; st.style.color = 'var(--danger)'; st.textContent = r.error || 'שגיאה בהתחברות.'; }
};
window.logout = async () => {
  if (!confirm('להתנתק מהמערכת?')) return;
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

async function startApp() {
  state.companies = await api('/api/companies');
  const sel = $('#companySelect');
  sel.innerHTML = state.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  state.company = state.companies[0]?.id;
  sel.onchange = () => { state.company = sel.value; render(); };
  applyPermissions();

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); state.tab = t.dataset.tab; render();
  });
  setupModal();
  await renderStatus();
  render();
}

// ---- החלת הרשאות: הסתרת לשוניות, מצב צפייה, פרטי משתמש בכותרת ----
function applyPermissions() {
  const u = state.user || {};
  const isAdmin = u.role === 'admin';
  const allowed = isAdmin || u.tabs === 'all' ? null : new Set(u.tabs || []);
  document.querySelectorAll('.tab').forEach(t => {
    const show = !allowed || allowed.has(t.dataset.tab);
    t.style.display = show ? '' : 'none';
  });
  // לשונית פעילה ראשונה מתוך המותרות
  const firstVisible = [...document.querySelectorAll('.tab')].find(t => t.style.display !== 'none');
  if (firstVisible) { document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); firstVisible.classList.add('active'); state.tab = firstVisible.dataset.tab; }
  // מצב צפייה — הסתרת כפתורי פעולה
  document.body.classList.toggle('viewer-mode', !isAdmin);
  // פרטי משתמש + התנתקות + ניהול משתמשים (למנהל) בכותרת
  let box = document.getElementById('userBox');
  if (!box) { box = document.createElement('div'); box.id = 'userBox'; box.style.cssText = 'display:flex;gap:8px;align-items:center;margin-inline-start:auto'; document.querySelector('.topbar').appendChild(box); }
  box.innerHTML = `<span class="muted" style="font-size:12.5px">👤 ${escapeHtml(u.username || '')}${isAdmin ? ' · הנהלה' : ' · צפייה'}</span>
    ${isAdmin ? `<button class="btn ghost" style="padding:3px 10px;font-size:12px" onclick="openUsersModal()">👥 משתמשים</button>` : ''}
    <button class="btn ghost" style="padding:3px 10px;font-size:12px" onclick="logout()">התנתק</button>`;
}

// ---- ניהול משתמשים (מנהל בלבד) ----
let _usersList = [];
const _tabChecks = (cls, sel) => Object.entries(TAB_LABELS).map(([k, l]) => `<label style="display:inline-flex;gap:4px;align-items:center;font-size:12px;margin:2px 8px 2px 0"><input type="checkbox" class="${cls}" value="${k}" ${sel && sel.includes(k) ? 'checked' : ''}> ${l}</label>`).join('');
const _compChecks = (cls, sel) => (state.companies || []).map(c => `<label style="display:inline-flex;gap:4px;align-items:center;font-size:12px;margin:2px 8px 2px 0"><input type="checkbox" class="${cls}" value="${c.id}" ${sel && sel.includes(c.id) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('');
window.openUsersModal = async () => {
  let m = document.getElementById('usersModal');
  if (!m) { m = document.createElement('div'); m.id = 'usersModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw);max-height:90vh;overflow:auto"><div class="empty">טוען משתמשים…</div></div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  const r = await api('/api/users').catch(() => ({ users: [] }));
  _usersList = r.users || [];
  renderUsersModal();
};
function renderUsersModal() {
  const m = document.getElementById('usersModal'); if (!m) return;
  const comps = state.companies || [];
  const admins = _usersList.filter(u => u.role === 'admin');
  const viewers = _usersList.filter(u => u.role !== 'admin');
  const userRow = (u) => `<div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px">
    <div class="row-between"><div><b>${escapeHtml(u.username)}</b> <span class="muted" style="font-size:12px">· צפייה</span></div>
      <div style="display:flex;gap:6px"><button class="btn ghost" style="padding:2px 9px;font-size:11.5px" onclick="editUserRow('${u.id}')">✏️ ערוך</button><button class="btn ghost" style="padding:2px 9px;font-size:11.5px;color:var(--danger)" onclick="deleteUser('${u.id}')">מחק ✕</button></div></div>
    <div class="muted" style="font-size:11.5px;margin-top:4px">לשוניות: ${(u.tabs || []).map(t => TAB_LABELS[t] || t).join(', ') || '—'} · עסקים: ${(u.companies || []).map(id => (comps.find(c => c.id === id) || {}).name || id).join(', ') || '—'}</div>
    <div id="edit-${u.id}"></div></div>`;
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw);max-height:90vh;overflow:auto">
    <div class="row-between"><h3>👥 ניהול משתמשים</h3><button class="btn ghost" onclick="document.getElementById('usersModal').classList.add('hidden')">סגור</button></div>
    <div class="muted" style="font-size:12px;margin:2px 0 10px">משתמשי הנהלה רואים הכל. משתמשי צפייה רואים רק את הלשוניות והעסקים שתסמן, במצב קריאה בלבד.</div>
    ${admins.map(a => `<div class="muted" style="font-size:12.5px">👑 הנהלה: <b>${escapeHtml(a.username)}</b></div>`).join('')}
    <b style="font-size:13px;display:block;margin-top:10px">משתמשי צפייה (${viewers.length})</b>
    <div style="margin-top:6px">${viewers.map(userRow).join('') || '<div class="muted" style="font-size:12.5px">אין עדיין משתמשי צפייה.</div>'}</div>
    <div id="addUserForm" style="border-top:1px solid var(--line);margin-top:12px;padding-top:12px">
      <b style="font-size:13px">➕ הוסף משתמש צפייה</b>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">
        <input id="nuUser" placeholder="שם משתמש" dir="ltr" style="flex:1;min-width:130px;padding:7px 9px">
        <input id="nuPass" type="text" placeholder="סיסמה (6+ תווים)" dir="ltr" style="flex:1;min-width:130px;padding:7px 9px">
      </div>
      <div style="margin-top:8px;font-size:12px;font-weight:600">לשוניות מותרות:</div><div>${_tabChecks('nu-tab', [])}</div>
      <div style="margin-top:8px;font-size:12px;font-weight:600">עסקים מותרים:</div><div>${_compChecks('nu-comp', [])}</div>
      <div id="nuStatus" style="font-size:13px;min-height:18px;margin:6px 0"></div>
      <button class="btn success" onclick="createUser(this)">צור משתמש</button>
    </div></div>`;
}
window.createUser = async (btn) => {
  const f = document.getElementById('addUserForm');
  const username = f.querySelector('#nuUser').value.trim();
  const password = f.querySelector('#nuPass').value;
  const tabs = [...f.querySelectorAll('.nu-tab:checked')].map(x => x.value);
  const companies = [...f.querySelectorAll('.nu-comp:checked')].map(x => x.value);
  const st = document.getElementById('nuStatus');
  if (!username || password.length < 6) { st.style.color = 'var(--danger)'; st.textContent = 'יש להזין שם משתמש וסיסמה (6+ תווים).'; return; }
  if (!tabs.length) { st.style.color = 'var(--danger)'; st.textContent = 'בחר לפחות לשונית אחת.'; return; }
  if (!companies.length) { st.style.color = 'var(--danger)'; st.textContent = 'בחר לפחות עסק אחד.'; return; }
  if (btn) btn.disabled = true;
  const r = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, tabs, companies }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) btn.disabled = false;
  if (r.ok) { _usersList.push(r.user); renderUsersModal(); }
  else { st.style.color = 'var(--danger)'; st.textContent = r.error || 'שגיאה.'; }
};
window.editUserRow = (id) => {
  const u = _usersList.find(x => x.id === id); if (!u) return;
  const box = document.getElementById('edit-' + id); if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = `<div style="border-top:1px dashed var(--line);margin-top:8px;padding-top:8px">
    <div style="font-size:12px;font-weight:600">לשוניות:</div><div>${_tabChecks('eu-tab-' + id, u.tabs)}</div>
    <div style="margin-top:6px;font-size:12px;font-weight:600">עסקים:</div><div>${_compChecks('eu-comp-' + id, u.companies)}</div>
    <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="eu-pass-${id}" type="text" placeholder="סיסמה חדשה (לא חובה)" dir="ltr" style="padding:6px 8px;font-size:12px">
      <button class="btn success" style="padding:3px 12px;font-size:12px" onclick="saveUserEdit('${id}',this)">💾 שמור</button>
    </div><div id="eu-st-${id}" style="font-size:12px;color:var(--danger);min-height:16px"></div></div>`;
};
window.saveUserEdit = async (id, btn) => {
  const tabs = [...document.querySelectorAll('.eu-tab-' + id + ':checked')].map(x => x.value);
  const companies = [...document.querySelectorAll('.eu-comp-' + id + ':checked')].map(x => x.value);
  const pass = document.getElementById('eu-pass-' + id).value;
  const st = document.getElementById('eu-st-' + id);
  if (!tabs.length || !companies.length) { st.textContent = 'בחר לפחות לשונית ועסק אחד.'; return; }
  const body = { tabs, companies }; if (pass) { if (pass.length < 6) { st.textContent = 'סיסמה קצרה מדי.'; return; } body.password = pass; }
  if (btn) btn.disabled = true;
  const r = await fetch('/api/users/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) btn.disabled = false;
  if (r.ok) { const i = _usersList.findIndex(x => x.id === id); if (i >= 0) _usersList[i] = r.user; renderUsersModal(); }
  else st.textContent = r.error || 'שגיאה.';
};
window.deleteUser = async (id) => {
  const u = _usersList.find(x => x.id === id); if (!u) return;
  if (!confirm(`למחוק את המשתמש "${u.username}"?`)) return;
  const r = await fetch('/api/users/' + id, { method: 'DELETE' }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) { _usersList = _usersList.filter(x => x.id !== id); renderUsersModal(); }
  else alert(r.error || 'שגיאה');
};

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
    const blob = await r.blob();
    const t = (blob.type || r.headers.get('content-type') || '').toLowerCase();
    if (_previewBlobUrl) URL.revokeObjectURL(_previewBlobUrl);
    _previewBlobUrl = URL.createObjectURL(blob);
    const cur = document.getElementById('docPreview');
    if (cur && !cur.classList.contains('hidden')) {
      const body = t.startsWith('image')
        ? `<div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;background:#fff;padding:6px"><img src="${_previewBlobUrl}" style="max-width:100%;max-height:100%;object-fit:contain" alt="מסמך"/></div>`
        : `<iframe src="${_previewBlobUrl}#toolbar=1" style="flex:1;width:100%;border:none;background:#fff"></iframe>`;
      cur.innerHTML = shell(body);
    }
  } catch (e) {
    const cur = document.getElementById('docPreview');
    if (cur) cur.innerHTML = shell(`<div class="empty" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px"><div>לא ניתן להציג את המסמך כאן.</div><a href="${url}" target="_blank" class="btn primary" style="text-decoration:none">פתח בכרטיסייה חדשה ↗</a></div>`);
  }
};
window.closePreview = () => {
  const m = document.getElementById('docPreview'); if (m) m.classList.add('hidden');
  if (_previewBlobUrl) { URL.revokeObjectURL(_previewBlobUrl); _previewBlobUrl = null; }
};

// הורדה אוטומטית של קובץ מסמך (PDF) מיד אחרי הפקה, בלי ניווט ובלי לחיצה
function autoDownloadDoc(url) {
  if (!url) return;
  try {
    const a = document.createElement('a');
    a.href = url; a.download = ''; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
}
window.autoDownloadDoc = autoDownloadDoc;

// טבלת מסמכים משותפת (עם פירוק מע"מ). opts.showClient מוסיף עמודת לקוח.
function docsTable(docs, opts = {}) {
  if (docs && docs.error) return `<div class="warn-banner">${docs.error}</div>`;
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return `<div class="empty">אין מסמכים.</div>`;
  const totalInc = rows.reduce((s, d) => s + (Number(d.amountIncVat) || 0), 0);
  const totalEx = rows.reduce((s, d) => s + (Number(d.amountExVat) || 0), 0);
  const cc = opts.showClient;
  const s = opts.sort;
  // תג סטטוס (פתוח/סגור/מבוטל) ליד התאריך
  const statusBadge = (d) => {
    const st = Number(d.status);
    if (d.status == null || Number.isNaN(st)) return '';
    let label = '', bg = '', fg = '#fff';
    if (st === 0) { label = 'פתוח'; bg = 'var(--warn)'; }
    else if (st === 1 || st === 2) { label = 'סגור'; bg = 'var(--accent2)'; }
    else if (st === 3) { label = 'מבטל'; bg = 'var(--muted)'; }
    else if (st === 4) { label = 'מבוטל'; bg = 'var(--danger)'; }
    else return '';
    return `<span style="display:inline-block;margin-inline-start:6px;padding:1px 7px;border-radius:9px;font-size:10.5px;font-weight:600;background:${bg};color:${fg};white-space:nowrap">${label}</span>`;
  };
  // כפתורי פעולה לכל מסמך (בטבלת לקוח): מסמך המשך / שכפול / זיכוי / סמן טופל / פתח מחדש
  const actBtns = (d) => {
    if (!opts.actions) return '';
    const id = d.id, num = escAttr(String(d.number ?? '')), tp = Number(d.type), stt = Number(d.status);
    const bs = 'padding:3px 8px;font-size:11.5px;white-space:nowrap';
    const b = [];
    if (FOLLOWUP_FOR[tp]?.length) b.push(`<button class="btn ghost" style="${bs}" onclick="openDerive('${id}','${num}',${tp},'followup',true)">מסמך המשך ↪</button>`);
    b.push(`<button class="btn ghost" style="${bs}" onclick="openDerive('${id}','${num}',${tp},'duplicate',true)">שכפול ⧉</button>`);
    if (tp === 305 || tp === 320) b.push(`<button class="btn ghost" style="${bs};color:var(--danger)" onclick="openCreditModal('${id}','${num}',${tp})">זיכוי ⊖</button>`);
    if ([10, 300, 305, 320].includes(tp)) {
      if (stt === 0) b.push(`<button class="btn ghost" style="${bs};color:var(--accent2)" onclick="docCloseOpen('${id}','close')">סמן טופל ✓</button>`);
      else if (stt === 1 || stt === 2) b.push(`<button class="btn ghost" style="${bs}" onclick="docCloseOpen('${id}','open')">פתח מחדש ↺</button>`);
    }
    return b.join(' ');
  };
  const th = (key, label) => {
    if (!opts.onSort || !key) return `<th>${label}</th>`;
    const on = s && s.key === key;
    const arw = on ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕';
    return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="${opts.onSort}('${key}')">${label}<span class="muted" style="font-size:11px">${arw}</span></th>`;
  };
  return `<table><thead><tr>${th('date', 'תאריך')}${cc ? th('client', 'לקוח') : ''}${th('type', 'סוג')}${th('number', 'מספר')}<th>כותרת</th>${th('amount', 'סכום ללא מע"מ')}${th('amount', 'סכום כולל מע"מ')}<th></th></tr></thead>
    <tbody>${rows.map(d => `<tr>
      <td style="white-space:nowrap">${fmtDate(d.date)}${statusBadge(d)}</td>${cc ? `<td>${d.clientName || '—'}</td>` : ''}
      <td>${DOC_TYPE_NAMES[d.type] || `סוג ${d.type}`}</td>
      <td>${d.number ?? '—'}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(d.description || '')}">${d.description ? escapeHtml(d.description) : '<span class="muted">—</span>'}</td>
      <td>${money(d.amountExVat)}</td>
      <td>${money(d.amountIncVat)}</td>
      <td><div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap">${d.url ? `<button class="btn ghost" style="padding:5px 11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button><a href="${d.url}" target="_blank" class="muted" style="white-space:nowrap">הורדה ↓</a>` : ''}${actBtns(d)}</div></td>
    </tr>`).join('')}
    <tr style="background:var(--panel2)"><td colspan="${cc ? 5 : 4}"><b>סה"כ</b></td><td><b>${money(totalEx)}</b></td><td><b>${money(totalInc)}</b></td><td></td></tr>
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
// מסמכי המשך מותרים לפי סוג המקור: הצעה→עסקה/מס/מס-קבלה ; עסקה→מס/מס-קבלה ; מס→קבלה
const FOLLOWUP_FOR = { 10: [[300, 'חשבון עסקה'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה']], 300: [[305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה']], 305: [[400, 'קבלה']] };
// שכפול — אפשר לבחור כל סוג (כולל הצעת מחיר)
const DUPLICATE_TYPES = [[300, 'חשבון עסקה'], [305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה'], [10, 'הצעת מחיר']];
window._docActionRefresh = null; // פונקציית רענון אחרי פעולת מסמך (לפי המסך שממנו נפתח)
window.openDerive = (id, number, srcType, mode, fromClient) => {
  window._docActionRefresh = fromClient ? window.reloadClientDocs : null;
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
    st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''} · מוריד קובץ…</span>`;
    autoDownloadDoc(r.doc?.url);
    setTimeout(() => { document.getElementById('derModal').classList.add('hidden'); loadOpenInvoices && loadOpenInvoices(); if (typeof _docActionRefresh === 'function') _docActionRefresh(); }, 1400);
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
let _derBankLink = null; // כשמפיקים מתוך "צור הכנסה" בבנק — לקשר את המסמך שנוצר לתנועת הבנק
window.openDeriveEditor = async (id, type, linked, opts) => {
  opts = opts || {};
  const m = document.getElementById('derModal') || (() => { const x = document.createElement('div'); x.id = 'derModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw)"><div class="empty">טוען שורות מהמסמך…</div></div>`;
  // שולפים במקביל: שורות המקור + התאריך של המסמך האחרון *מסוג היעד* (כמו שחשבונית ירוקה בודקת לכל סוג בנפרד)
  const [r, ld] = await Promise.all([
    api(`/api/documents/${id}/lines`).catch(() => ({ error: 'שגיאת רשת' })),
    api(`/api/documents/last-date?type=${Number(type)}`).catch(() => ({})),
  ]);
  if (!r || !r.ok) { m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)"><div class="warn-banner">שגיאה בטעינת השורות: ${escapeHtml(String(r?.error || ''))}</div><div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('derModal').classList.add('hidden')">סגור</button></div></div>`; return; }
  const needsPay = DER_PAYMENT_DOCS.has(Number(type));
  const items = (r.items || []).map(it => ({ description: it.description || '', quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }));
  const date = opts.date || todayIso();
  _derEdit = {
    id, type: Number(type), linked: linked === true || linked === 'true',
    clientName: r.client?.name || '', date,
    lastDocDate: (ld && ld.lastDocDate) || null, lastDocTypeName: DOC_TYPE_NAMES[Number(type)] || 'מסוג זה', allowBackdate: false,
    description: r.description || '', remarks: r.remarks || '',
    items,
    payments: [], needsPay,
  };
  if (!_derEdit.items.length) _derEdit.items.push({ description: '', quantity: 1, price: 0 });
  // תקבולים: אם הגיע סכום שהתקבל בבנק — נבנה תקבול העברה בנקאית, ובניכוי מס במקור נוסיף שורת ניכוי
  if (needsPay) {
    if (opts.bankReceived != null) {
      const total = derTotals().total;
      const recv = Math.min(Number(opts.bankReceived) || 0, total);
      _derEdit.payments = [{ type: 4, price: +recv.toFixed(2), date, chequeNum: '', bankName: '' }];
      const wh = +(total - recv).toFixed(2);
      if (opts.withholding && wh > 0.5) _derEdit.payments.push({ type: 0, price: wh, date, chequeNum: '', bankName: '' });
    } else {
      _derEdit.payments = [{ type: 4, price: 0, date, chequeNum: '', bankName: '' }];
    }
  }
  _derBankLink = opts.bankTxId ? { txId: opts.bankTxId } : null;
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
window.derToggleBackdate = (checked) => { derSyncFromDom(); _derEdit.allowBackdate = !!checked; renderDeriveEditor(); }; // אישור תאריך מוקדם
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

    <div style="margin:8px 0 4px">
      <label style="font-size:13px">תאריך המסמך <input class="der-date" type="date" value="${e.date}" ${(!e.allowBackdate && e.lastDocDate) ? `min="${e.lastDocDate}"` : ''} style="padding:6px 8px;margin-inline-start:6px"></label>
      ${e.lastDocDate ? `<div style="margin-top:6px;font-size:12px">
        <label style="display:inline-flex;gap:6px;align-items:center;cursor:pointer">
          <input type="checkbox" ${e.allowBackdate ? 'checked' : ''} onchange="derToggleBackdate(this.checked)">
          <span>אפשר תאריך מוקדם מ-${fmtDate(e.lastDocDate)} (${escapeHtml(e.lastDocTypeName || '')} האחרון/ה)</span>
        </label>
        ${e.allowBackdate ? `<div class="warn-banner" style="margin-top:6px;font-size:11.5px">⚠ הפקת מסמך בתאריך מוקדם מ${escapeHtml(e.lastDocTypeName || 'המסמך')} האחרון/ה היא באחריותך — מומלץ להתייעץ עם רו״ח.</div>` : ''}
      </div>` : ''}
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
      <button class="btn primary" onclick="derPreviewPdf(this)">👁 תצוגה מקדימה מעוצבת</button>
      <button class="btn success" id="derConfirmBtn" onclick="derConfirm()">✓ הפק ${typeName}</button>
    </div>
  </div>`;
  m.onclick = (ev) => { if (ev.target === m) m.classList.add('hidden'); };
  derRecalc();
}
window.derPreviewPdf = async (btn) => {
  derSyncFromDom(); const e = _derEdit; if (!e) return;
  const items = e.items.map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
  const st = document.getElementById('derEditStatus');
  if (!items.length) { if (st) st.innerHTML = '<span style="color:var(--danger)">אין שורות לתצוגה.</span>'; return; }
  let payment = [];
  if (e.needsPay) payment = e.payments.map(p => ({ type: Number(p.type), price: Number(p.price) || 0, date: (p.date || e.date), chequeNum: p.chequeNum || '', bankName: p.bankName || '' })).filter(p => Math.abs(p.price) > 0);
  await openDesignedPdf('/api/documents/preview-pdf', { type: e.type, clientName: e.clientName || null, items, description: e.description, date: e.date, remarks: e.remarks, payment }, { statusEl: st, btn });
};
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
    if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''} · מוריד קובץ…</span>`;
    autoDownloadDoc(r.doc?.url);
    // אם הופק מתוך "צור הכנסה" בבנק — לקשר את המסמך שנוצר לתנועת הבנק כדי שתסומן כמותאמת
    if (_derBankLink && r.doc) {
      const entry = { id: r.doc.id, number: r.doc.number, type: e.type, clientName: e.clientName || '', amount: t.total, url: r.doc.url || null };
      await linkDocToBankTx(_derBankLink.txId, entry);
      _derBankLink = null;
    }
    setTimeout(() => { document.getElementById('derModal').classList.add('hidden'); loadOpenInvoices && loadOpenInvoices(); if (typeof _docActionRefresh === 'function') _docActionRefresh(); }, 1400);
  } else {
    if (btn) btn.disabled = false;
    if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};
// קישור מסמך שהופק לתנועת בנק (מוסיף ל-matchedInvoices ומעדכן את השורה)
async function linkDocToBankTx(txId, entry) {
  const tx = (_bankList || []).find(t => t.id === txId); if (!tx) return;
  const matched = [...(tx.matchedInvoices || [])];
  if (!matched.find(x => x.id === entry.id)) matched.push(entry);
  const r = await fetch(`/api/bank/${txId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchStatus: 'manual', matchedInvoices: matched }) }).then(x => x.json()).catch(() => null);
  if (r && r.tx) { const i = _bankList.findIndex(t => t.id === txId); if (i >= 0) _bankList[i] = r.tx; if (typeof updateBankRow === 'function') updateBankRow(r.tx); }
}

// ============ סימון טופל (סגירה) / פתיחה מחדש ============
window.docCloseOpen = async (id, action) => {
  const isClose = action === 'close';
  if (!confirm(isClose
    ? 'לסמן את המסמך כטופל (סגור)?\nניתן לפתוח אותו מחדש בכל עת.'
    : 'לפתוח מחדש את המסמך הסגור?')) return;
  const r = await fetch(`/api/documents/${id}/${action}`, { method: 'POST' }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) { if (typeof reloadClientDocs === 'function') reloadClientDocs(); }
  else alert('שגיאה: ' + (r.error || 'הפעולה נכשלה'));
};

// ============ זיכוי (חד-שלבי מחשבונית מס / דו-שלבי מחשבונית מס-קבלה) ============
window.openCreditModal = (id, number, srcType) => {
  const twoStage = Number(srcType) === 320;
  const srcName = srcType === 320 ? 'חשבונית מס-קבלה' : 'חשבונית מס';
  let m = document.getElementById('creditModal');
  if (!m) { m = document.createElement('div'); m.id = 'creditModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(500px,95vw)">
    <h3 style="color:var(--danger)">הפקת זיכוי — ${srcName} #${escapeHtml(String(number))}</h3>
    <div class="warn-banner" style="margin:8px 0">${twoStage
      ? 'זיכוי לחשבונית מס-קבלה מפיק <b>שני מסמכים</b> לביטול מלא:<br>1) חשבונית זיכוי — לביטול חלק החשבונית.<br>2) קבלה שלילית — לביטול חלק הקבלה (התקבול).'
      : 'תופק <b>חשבונית זיכוי</b> אחת, מקושרת כביטול של החשבונית המקורית.'}</div>
    <label style="font-size:13px;display:block;margin-bottom:8px">תאריך הזיכוי
      <input id="creditDate" type="date" value="${todayIso()}" style="padding:6px 8px;margin-inline-start:6px"></label>
    <p class="muted" style="font-size:12px">המסמכים ייווצרו בחשבונית ירוקה עם אותן שורות/סכומים כמו המקור, ולא ניתנים למחיקה.</p>
    <div id="creditStatus" style="font-size:13px;min-height:18px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('creditModal').classList.add('hidden')">ביטול</button>
      <button class="btn" style="background:var(--danger);color:#fff" id="creditBtn" onclick="doCredit('${id}',${Number(srcType)})">⊖ הפק זיכוי</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
};
window.doCredit = async (id, srcType) => {
  const twoStage = Number(srcType) === 320;
  const date = (document.getElementById('creditDate')?.value || todayIso());
  if (!confirm(twoStage
    ? 'להפיק חשבונית זיכוי + קבלה שלילית לביטול מלא של החשבונית?\nהפעולה יוצרת מסמכים אמיתיים בחשבונית ירוקה.'
    : 'להפיק חשבונית זיכוי לביטול החשבונית?\nהפעולה יוצרת מסמך אמיתי בחשבונית ירוקה.')) return;
  const btn = document.getElementById('creditBtn'); if (btn) btn.disabled = true;
  const st = document.getElementById('creditStatus'); if (st) st.innerHTML = '<span class="muted">מפיק זיכוי…</span>';
  const r = await fetch(`/api/documents/${id}/credit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) {
    const parts = [`✓ חשבונית זיכוי #${r.credit?.number || ''}`];
    if (r.negativeReceipt) parts.push(`קבלה שלילית #${r.negativeReceipt?.number || ''}`);
    if (st) st.innerHTML = `<span style="color:var(--accent2)">${parts.join(' · ')} · מוריד קבצים…</span>`;
    autoDownloadDoc(r.credit?.url);
    if (r.negativeReceipt?.url) setTimeout(() => autoDownloadDoc(r.negativeReceipt.url), 900);
    setTimeout(() => { document.getElementById('creditModal').classList.add('hidden'); if (typeof reloadClientDocs === 'function') reloadClientDocs(); }, 1900);
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
        <input id="clientSearch" placeholder="חיפוש לקוח / מספר מסמך / תיאור…" style="border:none;border-bottom:1px solid var(--line);border-radius:0"/>
        <div id="clientsList" style="overflow-y:auto;flex:1;max-height:70vh">${clientRows(state.clientsList)}</div>
      </div>
      <div id="clientDetail" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:12px;padding:18px;overflow:auto;max-height:70vh">
        <div class="empty">בחר לקוח כדי לראות את כל המסמכים שלו</div>
      </div>
    </div>
  </div>`;
  const inp = $('#clientSearch');
  let _cliSearchTok = 0, _cliSearchTimer = null;
  inp.oninput = () => {
    const v = inp.value.trim();
    const clients = (state.clientsList || []).filter(cl => !v || (cl.name || '').includes(v));
    const listEl = $('#clientsList');
    listEl.innerHTML = clientRows(clients);
    clearTimeout(_cliSearchTimer);
    if (v.length < 2) return;
    // חיפוש מסמכים לפי מספר/תיאור — מוצג מעל רשימת הלקוחות (רק בחיפוש)
    const tok = ++_cliSearchTok;
    _cliSearchTimer = setTimeout(() => {
      fetch('/api/documents/quick-search?q=' + encodeURIComponent(v)).then(r => r.json()).then(r => {
        if (tok !== _cliSearchTok || inp.value.trim() !== v) return; // תוצאה מיושנת
        const items = (r && r.items) || [];
        if (items.length) listEl.innerHTML = docSearchRows(items) + clientRows(clients);
      }).catch(() => {});
    }, 250);
  };
  inp.focus();
}
// שורות תוצאות חיפוש מסמכים (מספר/תיאור) — קליק פותח את הלקוח
function docSearchRows(items) {
  return `<div style="border-bottom:2px solid var(--accent)">
    <div class="muted" style="font-size:11.5px;padding:7px 12px 3px;background:var(--panel2)">📄 מסמכים תואמים (${items.length})</div>
    ${items.map(d => `<div class="chat-item" style="margin:0;border-radius:0;border-bottom:1px solid var(--line);cursor:pointer;background:var(--panel2)" onclick="openDocFromSearch('${d.clientId || ''}','${encodeURIComponent(d.clientName || '')}')">
      <div style="min-width:0;flex:1">
        <div style="font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number || ''} · ${escapeHtml(d.clientName || '—')}</div>
        <div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${fmtDate(d.date)}${d.description ? ' · ' + escapeHtml(d.description) : ''}</div>
      </div>
    </div>`).join('')}
  </div>`;
}
window.openDocFromSearch = (clientId, nameEnc) => {
  if (!clientId) { alert('למסמך זה אין לקוח משויך בחשבונית ירוקה.'); return; }
  selectClient(clientId, nameEnc);
};
function clientRows(list) {
  if (!list.length) return `<div class="empty">לא נמצאו לקוחות.</div>`;
  return list.map(cl => `
    <div class="chat-item" id="cli-${cl.id}" style="margin:0;border-radius:0;border-bottom:1px solid var(--line)" onclick="selectClient('${cl.id}','${encodeURIComponent(cl.name || '')}')">
      <span style="font-size:15px">🏢</span><div style="font-weight:600;font-size:14px">${cl.name}</div>
      <span class="muted" style="margin-inline-start:auto;font-size:14px">‹</span>
    </div>`).join('');
}
let _clientDocs = [], _clientName = '', _clientId = null, _clientSort = { key: 'date', dir: 'desc' }, _clientYear = 'all';
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
  _clientId = id;
  _clientSort = { key: 'date', dir: 'desc' };
  _clientYear = 'all';
  renderClientDetail();
};
// רענון מסמכי הלקוח מהשרת (אחרי פעולה: סגירה/פתיחה/זיכוי/שכפול/מסמך המשך)
window.reloadClientDocs = async () => {
  if (!_clientId) return;
  const docs = await api(`/api/clients/${_clientId}/documents?fresh=1`).catch(() => null);
  if (Array.isArray(docs)) { _clientDocs = docs; renderClientDetail(); }
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
  detail.innerHTML = `<div class="row-between"><h2 style="font-size:17px">${_clientName}</h2><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted" style="font-size:13px">שנה:</span>${yearSel}<span class="muted">${docs.length} מסמכים</span></div></div><div class="muted" style="font-size:12.5px;margin:8px 0 2px">לחיצה על כותרת מיינת לפיה (▲ עולה / ▼ יורד)</div>${docsTable(docs, { showClient: false, sort: _clientSort, onSort: 'setClientSort', actions: true })}`;
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
      ? docs.map(d => `<span class="tag invoiced" style="font-size:10.5px;cursor:pointer;text-decoration:underline" title="לחץ לפתיחת/הורדת המסמך" onclick="openLinkedDoc('${d.id}',this)">${DOC_TYPE_SHORT[d.type] || 'מסמך'}${d.number ? ' #' + d.number : ''} ⬇</span>`).join(' ')
      : `<span class="tag invoiced" ${e.invoiceId ? `style="cursor:pointer;text-decoration:underline" title="לחץ לפתיחת/הורדת המסמך" onclick="openLinkedDoc('${e.invoiceId}',this)"` : ''}>שויך · ${DOC_TYPE_SHORT[e.invoiceType] || 'חשבונית'}${e.invoiceNumber ? ' #' + e.invoiceNumber : ''}${e.invoiceId ? ' ⬇' : ''}</span>`;
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
// פתיחת/הורדת מסמך משויך מחשבונית ירוקה לפי מזהה
window.openLinkedDoc = async (docId, el) => {
  if (!docId) return;
  const prevOpacity = el ? el.style.opacity : '';
  if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
  const r = await api(`/api/documents/${docId}/url`).catch(() => ({ error: 'שגיאת רשת' }));
  if (el) { el.style.opacity = prevOpacity; el.style.pointerEvents = ''; }
  if (r && r.ok && r.url) window.open(r.url, '_blank', 'noopener');
  else alert('לא ניתן לפתוח את המסמך' + (r && r.error ? ': ' + r.error : ''));
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
    const tags = (ev.linkedDocs || []).map(d => `<span class="tag invoiced" style="font-size:10.5px;cursor:pointer;text-decoration:underline" title="לחץ לפתיחת/הורדת המסמך" onclick="openLinkedDoc('${d.id}',this)">${DOC_TYPE_SHORT[d.type] || 'מסמך'}${d.number ? ' #' + d.number : ''} ⬇</span>`).join(' ');
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
      <button class="btn primary" onclick="showDesignedPreview(this)">👁 תצוגה מקדימה מעוצבת</button>
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
// עוזר כללי: מציג PDF מעוצב מ-endpoint תצוגה מקדימה כלשהו בתוך חלון צף
async function openDesignedPdf(endpoint, body, { statusEl, btn, label } = {}) {
  if (btn) { btn.disabled = true; btn.textContent = 'טוען…'; }
  if (statusEl) statusEl.innerHTML = '<span class="muted">טוען תצוגה מקדימה מעוצבת מחשבונית ירוקה…</span>';
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) { btn.disabled = false; btn.textContent = label || '👁 תצוגה מקדימה מעוצבת'; }
  if (r.ok && r.pdfBase64) {
    if (statusEl) statusEl.innerHTML = '';
    const m = document.getElementById('designPvModal') || (() => { const x = document.createElement('div'); x.id = 'designPvModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
    m.style.zIndex = '10050'; // מעל מודל התצוגה המקדימה של האתר כדי שלא יופיע מאחור
    m.classList.remove('hidden');
    m.innerHTML = `<div class="modal-card" style="width:min(920px,97vw);max-height:95vh;overflow:hidden;display:flex;flex-direction:column">
      <div class="row-between" style="margin-bottom:8px"><h3 style="margin:0">תצוגה מקדימה — כפי שייראה בחשבונית ירוקה</h3><button class="btn ghost" style="padding:2px 10px" onclick="document.getElementById('designPvModal').classList.add('hidden')">✕</button></div>
      <iframe src="data:application/pdf;base64,${r.pdfBase64}" style="width:100%;height:80vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
      <p class="muted" style="font-size:12px;margin-top:8px">תצוגה מקדימה בלבד — עדיין לא נוצר מסמך.</p>
    </div>`;
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
    return true;
  }
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger)">לא ניתן להציג תצוגה מקדימה: ${escapeHtml(String(r.error || ''))}</span>`;
  return false;
}
// תצוגה מקדימה מעוצבת (PDF כפי שייראה בחשבונית ירוקה) — בלי להפיק מסמך
window.showDesignedPreview = async (btn) => {
  const p = _invPreview;
  const items = p.items.map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
  const st = document.getElementById('invPvStatus');
  if (!items.length) { if (st) st.innerHTML = '<span style="color:var(--danger)">אין שורות תקינות לתצוגה.</span>'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'טוען…'; }
  if (st) st.innerHTML = '<span class="muted">טוען תצוגה מקדימה מעוצבת מחשבונית ירוקה…</span>';
  const r = await fetch('/api/invoicing/preview-pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIds: p.ids, items, type: p.type, description: p.subject, date: p.docDate || null, clientId: p.clientId, clientName: p.client }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) { btn.disabled = false; btn.textContent = '👁 תצוגה מקדימה מעוצבת'; }
  if (r.ok && r.pdfBase64) {
    if (st) st.innerHTML = '';
    const m = document.getElementById('designPvModal') || (() => { const x = document.createElement('div'); x.id = 'designPvModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
    m.style.zIndex = '10050'; // מעל מודל התצוגה המקדימה של האתר כדי שלא יופיע מאחור
    m.classList.remove('hidden');
    m.innerHTML = `<div class="modal-card" style="width:min(920px,97vw);max-height:95vh;overflow:hidden;display:flex;flex-direction:column">
      <div class="row-between" style="margin-bottom:8px"><h3 style="margin:0">תצוגה מקדימה — כפי שייראה בחשבונית ירוקה</h3><button class="btn ghost" style="padding:2px 10px" onclick="document.getElementById('designPvModal').classList.add('hidden')">✕</button></div>
      <iframe src="data:application/pdf;base64,${r.pdfBase64}" style="width:100%;height:80vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
      <p class="muted" style="font-size:12px;margin-top:8px">תצוגה מקדימה בלבד — עדיין לא הופק מסמך. סגור וחזור ל"✓ הפק בחשבונית ירוקה" כדי ליצור בפועל.</p>
    </div>`;
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  } else if (st) st.innerHTML = `<span style="color:var(--danger)">לא ניתן להציג תצוגה מקדימה: ${escapeHtml(String(r.error || ''))}</span>`;
};
// חלון "החשבונית הופקה בהצלחה" עם אפשרות הורדה מיידית
function showInvoiceDoneDialog(typeName, number, url) {
  autoDownloadDoc(url); // הורדה אוטומטית מיד בהפקה
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
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" onclick="openNewQuote()">+ הצעת מחיר חדשה</button><button class="btn ghost" id="closeSelBtn" onclick="quoteCloseSelected()" disabled>🔒 סגור נבחרות</button></div></div>
    ${r.error ? `<div class="warn-banner" style="margin-top:10px">${escapeHtml(r.error)}</div>` : ''}
    ${docs.length ? `<div style="overflow-x:auto;margin-top:12px"><table><thead><tr><th style="width:34px"><input type="checkbox" onchange="quoteToggleAll(this.checked)"/></th><th>תאריך</th><th>מספר</th><th>לקוח</th><th>תיאור</th><th>סכום</th><th></th></tr></thead>
      <tbody>${docs.map(quoteRow).join('')}</tbody></table></div>`
      : `<div class="empty">אין הצעות מחיר פתוחות 👌</div>`}
  </div>`;
}
// ---- הצעת מחיר חדשה ----
let _nq = null;
window.openNewQuote = async () => {
  const m = document.getElementById('newQuoteModal') || (() => { const x = document.createElement('div'); x.id = 'newQuoteModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw)"><div class="empty">טוען לקוחות…</div></div>`;
  if (!_evClients) { try { _evClients = await api('/api/clients'); } catch { _evClients = []; } }
  _nq = { clientId: '', clientName: '', date: todayIso(), subject: '', remarks: '', email: '', sendEmail: false, items: [{ description: '', quantity: 1, price: 0 }] };
  renderNewQuote();
};
// שכפול הצעת מחיר קיימת לתוך מסך ההצעה החדשה — עם עריכה מלאה (כולל שינוי/הוספת לקוח)
window.openDuplicateQuote = async (id) => {
  const m = document.getElementById('newQuoteModal') || (() => { const x = document.createElement('div'); x.id = 'newQuoteModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw)"><div class="empty">טוען את ההצעה לשכפול…</div></div>`;
  if (!_evClients) { try { _evClients = await api('/api/clients'); } catch { _evClients = []; } }
  const r = await api(`/api/documents/${id}/lines`).catch(() => null);
  if (!r || !r.ok) { m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)"><div class="warn-banner">שגיאה בטעינת ההצעה: ${escapeHtml(String(r?.error || ''))}</div><div class="modal-actions"><button class="btn ghost" onclick="document.getElementById('newQuoteModal').classList.add('hidden')">סגור</button></div></div>`; return; }
  const items = (r.items || []).map(it => ({ description: it.description || '', quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }));
  _nq = { clientId: r.client?.id || '', clientName: r.client?.name || '', date: todayIso(), subject: r.description || '', remarks: r.remarks || '', email: '', sendEmail: false, isDuplicate: true, items: items.length ? items : [{ description: '', quantity: 1, price: 0 }] };
  renderNewQuote();
};
function nqSync() {
  const e = _nq; if (!e) return;
  const m = document.getElementById('newQuoteModal'); if (!m) return;
  const csel = m.querySelector('.nq-client'); if (csel) { e.clientId = csel.value; const c = (_evClients || []).find(x => String(x.id) === String(csel.value)); e.clientName = c ? c.name : ''; }
  const d = m.querySelector('.nq-date'); if (d) e.date = d.value;
  const s = m.querySelector('.nq-subject'); if (s) e.subject = s.value;
  const r = m.querySelector('.nq-remarks'); if (r) e.remarks = r.value;
  const em = m.querySelector('.nq-email'); if (em) e.email = em.value;
  const se = m.querySelector('.nq-sendemail'); if (se) e.sendEmail = se.checked;
  m.querySelectorAll('.nq-item').forEach((row, i) => { if (!e.items[i]) return; e.items[i].description = row.querySelector('.nq-desc')?.value ?? e.items[i].description; e.items[i].quantity = row.querySelector('.nq-qty')?.value ?? e.items[i].quantity; e.items[i].price = row.querySelector('.nq-price')?.value ?? e.items[i].price; });
}
window.nqAddItem = () => { nqSync(); _nq.items.push({ description: '', quantity: 1, price: 0 }); renderNewQuote(); };
window.nqDelItem = (i) => { nqSync(); _nq.items.splice(i, 1); if (!_nq.items.length) _nq.items.push({ description: '', quantity: 1, price: 0 }); renderNewQuote(); };
window.nqClientChanged = () => { nqSync(); renderNewQuote(); };
window.nqRecalc = () => {
  let sub = 0; document.querySelectorAll('#newQuoteModal .nq-item').forEach(row => { sub += (Number(row.querySelector('.nq-qty')?.value) || 0) * (Number(row.querySelector('.nq-price')?.value) || 0); });
  const vat = sub * VAT_RATE, total = sub + vat;
  const box = document.getElementById('nqTotals'); if (box) box.innerHTML = `ביניים: <b>${money(sub)}</b> · מע"מ ${Math.round(VAT_RATE * 100)}%: <b>${money(vat)}</b> · סה"כ: <b style="color:var(--accent2)">${money(total)}</b>`;
};
function renderNewQuote() {
  const e = _nq; if (!e) return;
  const m = document.getElementById('newQuoteModal');
  const clients = (_evClients || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
  const clientOpts = `<option value="">— בחר לקוח —</option>` + clients.map(c => `<option value="${escAttr(String(c.id))}" ${String(c.id) === String(e.clientId) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const itemRows = e.items.map((it, i) => `<div class="nq-item" style="display:grid;grid-template-columns:1fr 62px 96px 28px;gap:6px;align-items:center;margin-bottom:6px">
    <input class="nq-desc" value="${escAttr(it.description)}" placeholder="תיאור" style="padding:6px 8px">
    <input class="nq-qty" type="number" step="any" value="${it.quantity}" oninput="nqRecalc()" style="padding:6px 6px;text-align:center" title="כמות">
    <input class="nq-price" type="number" step="any" value="${it.price}" oninput="nqRecalc()" style="padding:6px 6px;text-align:left" title="מחיר יחידה (ללא מע״מ)">
    <button class="btn ghost" style="padding:4px 8px;font-size:14px" onclick="nqDelItem(${i})" title="מחק שורה">✕</button>
  </div>`).join('');
  const selClient = clients.find(c => String(c.id) === String(e.clientId));
  const email = e.email || (selClient && selClient.email) || '';
  const isIncome = e.type && e.type !== 10;
  const titleTxt = isIncome ? `${DOC_TYPE_NAMES[e.type] || 'מסמך'} חדשה — מאפס` : (e.isDuplicate ? 'שכפול הצעת מחיר — ערוך ושמור כהצעה חדשה' : 'הצעת מחיר חדשה');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw);max-height:92vh;overflow:auto">
    <h3>${titleTxt}</h3>
    ${isIncome ? `<div class="muted" style="font-size:12px;margin:2px 0 6px">ייווצר ${DOC_TYPE_NAMES[e.type]} בחשבונית ירוקה, עם תקבול בהעברה בנקאית על מלוא הסכום בתאריך התנועה${e.bankTxId ? ' ויקושר לתנועת הבנק' : ''}.</div>` : ''}
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px">
      <label style="font-size:13px;flex:1;min-width:260px">לקוח <div style="display:flex;gap:6px;align-items:center;margin-top:3px"><select class="nq-client" onchange="nqClientChanged()" style="flex:1;padding:6px 8px">${clientOpts}</select><button type="button" class="btn ghost" style="padding:6px 10px;font-size:12px;white-space:nowrap" onclick="openAddClientForQuote()">+ לקוח חדש</button></div></label>
      <label style="font-size:13px">תאריך <input class="nq-date" type="date" value="${e.date}" style="padding:6px 8px;margin-top:3px"></label>
    </div>
    <label style="font-size:13px;display:block;margin-bottom:8px">נושא/כותרת <input class="nq-subject" value="${escAttr(e.subject)}" placeholder="נושא ההצעה" style="width:100%;padding:6px 8px;margin-top:3px"></label>
    <div style="font-weight:600;font-size:13px;margin:8px 0 4px">שורות</div>
    <div style="display:grid;grid-template-columns:1fr 62px 96px 28px;gap:6px;font-size:11px;color:var(--muted);margin-bottom:3px"><span>תיאור</span><span style="text-align:center">כמות</span><span style="text-align:left">מחיר</span><span></span></div>
    <div id="nqItems">${itemRows}</div>
    <button class="btn ghost" style="padding:4px 10px;font-size:12px;margin-top:2px" onclick="nqAddItem()">+ הוסף שורה</button>
    <div id="nqTotals" style="margin-top:10px;font-size:14px"></div>
    <label style="font-size:13px;display:block;margin-top:10px">הערה בתחתית (לא חובה) <input class="nq-remarks" value="${escAttr(e.remarks)}" style="width:100%;padding:6px 8px;margin-top:3px"></label>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-top:10px"><input type="checkbox" class="nq-sendemail" ${e.sendEmail ? 'checked' : ''}> שלח את ההצעה ללקוח במייל</label>
    <input class="nq-email" type="email" dir="ltr" value="${escAttr(email)}" placeholder="mail@example.com" style="width:100%;padding:6px 8px;margin-top:6px">
    <div id="nqStatus" style="font-size:13px;min-height:18px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('newQuoteModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="nqPreviewPdf(this)">👁 תצוגה מקדימה מעוצבת</button>
      <button class="btn success" onclick="createNewQuote(this)">✓ ${isIncome ? 'צור ' + (DOC_TYPE_NAMES[e.type] || 'מסמך') : 'צור הצעת מחיר'}</button>
    </div>
  </div>`;
  m.onclick = (ev) => { if (ev.target === m) m.classList.add('hidden'); };
  nqRecalc();
}
window.nqPreviewPdf = async (btn) => {
  nqSync(); const e = _nq;
  const items = e.items.map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
  const st = document.getElementById('nqStatus');
  if (!items.length) { if (st) st.innerHTML = '<span style="color:var(--danger)">אין שורות לתצוגה.</span>'; return; }
  await openDesignedPdf('/api/documents/preview-pdf', { type: e.type || 10, clientId: e.clientId || null, clientName: e.clientName || null, items, description: e.subject, date: e.date, remarks: e.remarks }, { statusEl: st, btn });
};
window.createNewQuote = async (btn) => {
  nqSync(); const e = _nq;
  const items = e.items.map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
  if (!items.length) { alert('יש להזין לפחות שורה אחת עם תיאור.'); return; }
  if (!e.clientId && !e.clientName) { alert('יש לבחור לקוח.'); return; }
  const isIncome = e.type && e.type !== 10;
  const st = document.getElementById('nqStatus');
  // --- מסמך הכנסה מאפס (מס-קבלה / קבלה) ---
  if (isIncome) {
    const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0) * (1 + VAT_RATE);
    const docName = DOC_TYPE_NAMES[e.type] || 'מסמך';
    if (!confirm(`ליצור ${docName} על סך ${money(total)} עבור ${e.clientName || 'הלקוח'}?\nהמסמך ייווצר בחשבונית ירוקה ולא ניתן למחיקה (רק לזכות).`)) return;
    if (btn) btn.disabled = true; if (st) st.innerHTML = `<span class="muted">יוצר ${docName}…</span>`;
    const payment = [{ type: 4, price: +total.toFixed(2), date: e.date }];
    const body = { type: e.type, clientId: e.clientId || null, clientName: e.clientName || null, items, date: e.date, subject: e.subject, remarks: e.remarks, payment };
    const r = await fetch('/api/documents/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
    if (btn) btn.disabled = false;
    if (r.ok) {
      if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ נוצר ${docName} #${r.doc?.number || ''} · מוריד קובץ…</span>`;
      autoDownloadDoc(r.doc?.url);
      if (e.bankTxId && r.doc) await linkDocToBankTx(e.bankTxId, { id: r.doc.id, number: r.doc.number, type: e.type, clientName: e.clientName || '', amount: +total.toFixed(2), url: r.doc.url || null });
      setTimeout(() => { document.getElementById('newQuoteModal').classList.add('hidden'); }, 1300);
    } else if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
    return;
  }
  // --- הצעת מחיר (ברירת מחדל) ---
  if (e.sendEmail && !e.email.trim()) { alert('סמנת "שלח במייל" — יש להזין כתובת מייל.'); return; }
  if (e.sendEmail && !confirm(`ליצור את הצעת המחיר ולשלוח אותה במייל ל-${e.email.trim()}?`)) return;
  if (btn) btn.disabled = true; if (st) st.innerHTML = '<span class="muted">יוצר הצעת מחיר…</span>';
  const body = { clientId: e.clientId || null, clientName: e.clientName || null, items, date: e.date, subject: e.subject, remarks: e.remarks, sendEmail: !!e.sendEmail, email: e.email.trim() };
  const r = await fetch('/api/quotes/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) btn.disabled = false;
  if (r.ok) { if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ נוצרה הצעת מחיר #${r.doc?.number || ''} · מוריד קובץ…</span>`; autoDownloadDoc(r.doc?.url); setTimeout(() => { document.getElementById('newQuoteModal').classList.add('hidden'); renderQuotes($('#content')); }, 1300); }
  else if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
};
// הוספת לקוח חדש מתוך מסך הצעת המחיר — נוצר בחשבונית ירוקה ונבחר אוטומטית
window.openAddClientForQuote = () => {
  const m = document.getElementById('addClientModal') || (() => { const x = document.createElement('div'); x.id = 'addClientModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  const fld = (lbl, inner) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:10px">${lbl}${inner}</label>`;
  m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)">
    <h3>הוספת לקוח חדש לחשבונית ירוקה</h3>
    <p class="muted" style="font-size:12.5px;margin:4px 0 12px">הלקוח ייווצר בחשבונית ירוקה וייבחר אוטומטית להצעה זו.</p>
    ${fld('שם לקוח *', `<input id="ncName" placeholder="שם הלקוח / העסק"/>`)}
    ${fld('מס\' עסק / ח.פ', `<input id="ncTax" dir="ltr" placeholder="ח.פ / ע.מ / ת\"ז"/>`)}
    ${fld('מייל', `<input id="ncEmail" type="email" dir="ltr" placeholder="mail@example.com"/>`)}
    ${fld('שם איש קשר', `<input id="ncContact" placeholder="שם איש קשר"/>`)}
    ${fld('מספר פלאפון', `<input id="ncPhone" type="tel" dir="ltr" placeholder="050-0000000"/>`)}
    <div id="ncStatus" style="font-size:13px;min-height:18px;margin:4px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('addClientModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="saveNewClientForQuote(this)">שמור ובחר</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  setTimeout(() => document.getElementById('ncName')?.focus(), 60);
};
window.saveNewClientForQuote = async (btn) => {
  const g = (id) => document.getElementById(id);
  const st = g('ncStatus');
  const name = g('ncName').value.trim();
  if (!name) { st.innerHTML = '<span style="color:var(--danger)">חובה להזין שם לקוח.</span>'; return; }
  const email = g('ncEmail').value.trim();
  const body = { name, taxId: g('ncTax').value.trim() || null, contactPerson: g('ncContact').value.trim() || null, phone: g('ncPhone').value.trim() || null, emails: [email].filter(Boolean) };
  btn.disabled = true; btn.textContent = 'שומר…'; st.innerHTML = '<span class="muted">יוצר לקוח בחשבונית ירוקה…</span>';
  const r = await fetch('/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = 'שמור ובחר';
  if (!r.ok) { st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא נשמר'))}</span>`; return; }
  const cl = r.client || {};
  const newId = cl.id || cl.clientId || null;
  const newName = cl.name || name;
  _evClients = Array.isArray(_evClients) ? _evClients : [];
  if (newId && !_evClients.some(c => String(c.id) === String(newId))) _evClients.push({ id: newId, name: newName, email: email || null });
  state.clientsList = null; _linkClients = null; // רענון מטמוני לקוחות אחרים
  if (typeof nqSync === 'function') nqSync();          // שמירת מצב ההצעה הנוכחי (שורות, נושא וכו')
  if (_nq && newId) { _nq.clientId = String(newId); _nq.clientName = newName; if (email) _nq.email = email; }
  st.innerHTML = '<span style="color:var(--accent2)">✓ הלקוח נוסף ונבחר</span>';
  setTimeout(() => { document.getElementById('addClientModal').classList.add('hidden'); if (typeof renderNewQuote === 'function') renderNewQuote(); }, 700);
};
function quoteRow(d) {
  const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : '';
  const follow = `<button class="btn primary" style="padding:2px 9px;font-size:12px" onclick="quoteFollowup('${d.id}','${encodeURIComponent(d.clientName || '')}','${d.number}')">הפק מסמך המשך</button>`;
  const dup = `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="openDuplicateQuote('${d.id}')">שכפול ⧉</button>`;
  const close = `<button class="btn ghost" style="padding:2px 9px;font-size:12px" onclick="quoteClose('${d.id}','${d.number}')">סגור הצעה</button>`;
  return `<tr>
    <td style="text-align:center"><input type="checkbox" class="qchk" value="${d.id}" onchange="quoteSelChanged()"/></td>
    <td style="white-space:nowrap">${fmtDate(d.date)}</td><td>#${d.number}</td>
    <td>${escapeHtml(d.clientName || '')}</td><td>${d.description ? escapeHtml(d.description) : '<span class="muted">—</span>'}</td>
    <td style="white-space:nowrap;font-weight:600">${money(d.amount)}</td>
    <td style="text-align:left"><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">${pv}${dup}${follow}${close}</div></td></tr>`;
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
    st.innerHTML = `<span style="color:var(--accent2)">✓ הופק ${typeName} #${r.doc?.number || ''} · מוריד קובץ…</span>`;
    autoDownloadDoc(r.doc?.url);
    setTimeout(() => { document.getElementById('fuModal').classList.add('hidden'); renderQuotes($('#content')); }, 1300);
  } else {
    [...document.querySelectorAll('#fuModal button')].forEach(b => b.disabled = false);
    st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא הופק'))}</span>`;
  }
};

// ---- קבלנים ----
let _suppliers = [];
let _ctrSyncNote = ''; // הודעה על עדכון אוטומטי של שמות קבלנים לפי חשבונית ירוקה
async function renderContractors(c) {
  c.innerHTML = `<div class="panel"><div class="empty">טוען קבלנים ומעדכן שמות לפי חשבונית ירוקה…</div></div>`;
  // עדכון אוטומטי של שמות הקבלנים לפי חשבונית ירוקה (רק התאמות ודאיות) לפני הטעינה
  const sync = await fetch('/api/contractors/auto-sync-names', { method: 'POST' }).then(x => x.json()).catch(() => ({ changed: 0 }));
  _ctrSyncNote = (sync && sync.changed) ? `עודכנו ${sync.changed} שמות קבלנים לפי חשבונית ירוקה` : '';
  const [pay, sup, dr, ms, spRes, notes] = await Promise.all([
    api(`/api/contractors/payables?companyId=${state.company}`),
    api('/api/suppliers').catch(() => []),
    api('/api/expense-drafts').catch(() => ({ drafts: [] })),
    api('/api/mail/status').catch(() => null),
    api('/api/supplier-payables').catch(() => ({ payables: [] })),
    api('/api/expenses/notes').catch(() => ({})),
  ]);
  _expenseNotes = (notes && typeof notes === 'object' && !notes.error) ? notes : {};
  _mailStatus = ms || _mailStatus;
  const supPayables = Array.isArray(spRes?.payables) ? spRes.payables : [];
  _supPayables = supPayables;
  const payables = Array.isArray(pay) ? pay : [];
  _suppliers = Array.isArray(sup) ? sup : [];
  _drafts = Array.isArray(dr?.drafts) ? dr.drafts : [];
  const totalUnpaid = payables.reduce((s, x) => s + (x.unpaidTotal || 0), 0);
  const totalPaid = payables.reduce((s, x) => s + (x.paidTotal || 0), 0);
  c.innerHTML = `<div class="panel" id="draftsPanel">${draftsSection()}</div>
  <div class="panel">${supplierPayablesSection(supPayables)}</div>
  <div class="panel">
    <div class="row-between"><div><h2>רשימת ספקים לתשלום לפי הכנסת אירועים</h2>
      <span class="muted">${payables.length} קבלנים · שולם ${money(totalPaid)} · נותר לתשלום (ללא מע״מ) <b style="color:var(--danger)">${money(totalUnpaid)}</b> · כולל מע״מ <b>${money(totalUnpaid * (1 + VAT_RATE))}</b>. סמן אירועים (או הכל) וקשר אותם לחשבונית הספק, או לחץ "טופל" לסגירת מה שנותר.</span>${_ctrSyncNote ? `<div style="font-size:12px;color:var(--accent2);margin-top:2px">✓ ${_ctrSyncNote}</div>` : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" onclick="openContactForm('supplier')">+ הוסף ספק/קבלן</button></div></div>
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
      ? `<span class="tag invoiced" style="white-space:nowrap">שולם${ev.paidInvoice ? ` · חשבונית ${escapeHtml(String(ev.paidInvoice))}` : ''}</span>${ev.paidExpenseUrl ? ` <button class="btn ghost" style="padding:1px 7px;font-size:10.5px" onclick="previewDoc('${String(ev.paidExpenseUrl).replace(/'/g, '%27')}')">👁</button>` : ''}`
      : `<input type="checkbox" class="ctchk" data-c="${safe}" data-ev="${ev.eventId}" data-ix="${ev.index}"/>`;
    return `<div style="display:flex;gap:10px;align-items:center;padding:7px 12px;border-top:1px solid var(--line);font-size:13px">
      <span style="width:28px;text-align:center">${sel}</span>
      <span class="muted" style="white-space:nowrap">${ddmy(ev.date)}</span>
      <span>${escapeHtml(ev.artist || '')}${ev.location ? ` · ${escapeHtml(ev.location)}` : ''}</span>
      <span style="margin-inline-start:auto;text-align:left;white-space:nowrap"><span style="font-weight:600">${money(ev.amount)}</span> <span class="muted" style="font-size:11px">ללא מע״מ</span><br><span class="muted" style="font-size:11px">כולל מע״מ ${money(ev.amount * (1 + VAT_RATE))}</span></span>
      <button class="btn ${ev.paid ? 'success' : 'ghost'}" style="padding:3px 10px;font-size:12px" onclick="toggleContractorPaid('${ev.eventId}',${ev.index},${ev.paid ? 0 : 1})">${ev.paid ? 'בטל תשלום' : 'שולם'}</button>
    </div>`;
  }).join('');
  return `<div class="card" style="padding:0;overflow:hidden">
    <div class="row-between" style="margin:0;padding:11px 13px;cursor:pointer" onclick="document.getElementById('${safe}').classList.toggle('hidden')">
      <div><b>${escapeHtml(x.name)}</b> <span class="muted">· ${x.events.length} אירועים</span></div>
      <div style="font-size:13px;text-align:left">שולם ${money(x.paidTotal)} · <span style="color:var(--danger)">נותר ${money(x.unpaidTotal)}</span> <span class="muted" style="font-size:11px">ללא מע״מ</span><div class="muted" style="font-size:11px">נותר כולל מע״מ ${money(x.unpaidTotal * (1 + VAT_RATE))}</div></div>
    </div>
    <div id="${safe}" class="${x.events.length > 3 ? 'hidden' : ''}">
      <div style="display:flex;gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);background:var(--panel2)">
        <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" onchange="ctSelectAll('${safe}',this.checked)"/> בחר הכל</label>
        <button class="btn success" style="margin-inline-start:auto;padding:4px 12px;font-size:12px" onclick="ctMarkPaid('${safe}','${encodeURIComponent(x.name)}')">🔗 קשר נבחרים לחשבונית ספק</button>
        <button class="btn ghost" style="padding:4px 12px;font-size:12px" onclick="ctDismissSupplier('${encodeURIComponent(x.name)}')" title="סמן שכל מה שנותר מול הספק טופל">✓ טופל</button>
      </div>
      ${rows}
    </div>
  </div>`;
}
window.ctSelectAll = (safe, on) => { document.querySelectorAll(`.ctchk[data-c="${safe}"]`).forEach(x => { x.checked = on; }); };
// קישור אירועי קבלן שנבחרו לחשבונית ספק אמיתית (מסמכי ההוצאה של הספק בחשבונית ירוקה)
let _ctLink = null;
window.ctMarkPaid = async (safe, nameEnc) => {
  const name = decodeURIComponent(nameEnc);
  const boxes = [...document.querySelectorAll(`.ctchk[data-c="${safe}"]:checked`)];
  if (!boxes.length) { alert('לא נבחרו אירועים'); return; }
  const items = boxes.map(b => ({ eventId: b.dataset.ev, index: +b.dataset.ix }));
  const sup = (_suppliers || []).find(s => (s.name || '').trim() === String(name).trim());
  _ctLink = { items, name, supplierId: sup ? sup.id : null, docs: null, selected: null };
  let m = document.getElementById('ctLinkModal');
  if (!m) { m = document.createElement('div'); m.id = 'ctLinkModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(640px,95vw);max-height:88vh;overflow:auto"><div class="empty">טוען חשבוניות של ${escapeHtml(name)}…</div></div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  if (_ctLink.supplierId) { const docs = await api(`/api/suppliers/${_ctLink.supplierId}/documents`).catch(() => []); _ctLink.docs = Array.isArray(docs) ? docs : []; }
  else _ctLink.docs = [];
  renderCtLink();
};
function renderCtLink() {
  const m = document.getElementById('ctLinkModal'); if (!m || !_ctLink) return;
  const docs = _ctLink.docs || [];
  const rows = docs.map(d => {
    const on = _ctLink.selected && _ctLink.selected.id === d.id;
    const jj = encodeURIComponent(JSON.stringify({ id: d.id, number: d.number, url: d.url || null }));
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 8px;border-top:1px solid var(--line);${on ? 'background:#e7f7ee' : ''}">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${fmtDate(d.date)} · ${money(d.amountIncVat ?? d.amount)}</span>
      ${d.url ? `<button class="btn ghost" style="padding:1px 8px;font-size:11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">👁</button>` : ''}
      <button class="btn ${on ? 'success' : 'ghost'}" style="padding:2px 12px;font-size:11px" onclick="ctLinkPick('${jj}')">${on ? '✓ נבחר' : 'בחר'}</button></div>`;
  }).join('');
  m.innerHTML = `<div class="modal-card" style="width:min(640px,95vw);max-height:88vh;overflow:auto">
    <h3>קישור לחשבונית ספק — ${escapeHtml(_ctLink.name)}</h3>
    <p class="muted" style="font-size:12.5px;margin:2px 0 8px">${_ctLink.items.length} אירועים נבחרו. בחר את חשבונית ההוצאה של הספק שאליה הם שייכים, או הזן מספר ידנית.</p>
    ${_ctLink.supplierId ? (docs.length ? `<div style="border:1px solid var(--line);border-radius:10px;overflow:hidden">${rows}</div>` : '<div class="muted" style="font-size:12.5px">לא נמצאו מסמכי הוצאה לספק זה בחשבונית ירוקה. הזן מספר ידנית למטה.</div>') : '<div class="muted" style="font-size:12.5px">הספק לא מזוהה בחשבונית ירוקה. הזן מספר חשבונית ידנית.</div>'}
    <label style="display:block;font-size:13px;margin-top:10px">או מספר חשבונית ידני <input id="ctManualNum" dir="ltr" placeholder="מספר חשבונית" style="width:100%;padding:6px 8px;margin-top:3px" value="${_ctLink.selected ? escAttr(String(_ctLink.selected.number || '')) : ''}"></label>
    <div id="ctLinkStatus" style="font-size:13px;min-height:18px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('ctLinkModal').classList.add('hidden')">ביטול</button>
      <button class="btn success" onclick="ctLinkConfirm(this)">✓ קשר וסמן כשולם</button>
    </div>
  </div>`;
}
window.ctLinkPick = (jj) => { _ctLink.selected = JSON.parse(decodeURIComponent(jj)); renderCtLink(); };
window.ctLinkConfirm = async (btn) => {
  const manual = (document.getElementById('ctManualNum')?.value || '').trim();
  const sel = _ctLink.selected;
  const invoiceNumber = manual || (sel ? String(sel.number) : '') || null;
  if (!invoiceNumber && !sel) { const st = document.getElementById('ctLinkStatus'); if (st) st.innerHTML = '<span style="color:var(--danger)">בחר חשבונית או הזן מספר.</span>'; return; }
  if (btn) btn.disabled = true;
  await fetch('/api/contractors/mark-paid-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: _ctLink.items, invoiceNumber, expenseId: sel ? sel.id : null, expenseUrl: sel ? sel.url : null, paid: true }) }).catch(() => {});
  document.getElementById('ctLinkModal').classList.add('hidden');
  renderContractors($('#content'));
};
// "טופל" — סימון כל האירועים שנותרו מול הספק כטופלו (יורדים מהרשימה הפתוחה)
window.ctDismissSupplier = async (nameEnc) => {
  const name = decodeURIComponent(nameEnc);
  if (!confirm(`לסמן שכל האירועים שנותרו מול "${name}" טופלו?\nהם ירדו מרשימת הספקים לתשלום (אפשר להחזיר דרך האירוע).`)) return;
  await fetch('/api/contractors/dismiss-supplier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
  renderContractors($('#content'));
};
window.toggleContractorPaid = async (eventId, index, paid) => {
  await fetch('/api/contractors/toggle-paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, index, paid: !!paid }) }).catch(() => {});
  renderContractors($('#content'));
};
// עדכון שמות קבלנים לפי רשימת הספקים בחשבונית ירוקה — כלי מיפוי עם התאמות מוצעות
window.openRenameContractors = async () => {
  const m = document.getElementById('renameCtrModal') || (() => { const x = document.createElement('div'); x.id = 'renameCtrModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(760px,96vw)"><div class="empty">טוען שמות קבלנים וספקים…</div></div>`;
  const [names, sup] = await Promise.all([
    api(`/api/contractors/names?companyId=${state.company}`).catch(() => []),
    api('/api/suppliers').catch(() => []),
  ]);
  const suppliers = (Array.isArray(sup) ? sup : []).map(s => s.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'he'));
  const supSet = new Set(suppliers.map(n => n.trim()));
  const bestMatch = (name) => {
    const t = name.trim();
    const cand = suppliers.filter(s => s.trim() !== t && (s.includes(t) || t.includes(s)));
    return cand.length === 1 ? cand[0] : '';
  };
  const list = Array.isArray(names) ? names : [];
  const rows = list.map(n => {
    const exact = supSet.has(n.name.trim());
    const best = exact ? '' : bestMatch(n.name);
    const opts = `<option value="">— ללא שינוי —</option>` + suppliers.map(s => `<option value="${escAttr(s)}" ${(s === best) ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div><b>${escapeHtml(n.name)}</b> <span class="muted" style="font-size:12px">· ${n.count} אירועים · ${money(n.total)}</span>${exact ? ' <span class="tag invoiced" style="font-size:10px">תואם</span>' : (best ? ' <span class="tag" style="font-size:10px;background:rgba(14,164,114,.14);color:var(--accent2)">הוצע</span>' : '')}</div>
      <select class="renamesel" data-from="${escAttr(n.name)}" style="padding:6px 8px">${opts}</select>
    </div>`;
  }).join('');
  m.innerHTML = `<div class="modal-card" style="width:min(760px,96vw);max-height:90vh;overflow:auto">
    <h3>עדכון שמות קבלנים לפי חשבונית ירוקה</h3>
    <p class="muted" style="font-size:12.5px">לכל שם קבלן מהאירועים בחר את השם המדויק מרשימת הספקים בחשבונית ירוקה. התאמות ודאיות סומנו "הוצע" ונבחרו מראש; "תואם" = כבר זהה. "ללא שינוי" משאיר כמו שהוא. העדכון חל על כל האירועים.</p>
    ${list.length ? rows : '<div class="empty">אין שמות קבלנים באירועים.</div>'}
    <div id="renameStatus" style="font-size:13px;min-height:18px;margin-top:8px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('renameCtrModal').classList.add('hidden')">סגור</button>
      <button class="btn success" onclick="applyRenameContractors()">✓ עדכן שמות</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
};
window.applyRenameContractors = async () => {
  const renames = [...document.querySelectorAll('.renamesel')]
    .map(s => ({ from: s.dataset.from, to: s.value }))
    .filter(r => r.to && r.to.trim() && r.to.trim() !== r.from.trim());
  if (!renames.length) { alert('לא נבחרו שינויים.'); return; }
  if (!confirm(`לעדכן ${renames.length} שמות קבלנים בכל האירועים?\n\n` + renames.map(r => `• ${r.from}  →  ${r.to}`).join('\n'))) return;
  const st = document.getElementById('renameStatus'); if (st) st.innerHTML = '<span class="muted">מעדכן…</span>';
  const r = await fetch('/api/contractors/rename-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ renames }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) { if (st) st.innerHTML = `<span style="color:var(--accent2)">✓ עודכנו ${r.changed} רשומות בקבלנים</span>`; setTimeout(() => { document.getElementById('renameCtrModal').classList.add('hidden'); renderContractors($('#content')); }, 1300); }
  else if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
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
let _mailStatus = null; // סטטוס שליחת מייל לרו"ח
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
  const ms = _mailStatus || {};
  const mailNote = ms.configured
    ? `<div style="font-size:12px;color:var(--accent2);margin-top:2px">📧 כל הוצאה שנקלטת נשלחת אוטומטית לרו"ח: ${escapeHtml(String(ms.forwardTo || ''))}</div>`
    : `<div style="font-size:12px;color:var(--warn);margin-top:2px">📧 שליחת הוצאות לרו"ח (${escapeHtml(String(ms.forwardTo || '516942349@rivh.it'))}) עדיין לא מחוברת — צריך להגדיר חשבון מייל שולח.</div>`;
  return `<div class="row-between"><div><h2>🧾 טיוטות הוצאה לאישור</h2>
      <span class="muted">${list.length ? `${list.length} טיוטות שהעלית וממתינות לאישור. בדוק את מה שהזיהוי האוטומטי קלט, תקן אם צריך, ואשר — תיווצר הוצאה אמיתית שמשויכת לספק.` : 'אין טיוטות ממתינות. העלה קובץ הוצאה כדי שיופיע כאן אחרי זיהוי אוטומטי (OCR).'}</span>${mailNote}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn success" onclick="pickExpenseFile()">📎 העלה קובץ הוצאה</button><button class="btn ghost" onclick="reloadDrafts(this)">↻ רענן</button></div></div>
    <div id="expDropZone" ondragover="expDragOver(event)" ondragleave="expDragLeave(event)" ondrop="expDrop(event)" onclick="pickExpenseFile()" style="border:2px dashed var(--line);border-radius:12px;padding:16px;text-align:center;margin-top:12px;cursor:pointer;transition:border-color .15s,background .15s">
      <div style="font-size:22px">📎⬇️</div>
      <div style="font-size:13.5px;font-weight:600;margin-top:4px">גרור לכאן קובץ הוצאה (PDF / תמונה) או לחץ לבחירה</div>
      <div class="muted" style="font-size:11.5px;margin-top:2px">הקובץ יעלה לחשבונית ירוקה ויעבור זיהוי אוטומטי (OCR)</div>
    </div>
    ${list.length ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">${list.map(draftCard).join('')}</div>` : `<div class="empty">אין טיוטות ממתינות לאישור.</div>`}`;
}
// ===== הוצאות ספקים לתשלום (מסמכי מס שלא שולמו + חשבונות עסקה פנימיים) =====
const PAYABLE_TYPE_NAMES = { 20: 'חשבון עסקה', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'מס-קבלה', 400: 'קבלה', 330: 'זיכוי' };
function supplierPayablesSection(list) {
  const items = Array.isArray(list) ? list : [];
  const total = items.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const rows = items.map(p => {
    const missingAlloc = [305, 320].includes(Number(p.documentType)) && Math.max(Number(p.amount) || 0, Number(p.amountExcludeVat) || 0) > 5000 && !p.allocationNumber;
    return `<div style="padding:10px 12px;border-top:1px solid var(--line);font-size:13px">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="tag" style="${p.isBusinessDoc ? 'background:#fff4e5;color:#8a5a00' : 'background:#eef;color:var(--accent)'}">${PAYABLE_TYPE_NAMES[p.documentType] || ('סוג ' + p.documentType)}${p.isBusinessDoc ? ' · פנימי' : ''}</span>
      <span style="font-weight:600;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.supplierName || 'ספק')}</span>
      ${missingAlloc ? '<span class="tag" style="background:#fde8e8;color:var(--danger);font-size:10.5px;white-space:nowrap">⚠ חסר מס׳ הקצאה</span>' : ''}
      <span class="muted" style="white-space:nowrap">#${escapeHtml(String(p.number || ''))} · ${fmtDate(p.date)}</span>
    </div>
    ${p.description ? `<div class="muted" style="font-size:12px;margin:5px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(p.description)}">${escapeHtml(p.description)}</div>` : ''}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:7px">
      <span style="font-size:12.5px">ללא מע"מ: <b>${money(p.amountExcludeVat)}</b></span>
      <span style="font-size:12.5px">כולל מע"מ: <b style="color:var(--danger)">${money(p.amount)}</b></span>
      <span style="flex:1;min-width:8px"></span>
      ${p.hasFile ? `<button class="btn ghost" style="padding:3px 10px;font-size:12px" onclick="previewDoc('/api/supplier-payables/${p.id}/file')">תצוגה 👁</button>
      <a class="btn ghost" style="padding:3px 10px;font-size:12px;text-decoration:none" href="/api/supplier-payables/${p.id}/file" download target="_blank" rel="noopener">הורדה ↓</a>` : ''}
      <button class="btn ghost" style="padding:3px 10px;font-size:12px" onclick="openEditPayable('${p.id}')" title="עריכת פרטים / השלמת מס׳ הקצאה">✏️ עריכה</button>
      <button class="btn success" style="padding:3px 10px;font-size:12px" onclick="markPayablePaid('${p.id}')">✓ סמן כשולם</button>
      <button class="btn ghost" style="padding:3px 8px;font-size:12px" onclick="deletePayable('${p.id}')" title="הסר רישום">✕</button>
    </div>
  </div>`;
  }).join('');
  return `<div class="row-between"><div><h2>🧾 רשימת ספקים לתשלום</h2>
      <span class="muted">${items.length ? `${items.length} הוצאות שטרם שולמו · סה"כ ${money(total)} (כולל מע"מ). "חשבון עסקה · פנימי" = רישום שלא נשלח לחשבונית ירוקה/רו״ח.` : 'אין הוצאות ספקים פתוחות. הוצאה שתסמן "לא שולם" (או חשבון עסקה) תופיע כאן.'}</span></div></div>
    ${items.length ? `<div style="margin-top:12px;border:1px solid var(--line);border-radius:10px;overflow:hidden">${rows}</div>` : '<div class="empty">אין הוצאות פתוחות לתשלום.</div>'}`;
}
let _supPayables = [];
// עריכת פרטי הוצאת ספק — השלמת מידע שהיה חסר (מס' הקצאה, סכום, תיאור וכו')
window.openEditPayable = (pid) => {
  const p = (_supPayables || []).find(x => x.id === pid); if (!p) return;
  let m = document.getElementById('editPayModal');
  if (!m) { m = document.createElement('div'); m.id = 'editPayModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const fld = (lbl, inner) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:10px">${lbl}${inner}</label>`;
  const typeOpts = [[305, 'חשבונית מס'], [320, 'מס-קבלה'], [300, 'חשבון עסקה'], [400, 'קבלה'], [330, 'זיכוי']].map(([v, l]) => `<option value="${v}" ${Number(p.documentType) === v ? 'selected' : ''}>${l}</option>`).join('');
  m.innerHTML = `<div class="modal-card" style="width:min(520px,95vw)">
    <h3>עריכת הוצאת ספק — ${escapeHtml(p.supplierName || '')}</h3>
    <p class="muted" style="font-size:12px;margin:2px 0 10px">השלם/תקן פרטים שהיו חסרים (למשל מספר הקצאה). העדכון נשמר ברשימת הספקים לתשלום.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:130px">${fld('מספר חשבונית', `<input id="epNum" dir="ltr" value="${escAttr(String(p.number || ''))}"/>`)}</div>
      <div style="flex:1;min-width:130px">${fld('תאריך', `<input id="epDate" type="date" value="${p.date ? String(p.date).slice(0, 10) : ''}"/>`)}</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:130px">${fld('סוג מסמך', `<select id="epType">${typeOpts}</select>`)}</div>
      <div style="flex:1;min-width:130px">${fld('מספר הקצאה', `<input id="epAlloc" dir="ltr" value="${escAttr(String(p.allocationNumber || ''))}" placeholder="מס' הקצאה"/>`)}</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:130px">${fld('סכום כולל מע"מ', `<input id="epAmount" type="number" step="any" value="${p.amount ?? ''}"/>`)}</div>
      <div style="flex:1;min-width:130px">${fld('סכום ללא מע"מ', `<input id="epNet" type="number" step="any" value="${p.amountExcludeVat ?? ''}"/>`)}</div>
    </div>
    ${fld('תיאור', `<input id="epDesc" value="${escAttr(String(p.description || ''))}"/>`)}
    <div id="epStatus" style="font-size:13px;min-height:18px;margin:4px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="document.getElementById('editPayModal').classList.add('hidden')">ביטול</button>
      <button class="btn success" onclick="savePayableEdit('${pid}',this)">💾 שמור</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
};
window.savePayableEdit = async (pid, btn) => {
  const g = (id) => document.getElementById(id);
  const body = { number: g('epNum').value.trim(), date: g('epDate').value || null, documentType: g('epType').value, allocationNumber: g('epAlloc').value.trim(), amount: g('epAmount').value, amountExcludeVat: g('epNet').value, description: g('epDesc').value.trim() };
  const st = g('epStatus'); if (btn) btn.disabled = true; if (st) st.innerHTML = '<span class="muted">שומר…</span>';
  const r = await fetch(`/api/supplier-payables/${pid}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (btn) btn.disabled = false;
  if (r.ok) { document.getElementById('editPayModal').classList.add('hidden'); renderContractors($('#content')); }
  else if (st) st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || ''))}</span>`;
};
window.markPayablePaid = async (pid) => {
  if (!confirm('לסמן את הוצאת הספק כשולמה? היא תרד מהרשימה.')) return;
  const r = await fetch(`/api/supplier-payables/${pid}/paid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) renderContractors($('#content')); else alert('שגיאה: ' + (r.error || ''));
};
window.deletePayable = async (pid) => {
  if (!confirm('להסיר את רישום הוצאת הספק הזה מהרשימה?')) return;
  const r = await fetch(`/api/supplier-payables/${pid}/delete`, { method: 'POST' }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (r.ok) renderContractors($('#content')); else alert('שגיאה: ' + (r.error || ''));
};

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
  // חוסר מספר הקצאה בחשבונית מס/מס-קבלה מעל 5,000 ₪
  const allocMissing = ai && [305, 320].includes(+ai.documentType) && Math.max(+ai.amountInclVat || 0, +ai.amountExcludeVat || 0) > 5000 && !String(ai.allocationNumber || '').trim();
  const allocTag = allocMissing ? ' <span class="tag" style="background:#fde8e8;color:var(--danger)">⚠ חסר מספר הקצאה</span>' : '';
  return `<div class="card" style="padding:12px 14px">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="min-width:190px"><b>${supTxt}</b> ${aiBadge}${allocTag}${statusTag}<br><span class="muted" style="font-size:12.5px">${typeTxt}${number ? ` · מס' ${escapeHtml(String(number))}` : ''}${date ? ` · ${ddmy(date)}` : ''}</span></div>
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
const APPROVE_DOC_TYPES = [[305, 'חשבונית מס'], [320, 'חשבונית מס-קבלה'], [400, 'קבלה'], [20, 'חשבון עסקה / דרישת תשלום (רישום פנימי — לא לחשבונית ירוקה ולא לרו״ח)']];
window.recalcApprVat = () => {
  const g = (x) => document.getElementById(x);
  const amount = +(g('apAmount')?.value) || 0;
  const netIn = g('apNet')?.value;
  const net = netIn !== '' && netIn != null ? +netIn : (amount ? +(amount / 1.18).toFixed(2) : 0);
  const vat = +(amount - net).toFixed(2);
  const el = g('apVat'); if (el) el.textContent = amount ? `מע"מ מחושב: ${money(vat)} · ללא מע"מ: ${money(net)}` : '';
  checkAllocWarn();
};
// מספר הקצאה חובה לחשבונית מס (305) / מס-קבלה (320) מעל 5,000 ₪ (כולל או ללא מע"מ)
window.checkAllocWarn = () => {
  const g = (x) => document.getElementById(x);
  const w = g('apAllocWarn'); if (!w) return;
  const type = +(g('apType')?.value || 0);
  const amount = +(g('apAmount')?.value || 0);
  const netIn = g('apNet')?.value; const net = (netIn !== '' && netIn != null) ? +netIn : 0;
  const needs = [305, 320].includes(type) && Math.max(amount, net) > 5000;
  const alloc = (g('apAlloc')?.value || '').trim();
  if (needs && !alloc) w.innerHTML = '<span style="color:var(--danger);font-weight:600">⚠ חסר מספר הקצאה — חובה לחשבונית מס / מס-קבלה מעל 5,000 ₪</span>';
  else if (needs && alloc) w.innerHTML = '<span style="color:var(--accent2)">✓ מספר הקצאה קיים</span>';
  else w.innerHTML = '';
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
    ? `<div id="apprFilePreview" style="width:100%;height:100%;background:#fff"><div class="empty" style="height:100%;display:flex;align-items:center;justify-content:center">טוען קובץ…</div></div>`
    : `<div class="empty" style="height:100%;display:flex;align-items:center;justify-content:center">אין קובץ לתצוגה</div>`;
  m.innerHTML = `<div class="modal-card" style="width:min(1120px,97vw);max-width:97vw;max-height:92vh;overflow:auto">
    <div class="row-between" style="margin-bottom:6px"><h3 style="margin:0">אישור וקליטת הוצאה</h3>
      <button class="btn ghost" style="padding:2px 10px" onclick="document.getElementById('apprModal').classList.add('hidden')">✕</button></div>
    <p class="muted" style="font-size:12.5px;margin:0 0 10px">ה-AI קורא את החשבונית וממלא את השדות אוטומטית — עליך רק לוודא ולאשר. תיווצר הוצאה בחשבונית ירוקה שתשויך לספק.</p>
    <div style="display:flex;gap:16px;align-items:stretch;flex-wrap:wrap">
      <div style="flex:1 1 380px;min-width:320px;border:1px solid var(--line);border-radius:10px;overflow:hidden;height:82vh;position:sticky;top:0">${preview}</div>
      <div style="flex:1 1 320px;min-width:280px;display:flex;flex-direction:column">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <div id="apAi" style="font-size:12.5px;flex:1"></div>
          <button class="btn ghost" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="aiFillDraft('${d.id}',true)">🤖 קרא עם AI</button>
        </div>
        <div style="padding-inline-start:2px">
          ${fld('שם הספק / קבלן *', `<div style="display:flex;gap:6px;align-items:center"><select id="apSup" style="flex:1" onchange="onApprSupplierChange()"><option value="">— בחר ספק —</option>${supOpts}</select><button type="button" class="btn ghost" style="padding:5px 10px;font-size:12px;white-space:nowrap" onclick="openAddSupplier()">+ ספק חדש</button></div>`)}
          ${fld('סיווג הוצאה (חשבונית ירוקה) *', `<select id="apClass"><option value="">— טוען סיווגים… —</option></select>`)}
          <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);margin:-4px 0 9px"><input type="checkbox" id="apClassSave" checked/> שמור כברירת מחדל לספק זה (כדי שהקליטה הבאה תהיה אוטומטית)</label>
          ${fld('מספר עוסק / ח.פ', `<input id="apTax" dir="ltr" value="${escAttr(String(d.supplierTaxId || ''))}" placeholder="ח.פ / ע.מ"/>`)}
          ${fld('סוג המסמך *', `<select id="apType" onchange="onApprTypeChange()">${typeSel}</select>`)}
          <div id="apBusinessWarn" style="display:none;font-size:12px;background:#fff4e5;border:1px solid var(--warn);color:#8a5a00;border-radius:8px;padding:7px 9px;margin:-4px 0 10px">⚠ חשבון עסקה = <b>רישום פנימי בלבד</b>. לא ייווצר בחשבונית ירוקה ולא יישלח לרו״ח. יופיע ב"הוצאות ספקים לתשלום".</div>
          ${fld('מספר המסמך *', `<input id="apNum" dir="ltr" value="${escAttr(String(d.number || ''))}" placeholder="מספר"/>`)}
          ${fld('מספר הקצאה (חובה לחשבונית מס/מס-קבלה מעל 5,000 ₪)', `<input id="apAlloc" dir="ltr" value="${escAttr(String(d.allocationNumber || ''))}" placeholder="מספר הקצאה מרשות המסים" oninput="checkAllocWarn()"/>`)}
          <div id="apAllocWarn" style="font-size:12px;margin:-4px 0 9px;min-height:14px"></div>
          ${fld('תאריך המסמך *', `<input id="apDate" type="date" value="${d.date || todayIso()}"/>`)}
          ${fld('סכום ההוצאה (כולל מע"מ) ₪ *', `<input id="apAmount" type="number" inputmode="decimal" dir="ltr" value="${d.amount != null ? d.amount : ''}" placeholder="0" oninput="recalcApprVat()"/>`)}
          ${fld('סכום ללא מע"מ ₪', `<input id="apNet" type="number" inputmode="decimal" dir="ltr" value="${d.amountExcludeVat != null ? d.amountExcludeVat : ''}" placeholder="ריק = חישוב אוטומטי 18%" oninput="recalcApprVat()"/>`)}
          <div id="apVat" class="muted" style="font-size:12.5px;margin:-2px 0 10px"></div>
          ${fld('תיאור ההוצאה', `<input id="apDesc" value="${escAttr(String(d.description || ''))}" placeholder="תיאור"/>`)}
          ${fld('סטטוס תשלום *', `<select id="apPaid"><option value="unpaid" selected>עדיין לא שולם (יופיע ב"הוצאות ספקים לתשלום")</option><option value="paid">שולם</option></select>`)}
        </div>
        <div id="apLinkEvents" style="margin:2px 0 8px"></div>
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
  setTimeout(() => { recalcApprVat(); loadApprClassifications(d); onApprTypeChange(); aiFillDraft(d.id); if (d.url) loadApprFilePreview(d.id); loadApprLinkEvents(); }, 30);
};
// טוען את קובץ הטיוטה ומתאים את התצוגה: תמונה → img שמתאים לרוחב (לא ענק) · PDF → iframe
async function loadApprFilePreview(id) {
  const box = document.getElementById('apprFilePreview'); if (!box) return;
  try {
    const resp = await fetch(`/api/expense-drafts/${id}/file`);
    if (!resp.ok) throw new Error('load');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const t = (blob.type || '').toLowerCase();
    if (t.includes('pdf')) {
      box.innerHTML = `<iframe src="${url}#toolbar=1&navpanes=0" style="width:100%;height:100%;border:0;background:#fff" title="תצוגה מקדימה"></iframe>`;
    } else if (t.startsWith('image')) {
      // תמונה: ממלאת את החלונית במלואה (fit) — כל החשבונית נראית בבת אחת, גדול, בלי גלילה
      box.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#fff;padding:4px;box-sizing:border-box"><img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain;display:block" alt="חשבונית"/></div>`;
    } else {
      box.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:0;background:#fff"></iframe>`;
    }
  } catch { box.innerHTML = `<div class="empty" style="height:100%;display:flex;align-items:center;justify-content:center">לא ניתן לטעון את הקובץ. <a href="/api/expense-drafts/${id}/file" target="_blank" style="margin-inline-start:6px">פתח בכרטיסייה ↗</a></div>`; }
}
// טוען את רשימת הסיווגים החשבונאיים ובוחר את ברירת המחדל של הספק (אם יש)
let _classifications = null;
async function loadApprClassifications(d) {
  const sel = document.getElementById('apClass'); if (!sel) return;
  if (!_classifications) {
    const r = await api('/api/accounting/classifications').catch(() => ({ classifications: [] }));
    _classifications = Array.isArray(r.classifications) ? r.classifications : [];
  }
  if (!document.getElementById('apClass')) return;
  if (!_classifications.length) {
    sel.innerHTML = '<option value="">— לא נמצאו סיווגים בחשבונית ירוקה —</option>';
    return;
  }
  sel.innerHTML = '<option value="">— בחר סיווג הוצאה —</option>' + _classifications.map(c => `<option value="${escAttr(String(c.id))}">${escapeHtml(c.name)}</option>`).join('');
  syncApprClassForSupplier(d && d.accountingClassificationId);
}
// בוחר בבורר הסיווג את ברירת המחדל של הספק הנבחר
window.syncApprClassForSupplier = (fallbackId) => {
  const sel = document.getElementById('apClass'); if (!sel) return;
  const supId = document.getElementById('apSup')?.value;
  const sup = (_suppliers || []).find(s => String(s.id) === String(supId));
  const cid = (sup && sup.accountingClassificationId) || fallbackId || '';
  if (cid && [...sel.options].some(o => o.value === String(cid))) sel.value = String(cid);
};
// בחירת ספק בקליטת הוצאה — ממלא אוטומטית את פרטי הספק הידועים (ח.פ) + הסיווג + בודק אירועים לקישור
window.onApprSupplierChange = () => {
  fillApprSupplierDetails();
  syncApprClassForSupplier();
  loadApprLinkEvents();
};
// שינוי סוג המסמך — מציג אזהרת "חשבון עסקה" (רישום פנימי)
window.onApprTypeChange = () => {
  checkAllocWarn();
  const isBiz = +((document.getElementById('apType') || {}).value) === 20;
  const w = document.getElementById('apBusinessWarn'); if (w) w.style.display = isBiz ? 'block' : 'none';
  const cl = document.getElementById('apClass'); if (cl) cl.style.opacity = isBiz ? '0.5' : '1';
};
// טוען אירועים פתוחים של הקבלן ומציע קישור (עם הצעה חכמה מסומנת-מראש)
let _apLinkEventsData = [];
window.loadApprLinkEvents = async () => {
  const box = document.getElementById('apLinkEvents'); if (!box) return;
  const supId = document.getElementById('apSup')?.value;
  const sup = (_suppliers || []).find(s => String(s.id) === String(supId));
  const name = sup ? sup.name : '';
  if (!name) { box.innerHTML = ''; _apLinkEventsData = []; return; }
  const amount = document.getElementById('apAmount')?.value || '';
  const date = document.getElementById('apDate')?.value || '';
  const desc = document.getElementById('apDesc')?.value || '';
  box.innerHTML = '<div class="muted" style="font-size:12px">בודק אירועים פתוחים של הקבלן…</div>';
  const r = await fetch(`/api/contractors/open-events?name=${encodeURIComponent(name)}&amount=${encodeURIComponent(amount)}&date=${encodeURIComponent(date)}&desc=${encodeURIComponent(desc)}`).then(x => x.json()).catch(() => ({ events: [] }));
  const evs = r.events || [];
  _apLinkEventsData = evs;
  if (!evs.length) { box.innerHTML = ''; return; }
  const rows = evs.map((e, i) => `<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:5px 8px;border-top:1px solid var(--line)">
    <input type="checkbox" class="ap-link-ev" data-i="${i}" ${e.suggested ? 'checked' : ''} onchange="updateApprLinkSum()">
    <span style="flex:1;min-width:0"><b>${fmtDate(e.date)}</b> · ${escapeHtml(e.artist || '')}${e.location ? ' · ' + escapeHtml(e.location) : ''}</span>
    <span style="font-weight:600;white-space:nowrap">${money(e.amount)}</span>
    ${e.suggested ? '<span class="tag" style="background:#e7f7ee;color:var(--accent2);font-size:10px">מוצע</span>' : ''}
  </label>`).join('');
  box.innerHTML = `<div style="border:1px solid var(--accent);border-radius:10px;overflow:hidden;background:var(--panel2)">
    <div style="padding:8px 10px;font-size:12.5px;font-weight:600;background:var(--panel);display:flex;align-items:center;gap:8px">
      <span style="flex:1">🔗 קישור לאירועים ב"קבלנים לתשלום" (${evs.length} פתוחים)
      <div class="muted" style="font-size:11px;font-weight:400;margin-top:2px">סימנתי מראש הצעה — ודא ותקן. האירועים שתסמן ירדו מ"קבלנים לתשלום" (מכוסים ע״י החשבונית).</div></span>
      <label style="display:flex;gap:5px;align-items:center;font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer">
        <input type="checkbox" id="apLinkSelectAll" onchange="toggleApprLinkAll(this.checked)"> סמן הכל</label>
    </div>
    ${rows}
    <div id="apLinkSum" style="padding:6px 10px;font-size:11.5px" class="muted"></div>
  </div>`;
  updateApprLinkSum();
};
window.toggleApprLinkAll = (checked) => {
  document.querySelectorAll('#apLinkEvents .ap-link-ev').forEach(cb => { cb.checked = checked; });
  updateApprLinkSum();
};
window.updateApprLinkSum = () => {
  const box = document.getElementById('apLinkSum'); if (!box) return;
  let sum = 0, n = 0;
  const all = document.querySelectorAll('#apLinkEvents .ap-link-ev');
  all.forEach(cb => { if (cb.checked) { sum += Number(_apLinkEventsData[+cb.dataset.i]?.amount) || 0; n++; } });
  const selAll = document.getElementById('apLinkSelectAll');
  if (selAll) selAll.checked = all.length > 0 && n === all.length;
  box.textContent = n ? `נבחרו ${n} אירועים · סה"כ ${money(sum)}` : 'לא נבחרו אירועים לקישור';
};
function apGetLinkedEvents() {
  const out = [];
  document.querySelectorAll('#apLinkEvents .ap-link-ev').forEach(cb => { if (cb.checked) { const e = _apLinkEventsData[+cb.dataset.i]; if (e) out.push({ eventId: e.eventId, index: e.index }); } });
  return out;
}
// ממלא את פרטי הספק הידועים מרשימת הספקים (ח.פ). overwrite=true דורס ערך קיים.
function fillApprSupplierDetails(overwrite = true) {
  const supId = document.getElementById('apSup')?.value;
  const sup = (_suppliers || []).find(s => String(s.id) === String(supId));
  const taxEl = document.getElementById('apTax');
  if (sup && sup.taxId && taxEl && (overwrite || !taxEl.value)) taxEl.value = sup.taxId;
}
// קליטה חכמה: AI קורא את קובץ החשבונית וממלא את השדות (עם מטמון לכל טיוטה)
function applyAiFields(f) {
  const g = (x) => document.getElementById(x);
  if (!g('apSup')) return;
  if (f.supplierId && [...g('apSup').options].some(o => o.value === String(f.supplierId))) { g('apSup').value = String(f.supplierId); fillApprSupplierDetails(false); }
  if (f.taxId && !g('apTax').value) g('apTax').value = f.taxId;
  if (f.documentType && [...g('apType').options].some(o => +o.value === +f.documentType)) g('apType').value = String(f.documentType);
  if (f.invoiceNumber) g('apNum').value = f.invoiceNumber;
  if (f.allocationNumber && g('apAlloc') && !g('apAlloc').value) g('apAlloc').value = f.allocationNumber;
  if (f.date) g('apDate').value = f.date;
  if (f.amountInclVat) g('apAmount').value = f.amountInclVat;
  if (f.amountExcludeVat) g('apNet').value = f.amountExcludeVat;
  if (f.description && !g('apDesc').value) g('apDesc').value = f.description;
  recalcApprVat();
  onApprTypeChange();       // עדכון אזהרת חשבון עסקה לפי הסוג שה-AI זיהה
  loadApprLinkEvents();     // בדיקת אירועים לקישור לפי הספק/סכום/תיאור שזוהו
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
  if (f.supplierName && !matched) return `<span style="color:var(--warn)">🤖 זוהה ע"י AI · ספק "${escapeHtml(f.supplierName)}" לא קיים ברשימה — לחץ "+ ספק חדש" כדי להוסיף</span>`;
  return '<span style="color:var(--accent2)">🤖 מולא ע"י AI — אנא ודא את הפרטים</span>';
}
// הוספת ספק חדש ישירות ממסך אישור ההוצאה — ה-AI קורא את פרטי הספק מהחשבונית, ואז נוצר בחשבונית ירוקה ונבחר
window.openAddSupplier = async () => {
  const getDet = () => _aiByDraft[_openApproveId] || (_drafts || []).find(x => x.id === _openApproveId)?.ai || {};
  const taxCur = document.getElementById('apTax')?.value || '';
  let m = document.getElementById('addSupModal');
  if (!m) { m = document.createElement('div'); m.id = 'addSupModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const fld = (lbl, inner) => `<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted);margin-bottom:10px">${lbl}${inner}</label>`;
  const draw = (det, reading) => {
    m.innerHTML = `<div class="modal-card" style="width:min(460px,94vw)">
      <h3>הוספת ספק לחשבונית ירוקה</h3>
      <div id="nsAi" style="font-size:12px;margin:2px 0 10px">${reading
        ? '<span class="muted">🤖 קורא את פרטי הספק מהחשבונית…</span>'
        : '<span style="color:var(--accent2)">🤖 מולא ע"י AI מהחשבונית — ערוך אם צריך</span>'}</div>
      ${fld('שם עסק *', `<input id="nsName" value="${escAttr(det.supplierName || '')}" placeholder="שם העסק"/>`)}
      ${fld('מס\' עוסק / ח.פ', `<input id="nsTax" dir="ltr" value="${escAttr(taxCur || det.taxId || '')}" placeholder="מספר עוסק / ח.פ"/>`)}
      ${fld('איש קשר', `<input id="nsContact" value="${escAttr(det.supplierContact || '')}" placeholder="שם איש קשר"/>`)}
      ${fld('מס\' פלאפון', `<input id="nsPhone" type="tel" dir="ltr" value="${escAttr(det.supplierPhone || '')}" placeholder="050-0000000"/>`)}
      ${fld('מייל', `<input id="nsEmail" type="email" dir="ltr" value="${escAttr(det.supplierEmail || '')}" placeholder="mail@example.com"/>`)}
      <div id="nsStatus" style="font-size:13px;min-height:18px;margin:4px 0"></div>
      <div class="modal-actions">
        <button class="btn ghost" onclick="document.getElementById('addSupModal').classList.add('hidden')">ביטול</button>
        <button class="btn primary" onclick="saveNewSupplierInline(this)">שמור ובחר</button>
      </div>
    </div>`;
    m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  };
  let det = getDet();
  const hasAny = det.supplierName || det.supplierPhone || det.supplierEmail || det.supplierContact || det.taxId;
  draw(det, !hasAny);
  setTimeout(() => document.getElementById('nsName')?.focus(), 60);
  // אם ה-AI עדיין לא קרא את החשבונית — נקרא עכשיו ואז נמלא את הפרטים
  if (!hasAny && _openApproveId) {
    await aiFillDraft(_openApproveId, false).catch(() => {});
    det = getDet();
    const still = document.getElementById('addSupModal');
    if (still && !still.classList.contains('hidden')) { draw(det, false); setTimeout(() => document.getElementById('nsName')?.focus(), 40); }
  }
};
window.saveNewSupplierInline = async (btn) => {
  const g = (id) => document.getElementById(id);
  const st = g('nsStatus');
  const name = g('nsName').value.trim();
  if (!name) { st.innerHTML = '<span style="color:var(--danger)">חובה להזין שם עסק.</span>'; return; }
  const tax = g('nsTax').value.trim();
  const body = { name, taxId: tax || null, contactPerson: g('nsContact').value.trim() || null, phone: g('nsPhone').value.trim() || null, emails: [g('nsEmail').value.trim()].filter(Boolean) };
  btn.disabled = true; btn.textContent = 'שומר…'; st.innerHTML = '<span class="muted">יוצר ספק בחשבונית ירוקה…</span>';
  const r = await fetch('/api/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = 'שמור ובחר';
  if (!r.ok) { st.innerHTML = `<span style="color:var(--danger)">שגיאה: ${escapeHtml(String(r.error || 'לא נשמר'))}</span>`; return; }
  const sup = r.supplier || {};
  const newId = sup.id || sup.supplierId || null;
  const newSup = { id: newId, name: sup.name || name, taxId: tax || null };
  _suppliers = Array.isArray(_suppliers) ? _suppliers : [];
  if (newId && !_suppliers.some(s => s.id === newId)) _suppliers.push(newSup);
  _evSuppliers = null; // אילוץ ריענון רשימת הספקים בעריכת אירועים
  const sel = g('apSup');
  if (sel && newId) { const o = document.createElement('option'); o.value = newId; o.textContent = newSup.name; sel.appendChild(o); sel.value = String(newId); }
  if (tax && g('apTax') && !g('apTax').value) g('apTax').value = tax;
  st.innerHTML = '<span style="color:var(--accent2)">✓ הספק נוסף לחשבונית ירוקה ונבחר</span>';
  setTimeout(() => { document.getElementById('addSupModal').classList.add('hidden'); }, 800);
};
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
  const docType = +g('apType').value;
  const isBiz = docType === 20; // חשבון עסקה — רישום פנימי
  const alloc = (g('apAlloc')?.value || '').trim();
  const classId = (g('apClass')?.value || '').trim();
  const saveClass = !!(g('apClassSave') && g('apClassSave').checked);
  // סיווג נדרש רק למסמך מס אמיתי (לא לחשבון עסקה)
  if (!isBiz && !classId && _classifications && _classifications.length) { st.innerHTML = '<span style="color:var(--danger)">יש לבחור סיווג הוצאה (חשבונית ירוקה דורשת סיווג).</span>'; return; }
  // אזהרה רכה: מספר הקצאה חסר לחשבונית מס/מס-קבלה מעל 5,000 ₪
  const needsAlloc = [305, 320].includes(docType) && Math.max(amount, net || 0) > 5000;
  if (needsAlloc && !alloc && !confirm('חסר מספר הקצאה לחשבונית מס/מס-קבלה מעל 5,000 ₪.\nלהמשיך בכל זאת ולקלוט בלי מספר הקצאה?')) return;
  const paid = (g('apPaid')?.value === 'paid');
  const supplierName = (_suppliers || []).find(s => String(s.id) === String(supplierId))?.name || '';
  const linkedEvents = apGetLinkedEvents();
  const body = { supplierId, supplierName, number, amount, amountExcludeVat: net, taxId: g('apTax').value.trim() || null, date: g('apDate').value || todayIso(), documentType: docType, description: g('apDesc').value.trim(), allocationNumber: alloc || null, accountingClassificationId: classId, saveClassToSupplier: saveClass, paid, linkedEvents };
  btn.disabled = true; btn.textContent = 'מאשר…'; st.innerHTML = `<span class="muted">${isBiz ? 'רושם חשבון עסקה (פנימי)…' : 'יוצר הוצאה בחשבונית ירוקה…'}</span>`;
  const r = await fetch(`/api/expense-drafts/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  btn.disabled = false; btn.textContent = '✓ אשר וצור הוצאה';
  if (r.ok) {
    const linkNote = r.linkedCount ? ` · 🔗 קושרו ${r.linkedCount} אירועים בקבלנים לתשלום` : '';
    let msg;
    if (r.duplicate) { alert('⚠ המסמך כבר קיים במערכת\n\nחשבונית זו כבר נקלטה קודם לכן. כדי למנוע כפילות, הקובץ הכפול נמחק ולא נוצרה הוצאה נוספת.'); msg = '✓ המסמך כבר קיים במערכת — לא נוצרה כפילות.'; }
    else if (r.businessDoc) msg = `✓ נרשם כ"חשבון עסקה" ב"הוצאות ספקים לתשלום" (לא נשלח לחשבונית ירוקה/רו״ח).${linkNote}`;
    else {
      const fwdNote = r.forwarded ? ` · 📧 נשלח גם לרו"ח` : (r.forwardError ? ` · <span style="color:var(--warn)">שליחת המייל לרו"ח נכשלה</span>` : '');
      const payNote = paid ? '' : ' · נוסף ל"הוצאות ספקים לתשלום"';
      msg = `✓ ההוצאה נוצרה ושויכה לספק!${fwdNote}${payNote}${linkNote}`;
    }
    st.innerHTML = `<span style="color:var(--accent2)">${msg}</span>`;
    _drafts = _drafts.filter(x => x.id !== id);
    setTimeout(() => { document.getElementById('apprModal').classList.add('hidden'); if (state.tab === 'contractors') renderContractors($('#content')); }, 1700);
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
  const desc = (_expenseNotes[d.id] != null ? _expenseNotes[d.id] : d.category) || '';
  const isAdmin = state.user && state.user.role === 'admin';
  const viewDl = d.url ? `<a class="btn ghost" style="padding:2px 8px;font-size:12px" href="${d.url}" target="_blank" rel="noopener">תצוגה 👁</a>
    <a class="btn ghost" style="padding:2px 8px;font-size:12px" href="${d.url}" download target="_blank" rel="noopener">הורדה ↓</a>` : '';
  const editBtn = (d.id && isAdmin) ? `<button class="btn ghost" style="padding:2px 8px;font-size:12px" onclick="editExpenseNote('${d.id}')">✏️ ערוך תיאור</button>` : '';
  const acts = (viewDl || editBtn) ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${viewDl}${editBtn}</div>` : '<span class="muted">—</span>';
  return `<tr><td style="white-space:nowrap">${fmtDate(d.date)}</td><td>${escapeHtml(String(d.number || '—'))}</td>
    <td>${escapeHtml(desc)}</td><td style="white-space:nowrap">${money(d.amount)}</td><td>${acts}</td></tr>`;
}
// עריכת תיאור חשבונית ספק — מעדכן בחשבונית ירוקה ובהתאמות הבנק
window.editExpenseNote = async (id) => {
  const cur = (_expenseNotes[id] != null ? _expenseNotes[id] : ((_supDocs || []).find(d => d.id === id) || {}).category) || '';
  const v = prompt('תיאור החשבונית (יעודכן בחשבונית ירוקה ובהתאמות הבנק):', cur);
  if (v === null) return;
  const r = await fetch(`/api/expenses/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: v }) }).then(x => x.json()).catch(() => ({ error: 'שגיאת רשת' }));
  if (!r.ok) { alert('שגיאה: ' + (r.error || '')); return; }
  _expenseNotes[id] = v;
  for (const d of (_supDocs || [])) if (d.id === id) d.category = v;
  for (const t of (_bankList || [])) for (const inv of (t.matchedInvoices || [])) if (inv.id === id) inv.description = v;
  if (r.greenInvoiceUpdated === false) alert('התיאור עודכן במערכת ובהתאמות הבנק. העדכון בחשבונית ירוקה עצמה לא הצליח' + (r.giError ? ': ' + r.giError : '') + '.');
  if (state.tab === 'contractors') renderSupplierDetail();
  else if (state.tab === 'bank') renderBank($('#content'), true);
};
// העלאת קובץ חשבונית של קבלן → נכנס לחשבונית ירוקה כטיוטת הוצאה (OCR), ממתין לאישור
window.pickExpenseFile = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.pdf,.png,.jpg,.jpeg,application/pdf,image/*';
  inp.onchange = () => { const f = inp.files[0]; if (f) handleExpenseFile(f); };
  inp.click();
};
// גרירת קובץ הוצאה לאזור השחרור
window.expDragOver = (e) => { e.preventDefault(); const z = document.getElementById('expDropZone'); if (z) { z.style.borderColor = 'var(--accent)'; z.style.background = 'var(--panel2)'; } };
window.expDragLeave = (e) => { e.preventDefault(); const z = document.getElementById('expDropZone'); if (z) { z.style.borderColor = 'var(--line)'; z.style.background = ''; } };
window.expDrop = (e) => { e.preventDefault(); window.expDragLeave(e); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleExpenseFile(f); };
// העלאת קובץ הוצאה לחשבונית ירוקה + מעקב אחר זיהוי אוטומטי (משמש גם בבחירה וגם בגרירה)
window.handleExpenseFile = async (f) => {
    if (!f) return;
    if (!/\.(pdf|png|jpe?g)$/i.test(f.name) && !/(pdf|image)/i.test(f.type || '')) { alert('יש להעלות קובץ PDF או תמונה.'); return; }
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
let _bankBalance = null;
let _expenseNotes = {};

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

// מצב חשבון: עו"ש עדכני. מעדיפים את היתרה הרשמית מכותרת הקובץ (_bankBalance);
// אם אין — נופלים ליתרה מהתנועה האחרונה שיש בה יתרה.
function bankAccountStatus() {
  const all = _bankList || [];
  const bb = _bankBalance;
  if (!all.length && !bb) return null;
  const key = (d) => { const m = (d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}${m[2]}${m[1]}` : '00000000'; };
  const sorted = [...all].sort((a, b) => key(b.date).localeCompare(key(a.date)) || String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
  const withBal = sorted.find(t => t.balance != null); // התנועה החדשה ביותר שיש בה יתרה רצה
  const lastImport = [...all.map(t => t.importedAt), bb && bb.importedAt].filter(Boolean).sort().pop();
  // שני מקורות ליתרה: כותרת הקובץ (רשמית) והיתרה הרצה מהתנועה האחרונה. בוחרים את המאוחר בתאריך.
  const headerSrc = (bb && bb.balance != null) ? { balance: bb.balance, date: bb.date, official: true } : null;
  const txSrc = withBal ? { balance: withBal.balance, date: withBal.date, official: false } : null;
  let src = headerSrc;
  if (txSrc && (!headerSrc || key(txSrc.date) > key(headerSrc.date))) src = txSrc;
  return {
    balance: src ? src.balance : null,
    balanceDate: src ? src.date : (sorted[0] ? sorted[0].date : null),
    throughDate: sorted[0] ? sorted[0].date : null,
    lastImport, official: !!(src && src.official),
  };
}
function bankHeaderHtml() {
  const s = bankAccountStatus(); if (!s) return '';
  const fmtDt = (iso) => { if (!iso) return '—'; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const stat = (label, val, color) => `<div class="card" style="padding:11px 14px"><div class="label" style="font-size:12px">${label}</div><div style="font-size:18px;font-weight:700;color:${color || 'var(--text)'}">${val}</div></div>`;
  const balLabel = s.official ? 'עו"ש עדכני (יתרת חשבון)' : 'עו"ש עדכני';
  return `<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-top:12px">
    ${stat(balLabel, s.balance != null ? money(s.balance) : '—', (s.balance != null && s.balance < 0) ? 'var(--danger)' : 'var(--accent2)')}
    ${stat(s.official ? 'יתרה נכונה לתאריך' : 'מעודכן עד (תנועה אחרונה)', s.balanceDate || s.throughDate || '—')}
    ${stat('הועלה לאחרונה', fmtDt(s.lastImport))}
  </div>`;
}
// זכות / חובה לפי חודשים
function bankMonthlyHtml() {
  const all = _bankList || [];
  const by = {};
  for (const t of all) {
    const m = (t.date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); if (!m) continue;
    const k = `${m[3]}-${m[2]}`;
    if (!by[k]) by[k] = { credit: 0, debit: 0 };
    if (t.direction === 'credit') by[k].credit += (t.absAmount || 0);
    else if (t.direction === 'debit') by[k].debit += (t.absAmount || 0);
  }
  const keys = Object.keys(by).sort((a, b) => b.localeCompare(a));
  if (!keys.length) return '';
  const label = (k) => { const [y, mo] = k.split('-'); return `${MONTHS_HE[+mo - 1]} ${y}`; };
  const rows = keys.map(k => { const v = by[k]; const net = v.credit - v.debit; return `<tr>
    <td style="white-space:nowrap">${label(k)}</td>
    <td style="color:var(--accent2);font-weight:600">${money(v.credit)}</td>
    <td style="color:var(--danger);font-weight:600">${money(v.debit)}</td>
    <td style="font-weight:700;color:${net >= 0 ? 'var(--accent2)' : 'var(--danger)'}">${money(net)}</td></tr>`; }).join('');
  return `<details style="margin-top:14px" open><summary style="cursor:pointer;font-weight:600;font-size:14px">📊 זכות / חובה לפי חודשים (${keys.length} חודשים)</summary>
    <div style="overflow-x:auto;margin-top:8px"><table style="min-width:440px;font-size:13px"><thead><tr><th>חודש</th><th>זכות (הכנסות)</th><th>חובה (הוצאות)</th><th>נטו</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
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
  _bankBalance = await api(`/api/bank/balance?companyId=${state.company}`).catch(() => null);
  const dir = state.bankFilter || 'credit';
  const rows = bankVisibleRows();
  const summary = `<div id="bankSummary" class="cards" style="grid-template-columns:repeat(auto-fit,minmax(125px,1fr));margin-top:12px;gap:12px">${bankSummaryHtml(rows)}</div>`;

  const bs = state.bankSort || { key: 'date', dir: 'desc' };
  const th = (key, label) => { const on = bs.key === key; const arw = on ? (bs.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'; return `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="setBankSort('${key}')">${label}<span class="muted" style="font-size:11px">${arw}</span></th>`; };
  const p = (label) => `<th style="white-space:nowrap">${label}</th>`;
  const table = rows.length ? `<div style="overflow-x:auto;margin-top:14px"><table style="min-width:1120px;font-size:13px">
    <thead><tr>
      ${th('date', 'תאריך')}${th('amount', 'סכום בבנק')}${p('סכום חשבונית')}${p('ניכוי במקור')}${th('name', 'שם עסק')}
      ${p('חשבונית מס / מס-קבלה')}${p(dir === 'debit' ? 'תיאור החשבונית' : 'קבלה')}${p('הערות')}${p('אישור')}
    </tr></thead><tbody>${rows.map(bankTr).join('')}</tbody></table></div>`
    : `<div class="empty" style="margin-top:14px">אין תנועות בתצוגה הנוכחית.</div>`;
  c.innerHTML = `<div class="panel">
    <div class="row-between">
      <div><h2>🏦 בנק — התאמה לחשבוניות</h2><span class="muted">התאמה אוטומטית: תנועות זכות ↔ חשבוניות הכנסה · תנועות חובה ↔ חשבוניות ספקים</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn success" onclick="approveAllStrong(this)">✓ אשר את כל ההתאמות המדויקות</button>
        <button class="btn primary" onclick="openBankImport()">ייבא תנועות</button>
      </div>
    </div>
    ${bankHeaderHtml()}
    ${bankMonthlyHtml()}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px">${bankDirControls()}${bankPeriodControls()}</div>
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
  const isMatched = mis.length && (t.matchStatus === 'auto' || t.matchStatus === 'manual'); // זכות או חובה
  const notesInput = `<input value="${(t.notes || '').replace(/"/g, '&quot;')}" placeholder="הערה…" onchange="saveBankNotes('${t.id}', this.value)" style="width:120px;padding:4px 7px;font-size:12px"/>`;
  const stack = (arr) => arr.map(x => `<div style="padding:2px 0${arr.length > 1 ? ';border-bottom:1px dashed var(--line)' : ''}">${x}</div>`).join('');
  // תצוגה 👁 + הורדה ↓ צמודים לשם המסמך (במקום עמודות נפרדות)
  const act = (url) => url ? ` <button class="btn ghost" style="padding:1px 7px;font-size:11px" onclick="previewDoc('${esc(url)}')">תצוגה 👁</button> <a href="${url}" target="_blank" class="btn ghost" style="padding:1px 7px;font-size:11px;text-decoration:none;white-space:nowrap">להורדה ↓</a>` : '';
  let biz = '<span class="muted">—</span>', invNo = '—', recNo = '—', invAmt = '—', wh = '—', action = '';

  if (isMatched) {
    biz = stack(mis.map(i => `<b>${escapeHtml(i.clientName || '')}</b>`));
    // מסמך מסוג קבלה (400) תמיד בעמודת "קבלה". שאר הסוגים (מס/מס-קבלה/זיכוי) בעמודת החשבונית.
    invNo = stack(mis.map(i => Number(i.type) === 400
      ? '<span class="muted">—</span>'
      : `<span style="white-space:nowrap">${DOC_TYPE_SHORT[i.type] || 'מסמך'} #${i.number}${act(i.url)}</span>`));
    recNo = stack(mis.map(i => {
      if (Number(i.type) === 400) return `<span style="white-space:nowrap">קבלה #${i.number}${act(i.url)}</span>`;
      if (i.receipt) return `<span style="white-space:nowrap">קבלה #${i.receipt.number}${act(i.receipt.url)}</span>`;
      if (Number(i.type) === 320) return '<span class="muted" style="font-size:11px">כלול בחשבונית</span>';
      return '—';
    }));
    invAmt = stack(mis.map(i => money(i.amount)));
    const sumInv = mis.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const whAmt = sumInv - t.absAmount;
    wh = (whAmt > 1 && whAmt < sumInv * 0.08) ? `<span style="color:var(--warn)">${money(whAmt)}</span>` : '—';
    const conf = bankConfidence(t);
    const confBadge = t.matchStatus === 'auto' && conf ? `<span class="tag ${conf === 'strong' ? 'match' : 'invoiced'}" style="font-size:10px;margin-inline-end:4px">${conf === 'strong' ? 'מדויק' : 'לבדיקה'}</span>` : (t.matchStatus === 'manual' ? '<span class="tag match" style="font-size:10px;margin-inline-end:4px">אושר</span>' : '');
    action = `${confBadge}${t.matchStatus === 'auto' ? `<button class="btn success" style="padding:3px 9px;font-size:12px" onclick="confirmBank('${t.id}')">אשר</button> ` : ''}<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="unmatchBank('${t.id}')">בטל</button>`;
  } else if (t.matchStatus === 'ignored') {
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
    invNo = '<span class="muted">ללא התאמה</span>';
    action = `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="setBankIgnore('${t.id}',false)">החזר</button>`;
  } else if (t.matchStatus === 'unmatched' || (t.suggestions || []).length) {
    // לא מותאם — זכות (חשבוניות הכנסה) או חובה (חשבוניות ספקים). מציג הצעות ללחיצה.
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
    const sugg = (t.suggestions || []).map(s => { const j = encodeURIComponent(JSON.stringify(s)); return `<button class="btn ghost" style="padding:2px 8px;font-size:11px" onclick="matchBank('${t.id}','${j}')">#${s.number} ${escapeHtml(s.clientName || '')} · ${money(s.amount)}</button>`; }).join(' ');
    invNo = `<span class="tag miss" style="font-size:10px">לא מותאם</span>${sugg ? `<div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;max-width:280px">${sugg}</div>` : ''}`;
    action = `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="setBankIgnore('${t.id}',true)">התעלם</button>`;
  } else {
    biz = `<span class="muted">${escapeHtml(t.nameHint || t.description || '')}</span>`;
  }

  // בתצוגת "רק חובה" — העמודה השביעית מציגה את תיאור החשבונית שהותאמה במקום "קבלה"
  if (state.bankFilter === 'debit') {
    const descs = mis.map(i => escapeHtml(i.description || '')).filter(Boolean);
    recNo = descs.length ? stack(descs) : '<span class="muted">—</span>';
  }
  const linkBtn = `<button class="btn ghost" style="padding:3px 9px;font-size:12px" onclick="openLinkModal('${t.id}')">🔗 שייך</button>`;
  // "צור הכנסה" — רק על תנועות זכות (הכנסה): מפיק מס-קבלה/קבלה מחשבונית פתוחה תואמת או מסמך חדש
  const incomeBtn = credit ? `<button class="btn ghost" style="padding:3px 9px;font-size:12px;color:var(--accent2)" onclick="openCreateIncome('${t.id}')">➕ צור הכנסה</button>` : '';
  const rowStyle = (t.matchStatus === 'unmatched') ? 'background:rgba(251,92,125,.12);border-inline-start:3px solid var(--danger)' : (t.matchStatus === 'ignored' ? 'opacity:.55' : '');
  return `<tr id="btr-${t.id}" style="${rowStyle}">
    <td style="white-space:nowrap">${t.date}</td>
    <td style="white-space:nowrap;color:${credit ? 'var(--accent2)' : 'var(--danger)'};font-weight:600">${amt}</td>
    <td style="white-space:nowrap">${invAmt}</td>
    <td style="white-space:nowrap">${wh}</td>
    <td>${biz}</td>
    <td>${invNo}</td>
    <td>${recNo}</td>
    <td>${notesInput}</td>
    <td style="white-space:nowrap"><div style="display:flex;gap:5px;flex-wrap:wrap">${action}${incomeBtn}${linkBtn}</div></td>
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
let _linkTxId = null, _linkSel = [], _linkClients = null, _linkSuppliers = null, _linkClientDocs = [], _linkClientName = '';
let _linkMode = 'clients', _linkDocsKind = 'income', _linkQuery = '', _linkNumTimer = null, _linkNumResults = [], _linkIncludeCredits = false;
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
  _linkClientDocs = []; _linkClientName = ''; _linkQuery = ''; _linkNumResults = []; _linkIncludeCredits = false;
  // תנועת זכות → ברירת מחדל לקוחות (הכנסה) · תנועת חובה → ספקים (הוצאה)
  _linkMode = (tx && tx.direction === 'debit') ? 'suppliers' : 'clients';
  let m = document.getElementById('linkModal');
  if (!m) { m = document.createElement('div'); m.id = 'linkModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  const seg = (mode, label) => `<button onclick="setLinkMode('${mode}')" class="btn ${_linkMode === mode ? 'primary' : 'ghost'}" style="padding:5px 14px;font-size:13px" id="linkSeg-${mode}">${label}</button>`;
  m.innerHTML = `<div class="modal-card" style="width:min(700px,95vw);max-height:88vh;overflow:auto">
    <h3>שיוך ידני של מסמך${tx ? ` — ${tx.date} · ${money(tx.absAmount)}${tx.direction === 'debit' ? ' (חובה)' : ' (זכות)'}` : ''}</h3>
    <div style="margin:8px 0;padding:8px 10px;background:var(--panel2);border-radius:10px"><b style="font-size:13px">מקושר כרגע:</b><div id="linkSelBox" style="margin-top:4px">${linkSelHtml()}</div></div>
    <div style="display:flex;gap:6px;margin:6px 0">${seg('clients', '🏢 לקוחות')}${seg('suppliers', '🏭 ספקים')}</div>
    <label id="linkCreditsWrap" style="display:${_linkMode === 'clients' ? 'flex' : 'none'};gap:6px;align-items:center;font-size:12px;margin:2px 0 4px;cursor:pointer"><input type="checkbox" id="linkCreditsChk" ${_linkIncludeCredits ? 'checked' : ''} onchange="toggleLinkCredits(this.checked)"> כלול גם חשבוניות זיכוי וקבלות שליליות</label>
    <input id="linkClientSearch" placeholder="חפש שם, או מספר מסמך…" style="width:100%;margin:6px 0" oninput="onLinkSearch(this.value)"/>
    <div id="linkNumResults"></div>
    <div id="linkClients" style="max-height:170px;overflow:auto"></div>
    <div id="linkDocs" style="margin-top:10px"></div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn ghost" onclick="document.getElementById('linkModal').classList.add('hidden')">ביטול</button>
      <button class="btn primary" onclick="linkSave()">שמור שיוך</button>
    </div>
  </div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  await ensureLinkPool();
  renderLinkContacts('');
};
// טוען את מאגר הלקוחות/ספקים לפי המצב הנוכחי (פעם אחת כל אחד)
async function ensureLinkPool() {
  const box = document.getElementById('linkClients');
  if (_linkMode === 'suppliers') {
    if (!_linkSuppliers) { if (box) box.innerHTML = '<span class="muted">טוען ספקים…</span>'; _linkSuppliers = await api('/api/suppliers').catch(() => []); }
  } else {
    if (!_linkClients) { if (box) box.innerHTML = '<span class="muted">טוען לקוחות…</span>'; _linkClients = await api('/api/clients').catch(() => []); }
  }
}
window.setLinkMode = async (mode) => {
  if (_linkMode === mode) return;
  _linkMode = mode; _linkClientDocs = []; _linkClientName = '';
  ['clients', 'suppliers'].forEach(mo => { const b = document.getElementById('linkSeg-' + mo); if (b) b.className = 'btn ' + (mo === mode ? 'primary' : 'ghost'); });
  const cw = document.getElementById('linkCreditsWrap'); if (cw) cw.style.display = mode === 'clients' ? 'flex' : 'none';
  const dbox = document.getElementById('linkDocs'); if (dbox) dbox.innerHTML = '';
  await ensureLinkPool();
  renderLinkContacts(_linkQuery);
};
window.toggleLinkCredits = (v) => { _linkIncludeCredits = !!v; if (_linkClientDocs.length) renderLinkDocs(); };
// חיפוש: מסנן את רשימת הלקוחות/ספקים לפי שם, ובמקביל מחפש מסמכים לפי מספר/תיאור
window.onLinkSearch = (q) => {
  _linkQuery = q || '';
  renderLinkContacts(_linkQuery);
  if (_linkClientDocs.length) renderLinkDocs();
  clearTimeout(_linkNumTimer);
  const term = _linkQuery.trim();
  if (term.length < 2) { _linkNumResults = []; const nb = document.getElementById('linkNumResults'); if (nb) nb.innerHTML = ''; return; }
  _linkNumTimer = setTimeout(() => linkNumberSearch(term), 350);
};
window.renderLinkContacts = (q) => {
  const box = document.getElementById('linkClients'); if (!box) return;
  const pool = _linkMode === 'suppliers' ? (_linkSuppliers || []) : (_linkClients || []);
  const icon = _linkMode === 'suppliers' ? '🏭' : '🏢';
  const list = pool.filter(c => !q || (c.name || '').includes(q)).slice(0, 40);
  box.innerHTML = list.length ? list.map(c => `<div class="chat-item" style="margin:0;padding:6px 10px" onclick="linkPickContact('${c.id}','${encodeURIComponent(c.name || '')}')">${icon} ${escapeHtml(c.name)}</div>`).join('') : '<span class="muted">אין תוצאות.</span>';
};
// חיפוש ישיר של מסמכים לפי מספר/תיאור — הכנסה (לקוחות) והוצאה (ספקים) יחד
async function linkNumberSearch(term) {
  const nb = document.getElementById('linkNumResults'); if (!nb) return;
  nb.innerHTML = '<div class="muted" style="font-size:12px;padding:4px 0">מחפש מסמכים לפי מספר/תיאור…</div>';
  const [inc, exp] = await Promise.all([
    api(`/api/documents/quick-search?q=${encodeURIComponent(term)}`).catch(() => ({ items: [] })),
    api(`/api/expenses/quick-search?q=${encodeURIComponent(term)}`).catch(() => ({ items: [] })),
  ]);
  const incItems = (inc.items || []).map(d => ({ id: d.id, number: d.number, type: d.type, clientName: d.clientName, amount: d.amount, date: d.date, url: d.url, kind: 'income' }));
  const expItems = (exp.items || []).map(d => ({ id: d.id, number: d.number, type: d.type, clientName: d.supplierName || '—', amount: d.amountIncVat ?? d.amount, date: d.date, url: d.url, kind: 'expense' }));
  _linkNumResults = [...incItems, ...expItems];
  const { ids } = linkedDocIds();
  const avail = _linkNumResults.filter(d => !ids.has(d.id));
  if (!avail.length) { nb.innerHTML = ''; return; }
  const rows = avail.map(d => {
    const j = encodeURIComponent(JSON.stringify(d));
    const kindTag = d.kind === 'expense' ? '<span class="tag" style="background:#fde7ef;color:var(--danger);font-size:10px">הוצאה</span>' : '<span class="tag" style="background:#e7f7ee;color:var(--accent2);font-size:10px">הכנסה</span>';
    const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">👁</button>` : '';
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${kindTag} ${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${fmtDate(d.date)} · ${money(d.amount)}</span>
      ${pv}<button class="btn primary" style="padding:2px 12px;font-size:11px" onclick="linkAddFromNum('${j}')">הוסף</button></div>`;
  }).join('');
  nb.innerHTML = `<div style="margin:6px 0;padding:8px 10px;border:1px solid var(--accent);border-radius:10px;background:var(--panel2)">
    <b style="font-size:12.5px">🔎 מסמכים לפי מספר/תיאור "${escapeHtml(term)}"</b>${rows}</div>`;
}
window.linkAddFromNum = (j) => { linkAdd(j); const { ids } = linkedDocIds(); const nb = document.getElementById('linkNumResults'); if (nb && nb.querySelector('button')) linkNumberSearch(_linkQuery.trim()); };
window.linkPickContact = async (id, name) => {
  const box = document.getElementById('linkDocs'); if (!box) return;
  box.innerHTML = '<div class="muted" style="font-size:13px">טוען מסמכים…</div>';
  _linkDocsKind = _linkMode === 'suppliers' ? 'expense' : 'income';
  const url = _linkMode === 'suppliers' ? `/api/suppliers/${id}/documents` : `/api/clients/${id}/documents`;
  const docs = await api(url).catch(() => []);
  _linkClientDocs = Array.isArray(docs) ? docs : [];
  _linkClientName = decodeURIComponent(name);
  renderLinkDocs();
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
// מציג את מסמכי הלקוח (הכנסה) או הספק (הוצאה) שלא שויכו עדיין — מסונן גם לפי מספר/תיאור בחיפוש
window.renderLinkDocs = () => {
  const box = document.getElementById('linkDocs'); if (!box) return;
  const { ids, recs } = linkedDocIds();
  const isExp = _linkDocsKind === 'expense';
  const q = (_linkQuery || '').trim();
  const qMatch = (d) => !q || String(d.number || '').includes(q) || (d.category || d.description || '').includes(q);
  const amountOf = (d) => isExp ? (d.amountIncVat ?? d.amount) : d.amountIncVat;
  let avail = _linkClientDocs.filter(d => !ids.has(d.id) && qMatch(d));
  if (!isExp) {
    // ברירת מחדל: חשבונית מס / מס-קבלה / קבלה (חיוביות בלבד). עם הסימון — גם זיכוי (330) וקבלות שליליות.
    const allowed = _linkIncludeCredits ? [305, 320, 400, 330] : [305, 320, 400];
    avail = avail.filter(d => allowed.includes(Number(d.type)) && !(Number(d.type) === 400 && recs.has(String(d.number))));
    if (!_linkIncludeCredits) avail = avail.filter(d => (Number(d.amountIncVat ?? d.amount) || 0) >= 0);
  }
  const rows = avail.map(d => {
    const cn = isExp ? (d.supplierName || _linkClientName) : d.clientName;
    const j = encodeURIComponent(JSON.stringify({ id: d.id, number: d.number, type: d.type, clientName: cn, amount: amountOf(d), date: d.date, url: d.url, kind: isExp ? 'expense' : 'income' }));
    const pv = d.url ? `<button class="btn ghost" style="padding:2px 9px;font-size:11px" onclick="previewDoc('${String(d.url).replace(/'/g, '%27')}')">תצוגה 👁</button>` : '';
    const dl = d.url ? `<a href="${d.url}" target="_blank" class="btn ghost" style="padding:2px 9px;font-size:11px;text-decoration:none;white-space:nowrap">להורדה ↓</a>` : '';
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${fmtDate(d.date)} · ${money(amountOf(d))}</span>
      ${pv}${dl}<button class="btn primary" style="padding:2px 12px;font-size:11px" onclick="linkAdd('${j}')">הוסף</button></div>`;
  }).join('');
  const title = isExp ? `מסמכי הוצאה של ${escapeHtml(_linkClientName)}` : `מסמכים פנויים של ${escapeHtml(_linkClientName)} (חשבונית מס / מס-קבלה / קבלה)`;
  box.innerHTML = `<b style="font-size:13px">${title}:</b>
    <div class="muted" style="font-size:11.5px;margin:2px 0 4px">${isExp ? 'בחר את מסמך ההוצאה התואם לתנועת החובה בבנק.' : 'מוצגים רק מסמכים שאינם משויכים עדיין. קבלה שתוסיף תצורף אוטומטית לחשבונית התואמת.'}</div>
    ${rows || '<div class="muted" style="font-size:13px;margin-top:4px">אין מסמכים פנויים.</div>'}`;
};
const _refreshLink = () => { const b = document.getElementById('linkSelBox'); if (b) b.innerHTML = linkSelHtml(); if (_linkClientDocs.length) renderLinkDocs(); };
window.linkAdd = (j) => {
  const d = JSON.parse(decodeURIComponent(j));
  if (_linkSel.find(x => x.id === d.id)) return;
  // מסמך הוצאה (ספק) — פשוט מתווסף, ללא לוגיקת צירוף קבלה (שרלוונטית להכנסה בלבד)
  if (d.kind === 'expense') { _linkSel.push(d); _refreshLink(); return; }
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

// ============ צור הכנסה מתנועת בנק (זכות) ============
// מפיק מס-קבלה/קבלה מחשבונית עסקה/מס פתוחה תואמת (סכום זהה או −5% ניכוי מס), או מסמך חדש מאפס.
let _incOpenDocs = null, _incCtx = null, _incQuery = '';
const incTargetFor = (srcType) => Number(srcType) === 300 ? 320 : 400; // עסקה→מס-קבלה, מס→קבלה
function incMatchKind(A, X) {
  if (!A || !X) return null;
  if (Math.abs(A - X) <= Math.max(2, A * 0.01)) return { kind: 'exact', withheld: 0 };
  if (Math.abs(X - A * 0.95) <= Math.max(2, A * 0.012)) return { kind: 'wh', withheld: +(A - X).toFixed(2) };
  return null;
}
function txIsoDate(txId) { const d = (_bankList.find(t => t.id === txId) || {}).date || ''; return d.split('/').reverse().join('-'); }
window.openCreateIncome = async (txId) => {
  const tx = (_bankList || []).find(t => t.id === txId); if (!tx) return;
  _incCtx = { txId, X: Number(tx.absAmount) || 0 }; _incQuery = '';
  let m = document.getElementById('incModal');
  if (!m) { m = document.createElement('div'); m.id = 'incModal'; m.className = 'modal'; document.body.appendChild(m); }
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,95vw);max-height:90vh;overflow:auto"><div class="empty">טוען חשבוניות פתוחות…</div></div>`;
  m.onclick = (e) => { if (e.target === m) m.classList.add('hidden'); };
  if (!_incOpenDocs) { const r = await api('/api/open-invoices').catch(() => ({ docs: [] })); _incOpenDocs = r.docs || []; }
  renderCreateIncome();
};
function renderCreateIncome() {
  const m = document.getElementById('incModal'); if (!m || !_incCtx) return;
  const { txId, X } = _incCtx;
  const docs = _incOpenDocs || [];
  const matches = [];
  for (const d of docs) { const A = Number(d.amountDue ?? d.amount) || 0; const mk = incMatchKind(A, X); if (mk) matches.push({ d, ...mk, A }); }
  matches.sort((a, b) => (a.kind === 'exact' ? 0 : 1) - (b.kind === 'exact' ? 0 : 1) || Math.abs(a.A - X) - Math.abs(b.A - X));
  const tgtName = (srcType) => DOC_TYPE_SHORT[incTargetFor(srcType)] || 'מסמך';
  const matchRow = (mm) => {
    const d = mm.d;
    const tag = mm.kind === 'wh'
      ? `<span class="tag" style="background:#fff3d6;color:var(--warn);font-size:10px">−5% ניכוי מס</span>`
      : `<span class="tag" style="background:#e7f7ee;color:var(--accent2);font-size:10px">סכום זהה</span>`;
    const extra = mm.kind === 'wh' ? ` · התקבל ${money(X)} + ניכוי ${money(mm.withheld)}` : '';
    return `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${tag} ${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${money(mm.A)}${extra}</span>
      <button class="btn success" style="padding:3px 12px;font-size:11.5px;white-space:nowrap" onclick="incProduce('${d.id}',${d.type},'${txId}',${X},${mm.kind === 'wh' ? 'true' : 'false'})">הפק ${tgtName(d.type)} ←</button></div>`;
  };
  const listDocs = docs.filter(d => !_incQuery || String(d.number || '').includes(_incQuery) || (d.clientName || '').includes(_incQuery)).slice(0, 60);
  const pickRow = (d) => `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${money(Number(d.amountDue ?? d.amount) || 0)}</span>
      <button class="btn ghost" style="padding:3px 10px;font-size:11.5px;white-space:nowrap" onclick="incProduce('${d.id}',${d.type},'${txId}',${X},false)">בחר → ${tgtName(d.type)}</button></div>`;
  const txDate = (_bankList.find(t => t.id === txId) || {}).date || '';
  m.innerHTML = `<div class="modal-card" style="width:min(720px,95vw);max-height:90vh;overflow:auto">
    <h3>➕ צור הכנסה — ${txDate} · ${money(X)}</h3>
    <p class="muted" style="font-size:12.5px;margin:2px 0 10px">בחר חשבונית עסקה/מס פתוחה כדי להפיק לה מסמך-המשך (מס-קבלה / קבלה), או צור מסמך חדש לגמרי. התקבול והתאריך ימולאו לפי התנועה.</p>
    ${matches.length ? `<div style="border:1px solid var(--accent);border-radius:10px;padding:8px 10px;background:var(--panel2);margin-bottom:10px">
      <b style="font-size:13px">🎯 התאמות מוצעות לסכום ${money(X)}</b>${matches.map(matchRow).join('')}</div>`
      : `<div class="muted" style="font-size:12.5px;margin-bottom:10px">לא נמצאה חשבונית פתוחה בסכום ${money(X)} (או ${money(+(X / 0.95).toFixed(2))} עם ניכוי 5%). בחר ידנית מהרשימה או צור מסמך חדש.</div>`}
    <details ${matches.length ? '' : 'open'}><summary style="cursor:pointer;font-weight:600;font-size:13px">📋 כל החשבוניות הפתוחות (${docs.length})</summary>
      <input placeholder="חפש לפי מספר / לקוח…" style="width:100%;margin:8px 0" oninput="incSearch(this.value)">
      <div id="incList">${listDocs.map(pickRow).join('') || '<span class="muted">אין.</span>'}</div>
    </details>
    <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
      <b style="font-size:13px">מסמך חדש לגמרי</b>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <button class="btn primary" style="padding:5px 12px;font-size:12.5px" onclick="incNewDoc('${txId}',320,${X})">חשבונית מס-קבלה חדשה</button>
        <button class="btn primary" style="padding:5px 12px;font-size:12.5px" onclick="incNewDoc('${txId}',400,${X})">קבלה חדשה</button>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:14px"><button class="btn ghost" onclick="document.getElementById('incModal').classList.add('hidden')">סגור</button></div>
  </div>`;
}
window.incSearch = (q) => { _incQuery = q || ''; const box = document.getElementById('incList'); if (!box || !_incCtx) return; const { txId } = _incCtx; const tgtName = (s) => DOC_TYPE_SHORT[incTargetFor(s)] || 'מסמך'; const docs = (_incOpenDocs || []).filter(d => !_incQuery || String(d.number || '').includes(_incQuery) || (d.clientName || '').includes(_incQuery)).slice(0, 60); box.innerHTML = docs.map(d => `<div style="display:flex;gap:8px;align-items:center;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--line)"><span style="flex:1">${DOC_TYPE_SHORT[d.type] || 'מסמך'} #${d.number} · ${escapeHtml(d.clientName || '')} · ${money(Number(d.amountDue ?? d.amount) || 0)}</span><button class="btn ghost" style="padding:3px 10px;font-size:11.5px;white-space:nowrap" onclick="incProduce('${d.id}',${d.type},'${txId}',${_incCtx.X},false)">בחר → ${tgtName(d.type)}</button></div>`).join('') || '<span class="muted">אין תוצאות.</span>'; };
// הפקת מסמך-המשך מחשבונית פתוחה, עם תאריך+תקבול לפי התנועה, וקישור לבנק
window.incProduce = (docId, srcType, txId, X, isWh) => {
  const im = document.getElementById('incModal'); if (im) im.classList.add('hidden');
  openDeriveEditor(docId, incTargetFor(srcType), true, { date: txIsoDate(txId) || todayIso(), bankReceived: Number(X) || 0, withholding: isWh === true || isWh === 'true', bankTxId: txId });
};
// מסמך הכנסה חדש מאפס (מס-קבלה/קבלה) — דרך עורך המסמך החדש, עם קישור לבנק
window.incNewDoc = async (txId, type, X) => {
  const im = document.getElementById('incModal'); if (im) im.classList.add('hidden');
  const m = document.getElementById('newQuoteModal') || (() => { const x = document.createElement('div'); x.id = 'newQuoteModal'; x.className = 'modal'; document.body.appendChild(x); return x; })();
  m.classList.remove('hidden');
  m.innerHTML = `<div class="modal-card" style="width:min(720px,96vw)"><div class="empty">טוען לקוחות…</div></div>`;
  if (!_evClients) { try { _evClients = await api('/api/clients'); } catch { _evClients = []; } }
  const exVat = +((Number(X) || 0) / (1 + VAT_RATE)).toFixed(2);
  _nq = { type: Number(type), bankTxId: txId, clientId: '', clientName: '', date: txIsoDate(txId) || todayIso(), subject: '', remarks: '', email: '', sendEmail: false, items: [{ description: 'הכנסה', quantity: 1, price: exVat }] };
  renderNewQuote();
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
    const balMsg = r.accountBalance ? ` · יתרת עו"ש עודכנה ל-${money(r.accountBalance.balance)}${r.accountBalance.date ? ' (' + r.accountBalance.date + ')' : ''}` : '';
    const debitMsg = r.debitMatched ? ` · חובה: ${r.debitMatched} הותאמו לחשבוניות ספקים` : '';
    if (status) status.innerHTML = `<span style="color:var(--accent2)">✓ נוספו ${r.added} תנועות · זכות: ${r.autoMatched} הותאמו אוטומטית${debitMsg}.${balMsg}</span>`;
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
