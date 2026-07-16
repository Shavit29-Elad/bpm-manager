// server.js
// שרת המערכת: מגיש את הממשק (public/) וחושף REST API.
// ללא תלויות חיצוניות — רץ עם `node server.js` בלבד (Node 18+). הגשר לווטסאפ אופציונלי.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { load, save, id, upsertEvent, companyEvents } from './store.js';
import { parseEventMessage } from './whatsappParser.js';
import { matchEvents, fetchCalendarEvents, verify as calendarVerify, hasCalendar } from './googleCalendar.js';
import { groupForInvoicing, invoiceItemsFromGroup, contractorPayables } from './invoicing.js';
import { employeePayForMonth } from './payroll.js';
import greenInvoice from './greenInvoice.js';
import { startWhatsappBridge, getBridgeStatus } from './whatsappBridge.js';
import { saveSettings, statusMasked, loadEnvIntoProcess } from './settings.js';
import { DEFS as CONN_DEFS, getRecords, setRecord, clearRecord } from './connections.js';
import { listTeam, findMember, TEAM } from './team.js';
import { chatWithMember, chatGroupReply, chatConfigured, learnFromExchange } from './chat.js';

loadEnvIntoProcess(); // טוען מפתחות מ-.env אם קיים

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = __dirname; // בגרסה השטוחה קובצי הממשק יושבים באותה תיקייה
// רק קבצים אלה מוגשים לדפדפן — כדי לא לחשוף קוד מקור או את קובץ הסודות .env
const STATIC_ALLOW = new Set(['index.html', 'styles.css', 'app.js']);
const PORT = process.env.PORT || 3000;

// ---- קליטת אירוע מטקסט (ווטסאפ / הדבקה ידנית) ----
function ingestText(text, companyId) {
  const db = load();
  const parsed = parseEventMessage(text);
  const event = {
    id: id('ev'),
    companyId: companyId || (db.companies.find(c => c.active) || db.companies[0])?.id,
    ...parsed,
    client: parsed.artist,
    invoiceStatus: 'pending',
    createdAt: new Date().toISOString(),
    employeeDetails: parsed.employees.map(name => ({ name, rate: null, bonus: null })),
    contractorDetails: parsed.contractors.map(name => ({ name, amount: null })),
  };
  upsertEvent(db, event);
  save(db);
  return event;
}

// ---- ראוטר מינימלי ----
const routes = [];
const add = (method, pattern, handler) => routes.push({ method, pattern, handler });
const json = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

// GET /api/companies
add('GET', /^\/api\/companies$/, (req, res) => json(res, load().companies));

// GET /api/events?companyId=
add('GET', /^\/api\/events$/, (req, res, _p, q) => {
  const db = load();
  const events = q.companyId ? companyEvents(db, q.companyId) : db.events;
  json(res, events.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});

// POST /api/events/ingest
add('POST', /^\/api\/events\/ingest$/, (req, res, _p, _q, body) => {
  if (!body?.text) return json(res, { error: 'חסר טקסט' }, 400);
  json(res, ingestText(body.text, body.companyId));
});

// PUT /api/events/:id
add('PUT', /^\/api\/events\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  Object.assign(ev, body); save(db); json(res, ev);
});

// GET /api/calendar/match?companyId=
add('GET', /^\/api\/calendar\/match$/, async (req, res, _p, q) => {
  const db = load();
  const waEvents = q.companyId ? companyEvents(db, q.companyId) : db.events;
  try {
    const dates = waEvents.map(e => e.date).filter(Boolean).sort();
    const timeMin = dates[0] ? `${dates[0]}T00:00:00Z` : undefined;
    const timeMax = dates.length ? `${dates[dates.length - 1]}T23:59:59Z` : undefined;
    const cal = await fetchCalendarEvents({ timeMin, timeMax });
    const r = matchEvents(waEvents, cal);
    // שולחים רק ספירה של "חסר בווטסאפ" (יכול להיות אלפי אירועים) — לא את כל המערך
    json(res, {
      matched: r.matched,
      missingInCalendar: r.missingInCalendar,
      missingInWhatsappCount: r.missingInWhatsapp.length,
    });
  } catch (e) {
    json(res, { matched: waEvents.map(w => ({ whatsapp: w, calendar: null, score: 0 })),
      missingInCalendar: waEvents, missingInWhatsappCount: 0, calendarError: e.message });
  }
});

// GET /api/calendar/events?companyId=&from=YYYY-MM-DD&to=YYYY-MM-DD  (טווח שבועי)
//     או ?month=YYYY-MM  (תאימות לאחור)
add('GET', /^\/api\/calendar\/events$/, async (req, res, _p, q) => {
  const db = load();
  // מסנן טווח: from<=date<=to. אם ניתן month — כל החודש.
  const inRange = (d) => {
    if (!d) return false;
    if (q.from && q.to) return d >= q.from && d <= q.to;
    return d.startsWith(q.month || new Date().toISOString().slice(0, 7));
  };
  const wa = (q.companyId ? companyEvents(db, q.companyId) : db.events)
    .filter(e => inRange(e.date))
    .map(e => ({ date: e.date, title: e.artist || 'אירוע', location: e.location || '', source: 'whatsapp' }));
  let cal = [];
  let calendarError = null;
  try {
    if (hasCalendar()) {
      cal = (await fetchCalendarEvents())
        .filter(e => inRange(e.date))
        .map(e => ({ date: e.date, title: e.title, location: e.location, source: 'calendar' }));
    } else { calendarError = 'יומן גוגל לא מחובר'; }
  } catch (e) { calendarError = e.message; }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ from: q.from, to: q.to, whatsapp: wa, calendar: cal, calendarError }));
});

// GET /api/invoicing/pending?companyId=
add('GET', /^\/api\/invoicing\/pending$/, (req, res, _p, q) =>
  json(res, groupForInvoicing(companyEvents(load(), q.companyId))));

// POST /api/invoicing/create
add('POST', /^\/api\/invoicing\/create$/, async (req, res, _p, _q, body) => {
  const db = load();
  const group = groupForInvoicing(companyEvents(db, body.companyId))
    .find(g => g.client === body.client && g.month === body.month);
  if (!group) return json(res, { error: 'לא נמצאה קבוצה לחיוב' }, 404);
  if (!greenInvoice.haveCredentials()) {
    return json(res, { error: 'חסרים מפתחות חשבונית ירוקה - הוסף אותם ב-.env כדי להפיק בפועל',
      preview: { client: group.client, items: invoiceItemsFromGroup(group), total: group.total } }, 400);
  }
  try {
    const doc = await greenInvoice.createInvoice({
      client: { name: group.client }, items: invoiceItemsFromGroup(group),
      remarks: `אירועים לחודש ${group.month}` });
    group.events.forEach(ev => { const e = db.events.find(x => x.id === ev.id); if (e) e.invoiceStatus = 'invoiced'; });
    save(db); json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/contractors/payables?companyId=
add('GET', /^\/api\/contractors\/payables$/, (req, res, _p, q) =>
  json(res, contractorPayables(companyEvents(load(), q.companyId))));

// GET /api/payroll?companyId=&month=
add('GET', /^\/api\/payroll$/, (req, res, _p, q) =>
  json(res, employeePayForMonth(companyEvents(load(), q.companyId), q.month)));

// GET /api/whatsapp/status
add('GET', /^\/api\/whatsapp\/status$/, (req, res) => json(res, getBridgeStatus()));

// ---- מרכז חיבורים ----
async function verifyConnection(key) {
  if (key === 'greenInvoice') return greenInvoice.verify();
  if (key === 'googleCalendar') return calendarVerify();
  if (key === 'whatsapp') {
    const st = getBridgeStatus().status;
    return { ok: st === 'connected', error: st === 'connected' ? null : `סטטוס: ${st}` };
  }
  return { ok: false, error: 'לא נתמך' };
}

// בונה תצוגת חיבורים משולבת: הגדרה + סטטוס סודות מוסווה + רשומת מטא-דאטה
function buildConnectionsView() {
  const masked = statusMasked();
  const records = getRecords();
  const bridge = getBridgeStatus();
  return Object.entries(CONN_DEFS).map(([key, def]) => {
    const rec = records[key] || {};
    let status = rec.status || 'disconnected';
    if (key === 'whatsapp') status = bridge.status === 'connected' ? 'connected' : (rec.status || bridge.status || 'disconnected');
    if (def.soon) status = 'soon';
    return {
      key, name: def.name, icon: def.icon, help: def.help, soon: Boolean(def.soon),
      toggle: def.toggle || null,
      toggleOn: def.toggle ? masked[def.toggle]?.set : undefined,
      fields: (def.fields || []).map(f => ({ ...f, set: masked[f.env]?.set, hint: masked[f.env]?.hint })),
      status,
      connectedAt: rec.connectedAt || null,
      lastCheckedAt: rec.lastCheckedAt || null,
      message: rec.message || null,
      whatsappQr: key === 'whatsapp' ? bridge.hasQr : undefined,
    };
  });
}

// GET /api/connections
add('GET', /^\/api\/connections$/, (req, res) => json(res, buildConnectionsView()));

// POST /api/connections/connect  { key, values:{ENV:VAL,...} }
add('POST', /^\/api\/connections\/connect$/, async (req, res, _p, _q, body) => {
  const { key, values = {} } = body || {};
  const def = CONN_DEFS[key];
  if (!def) return json(res, { error: 'חיבור לא מוכר' }, 404);
  if (def.soon) return json(res, { error: 'החיבור עדיין בפיתוח' }, 400);

  // שמירת הערכים הרלוונטיים בלבד ל-.env
  const allowed = def.toggle ? [def.toggle] : (def.fields || []).map(f => f.env);
  const updates = {};
  for (const k of allowed) if (values[k] !== undefined) updates[k] = values[k];
  saveSettings(updates);
  if (key === 'greenInvoice') greenInvoice.resetToken();

  const now = new Date().toISOString();
  const r = await verifyConnection(key);
  setRecord(key, r.ok
    ? { status: 'connected', lastCheckedAt: now, message: null }
    : { status: 'error', lastCheckedAt: now, message: r.error });
  json(res, { ok: r.ok, connections: buildConnectionsView() });
});

// POST /api/connections/test  { key }
add('POST', /^\/api\/connections\/test$/, async (req, res, _p, _q, body) => {
  const key = body?.key;
  if (!CONN_DEFS[key]) return json(res, { error: 'חיבור לא מוכר' }, 404);
  const now = new Date().toISOString();
  const r = await verifyConnection(key);
  setRecord(key, r.ok ? { status: 'connected', lastCheckedAt: now, message: null }
    : { status: 'error', lastCheckedAt: now, message: r.error });
  json(res, { ok: r.ok, connections: buildConnectionsView() });
});

// POST /api/connections/disconnect  { key }
add('POST', /^\/api\/connections\/disconnect$/, (req, res, _p, _q, body) => {
  const key = body?.key;
  const def = CONN_DEFS[key];
  if (!def) return json(res, { error: 'חיבור לא מוכר' }, 404);
  const clear = def.toggle ? { [def.toggle]: '' } : {};
  (def.fields || []).forEach(f => { clear[f.env] = ''; });
  saveSettings(clear);
  clearRecord(key);
  json(res, { ok: true, connections: buildConnectionsView() });
});

// ---- צוות (עובדים וירטואליים) + צ'אט ----
// GET /api/team  -> רשימת חברי הצוות
add('GET', /^\/api\/team$/, (req, res) => json(res, { members: listTeam(), configured: chatConfigured() }));

// GET /api/team/:id/messages  (id = 'group' או מזהה חבר)
add('GET', /^\/api\/team\/([^/]+)\/messages$/, (req, res, params) => {
  const db = load();
  json(res, db.chats?.[params[0]] || []);
});

// POST /api/team/:id/message  { text }
add('POST', /^\/api\/team\/([^/]+)\/message$/, async (req, res, params, _q, body) => {
  const id = params[0];
  const text = (body?.text || '').trim();
  if (!text) return json(res, { error: 'חסר טקסט' }, 400);
  if (!chatConfigured()) return json(res, { error: 'הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY ב-Render' }, 400);

  const db = load();
  db.chats = db.chats || {};
  db.memory = db.memory || {};
  const now = new Date().toISOString();

  if (id === 'group') {
    const history = db.chats.group = db.chats.group || [];
    history.push({ role: 'user', name: 'אתה', content: text, at: now });
    try {
      // כל חבר צוות עונה בתורו על סמך התמלול המתעדכן, עם הזיכרון האישי שלו
      for (const member of TEAM) {
        const transcript = history.map(m => `${m.name || (m.role === 'user' ? 'אתה' : 'צוות')}: ${m.content}`).join('\n');
        const reply = await chatGroupReply(member, transcript, db.memory[member.id] || '');
        history.push({ role: 'assistant', memberId: member.id, name: member.name, emoji: member.emoji, content: reply, at: new Date().toISOString() });
      }
      save(db);
      json(res, { ok: true, messages: history });
    } catch (e) { save(db); json(res, { error: e.message, messages: history }, 500); }
    return;
  }

  const member = findMember(id);
  if (!member) return json(res, { error: 'עובד לא נמצא' }, 404);
  const history = db.chats[id] = db.chats[id] || [];
  history.push({ role: 'user', content: text, at: now });
  try {
    const reply = await chatWithMember(member, history, db.memory[id] || '');
    history.push({ role: 'assistant', content: reply, at: new Date().toISOString() });
    save(db);
    json(res, { ok: true, messages: history });
    // למידה מתמשכת (ברקע, לא חוסם את התשובה): מזקק עובדות לזיכרון
    learnFromExchange(member, `משתמש: ${text}\n${member.name}: ${reply}`).then(notes => {
      if (!notes) return;
      const db2 = load(); db2.memory = db2.memory || {};
      const prev = db2.memory[id] || '';
      db2.memory[id] = (prev ? prev + '\n' : '') + notes.split('\n').map(l => l.replace(/^[-•\s]+/, '- ').trim()).join('\n');
      // תקרת גודל לזיכרון (שומר את הסוף — העדכני ביותר)
      if (db2.memory[id].length > 4000) db2.memory[id] = db2.memory[id].slice(-4000);
      save(db2);
    }).catch(() => {});
  } catch (e) { save(db); json(res, { error: e.message, messages: history }, 500); }
});

// GET /api/health
add('GET', /^\/api\/health$/, (req, res) => json(res, {
  ok: true,
  greenInvoiceConnected: greenInvoice.haveCredentials(),
  calendarConnected: hasCalendar(),
  chatConnected: chatConfigured(),
  whatsapp: getBridgeStatus().status,
}));

// ---- הגשת קבצים סטטיים ----
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const name = path.basename(path.normalize(p));
  if (!STATIC_ALLOW.has(name)) { res.writeHead(404); return res.end('לא נמצא'); }
  const file = path.join(PUBLIC, name);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('לא נמצא'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// זריעה אוטומטית בעלייה ראשונה — רק החברות, בלי אירוע דוגמה (מתחילים דף נקי)
function seedIfEmpty() {
  const db = load();
  if (db.companies && db.companies.length) return;
  db.companies = [
    { id: 'co_bpm', name: 'בי פי אם הגברה ותאורה בע"מ', active: true, greenInvoiceId: null },
    { id: 'co_ofek', name: 'אופק ידעי הגברה ותאורה', active: false, greenInvoiceId: null },
  ];
  save(db);
  console.log('נזרעו החברות (בלי אירוע דוגמה)');
}

// זיהוי-מחדש אוטומטי של חיבורים בכל הפעלה: אם המפתחות קיימים (למשל כמשתני סביבה
// קבועים ב-Render) — מאמת אותם ומסמן ירוק, כך שאין צורך לחבר מחדש אחרי כל פרסום.
async function autoVerifyConnections() {
  const checks = [
    ['greenInvoice', greenInvoice.haveCredentials()],
    ['googleCalendar', hasCalendar()],
  ];
  for (const [key, hasEnv] of checks) {
    if (!hasEnv) continue;
    try {
      const r = key === 'greenInvoice' ? await greenInvoice.verify() : await calendarVerify();
      const now = new Date().toISOString();
      setRecord(key, r.ok ? { status: 'connected', lastCheckedAt: now, message: null }
        : { status: 'error', lastCheckedAt: now, message: r.error });
    } catch (e) { /* לא חוסם עליית שרת */ }
  }
}

// ---- שרת ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  if (url.pathname.startsWith('/api/')) {
    const route = routes.find(r => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) return json(res, { error: 'route not found' }, 404);
    const params = (url.pathname.match(route.pattern) || []).slice(1);
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      try { await route.handler(req, res, params, q, body); }
      catch (e) { json(res, { error: e.message }, 500); }
    });
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  seedIfEmpty();
  autoVerifyConnections();
  console.log(`מערכת BPM רצה על http://localhost:${PORT}`);
  startWhatsappBridge(async (text) => { ingestText(text); })
    .then(r => { if (r && !r.ok) console.log('ווטסאפ:', r.reason); });
});
