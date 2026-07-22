// server.js
// שרת המערכת: מגיש את הממשק (public/) וחושף REST API.
// ללא תלויות חיצוניות — רץ עם `node server.js` בלבד (Node 18+). הגשר לווטסאפ אופציונלי.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { init as initStore, load, save, id, upsertEvent, companyEvents, saveFile, getFile, deleteFile } from './store.js';
import { parseEventMessage, parseEventMessages } from './whatsappParser.js';
import { matchEvents, fetchCalendarEvents, verify as calendarVerify, hasCalendar } from './googleCalendar.js';
import { groupForInvoicing, invoiceItemsFromGroup, contractorPayables, eventsByClient, invoiceItemsFromEvents, subjectForEvents } from './invoicing.js';
import { employeePayForMonth } from './payroll.js';
import greenInvoice from './greenInvoice.js';
import { parseBank, extractAccountBalance } from './bankParser.js';
import { matchCredits, matchDebits, attachReceipts } from './bankMatch.js';
import { startWhatsappBridge, getBridgeStatus } from './whatsappBridge.js';
import { saveSettings, statusMasked, loadEnvIntoProcess } from './settings.js';
import { DEFS as CONN_DEFS, getRecords, setRecord, clearRecord } from './connections.js';
import { listTeam, findMember, TEAM } from './team.js';
import { buildAppMap } from './appMap.js';
import { chatWithMember, chatWithMemberVision, chatGroupReply, chatConfigured, learnFromExchange, summarizeAsRequest, extractEvents, interpretBonuses, extractInvoiceFields } from './chat.js';
import mailer from './mailer.js';
import { hashPassword, verifyPassword, createSession, getSessionUser, destroySession, setSessionCookie, clearSessionCookie, publicUser } from './auth.js';

loadEnvIntoProcess(); // טוען מפתחות מ-.env אם קיים

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = __dirname; // בגרסה השטוחה קובצי הממשק יושבים באותה תיקייה
// רק קבצים אלה מוגשים לדפדפן — כדי לא לחשוף קוד מקור או את קובץ הסודות .env
const STATIC_ALLOW = new Set(['index.html', 'styles.css', 'app.js']);
const PORT = process.env.PORT || 3000;

// ---- מיפוי זמר → לקוח ברירת-מחדל ----
// מנרמל שם לצורך השוואה: מסיר רווחים כפולים, גרשיים/מרכאות, ומאחיד סוגים.
function normName(s) {
  return String(s || '')
    .replace(/["'׳״`]/g, '')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase();
}
// מוצא את שם-הלקוח הממופה לזמר (אם קיים במיפוי)
function mappedClientName(db, artist) {
  const a = normName(artist);
  if (!a) return null;
  const map = db.artistClientMap || [];
  // התאמה: שם הזמר במיפוי מוכל בשם הזמר של האירוע (או להפך)
  const hit = map.find(m => {
    const key = normName(m.artist);
    return key && (a === key || a.includes(key) || key.includes(a));
  });
  return hit ? hit.clientName : null;
}
// ממפה שם-לקוח (מהמיפוי) ל-clientId בחשבונית ירוקה
async function resolveClientByName(name) {
  if (!name) return null;
  try {
    const clients = await greenInvoice.listClients();
    const target = normName(name);
    // התאמה מדויקת קודם, אח״כ הכלה דו-כיוונית
    let hit = clients.find(c => normName(c.name) === target);
    if (!hit) hit = clients.find(c => { const cn = normName(c.name); return cn && (cn.includes(target) || target.includes(cn)); });
    return hit ? { clientId: hit.id, clientName: hit.name } : { clientId: null, clientName: name };
  } catch { return { clientId: null, clientName: name }; }
}

// ---- קליטת אירוע/ים מטקסט (ווטסאפ / הדבקה ידנית) — תומך בכמה אירועים בהודעה אחת ----
// קודם ניסיון עם AI (מטפל גם בפורמט חופשי), ואם אין AI/נכשל — פרסור regex מובנה.
async function ingestText(text, companyId) {
  const db = load();
  const cid = companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  let list = null;
  if (chatConfigured()) {
    try { const ai = await extractEvents(text, 2026); if (ai && ai.length) list = ai; } catch { /* נופל ל-regex */ }
  }
  if (!list || !list.length) list = parseEventMessages(text);
  // מיפוי זמר→לקוח: נפתור פעם אחת את שמות-הלקוח מול חשבונית ירוקה (מטמון קטן)
  const nameCache = new Map();
  const resolveCached = async (nm) => {
    if (!nameCache.has(nm)) nameCache.set(nm, await resolveClientByName(nm));
    return nameCache.get(nm);
  };
  const created = [];
  for (const parsed of list) {
    const ctrDetails = (parsed.contractorDetails && parsed.contractorDetails.length)
      ? parsed.contractorDetails
      : (parsed.contractors || []).map(name => ({ name, amount: null }));
    // מיפוי זמר → לקוח ברירת-מחדל
    let clientName = null, clientId = null;
    const mapped = mappedClientName(db, parsed.artist);
    if (mapped) {
      const r = await resolveCached(mapped);
      clientName = r.clientName; clientId = r.clientId;
    }
    const event = {
      id: id('ev'), companyId: cid,
      ...parsed,
      client: parsed.artist, clientName, clientId,
      priceSound: parsed.priceSound ?? null, priceExtras: parsed.priceExtras ?? null,
      invoiceStatus: 'pending',
      createdAt: new Date().toISOString(),
      employeeDetails: (parsed.employeeDetails && parsed.employeeDetails.length)
        ? parsed.employeeDetails
        : (parsed.employees || []).map(name => ({ name, rate: null, bonus: null })),
      contractorDetails: ctrDetails,
    };
    upsertEvent(db, event);
    created.push(event);
  }
  save(db);
  return created;
}

// ---- ראוטר מינימלי ----
const routes = [];
const add = (method, pattern, handler) => routes.push({ method, pattern, handler });
const json = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

// GET /api/companies — משתמש צפייה רואה רק את העסקים שהורשה אליהם
add('GET', /^\/api\/companies$/, (req, res) => {
  const all = load().companies || [];
  const u = req.user;
  if (u && u.role !== 'admin' && Array.isArray(u.companies)) return json(res, all.filter(c => u.companies.includes(c.id)));
  json(res, all);
});

// GET /api/events?companyId=
add('GET', /^\/api\/events$/, (req, res, _p, q) => {
  const db = load();
  const events = q.companyId ? companyEvents(db, q.companyId) : db.events;
  json(res, events.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});

// POST /api/events/ingest
add('POST', /^\/api\/events\/ingest$/, async (req, res, _p, _q, body) => {
  if (!body?.text) return json(res, { error: 'חסר טקסט' }, 400);
  try { json(res, await ingestText(body.text, body.companyId)); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// ---- מיפוי זמר → לקוח ברירת-מחדל (צפייה/עריכה) ----
// GET /api/artist-map — כל המיפויים
add('GET', /^\/api\/artist-map$/, (req, res) => json(res, load().artistClientMap || []));
// POST /api/artist-map — הוספה/עדכון { artist, clientName }
add('POST', /^\/api\/artist-map$/, (req, res, _p, _q, body) => {
  const db = load();
  const artist = String(body?.artist || '').trim();
  const clientName = String(body?.clientName || '').trim();
  if (!artist || !clientName) return json(res, { error: 'חסר זמר או שם לקוח' }, 400);
  db.artistClientMap = db.artistClientMap || [];
  const i = db.artistClientMap.findIndex(m => normName(m.artist) === normName(artist));
  if (i >= 0) db.artistClientMap[i].clientName = clientName;
  else db.artistClientMap.push({ artist, clientName });
  save(db); json(res, { ok: true, map: db.artistClientMap });
});
// DELETE /api/artist-map/:artist — הסרת מיפוי
add('DELETE', /^\/api\/artist-map\/(.+)$/, (req, res, params) => {
  const db = load();
  const target = normName(decodeURIComponent(params[0]));
  db.artistClientMap = (db.artistClientMap || []).filter(m => normName(m.artist) !== target);
  save(db); json(res, { ok: true, map: db.artistClientMap });
});

// POST /api/events  — יצירה ידנית או "אימוץ" אירוע מיומן גוגל לרשומה שניתן לערוך
add('POST', /^\/api\/events$/, async (req, res, _p, _q, body) => {
  const db = load();
  const b = body || {};
  const companyId = b.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  // מניעת כפילות: אם כבר אומץ אירוע יומן זה — מחזירים אותו
  if (b.gcalId) {
    const exist = db.events.find(e => e.gcalId === b.gcalId && e.companyId === companyId);
    if (exist) return json(res, exist);
  }
  // מיפוי זמר → לקוח ברירת-מחדל (רק אם לא נבחר לקוח ידנית)
  if (!b.clientId && !b.clientName) {
    const mapped = mappedClientName(db, b.artist || b.title);
    if (mapped) { const r = await resolveClientByName(mapped); b.clientId = r.clientId; b.clientName = r.clientName; }
  }
  const event = {
    id: id('ev'), companyId,
    date: b.date || null, dateRaw: b.date || null,
    artist: b.artist || b.title || null,
    location: b.location || null,
    sound: b.sound || null,
    price: b.price ?? null, priceSound: b.priceSound ?? null, priceLighting: b.priceLighting ?? null, priceBackline: b.priceBackline ?? null, priceExtras: b.priceExtras ?? null,
    ledPricePerMeter: b.ledPricePerMeter ?? null, ledMeters: b.ledMeters ?? null,
    employees: b.employees || [], employeeBonusRaw: b.employeeBonusRaw || null,
    contractors: b.contractors || [],
    employeeDetails: b.employeeDetails || [],
    contractorDetails: b.contractorDetails || [],
    clientId: b.clientId || null, clientName: b.clientName || null,
    gcalId: b.gcalId || null,
    source: b.source || 'manual',
    invoiceStatus: 'pending',
    createdAt: new Date().toISOString(),
  };
  upsertEvent(db, event); save(db); json(res, event);
});

// GET /api/events/:id — אירוע בודד
add('GET', /^\/api\/events\/([^/]+)$/, (req, res, params) => {
  const ev = load().events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  json(res, ev);
});

// PUT /api/events/:id
add('PUT', /^\/api\/events\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  Object.assign(ev, body); save(db); json(res, ev);
});

// DELETE /api/events/:id — מוחק רק מרשימת האירועים שלנו (לא מיומן גוגל)
add('DELETE', /^\/api\/events\/([^/]+)$/, (req, res, params) => {
  const db = load();
  const before = db.events.length;
  db.events = db.events.filter(e => e.id !== params[0]);
  if (db.events.length === before) return json(res, { error: 'אירוע לא נמצא' }, 404);
  save(db); json(res, { ok: true });
});

// מתאריך זה והלאה מתבצעות ההתאמות מול היומן (לפני כן לא רלוונטי)
const MATCH_START = process.env.MATCH_START_DATE || '2026-07-01';
// GET /api/calendar/match?companyId=
add('GET', /^\/api\/calendar\/match$/, async (req, res, _p, q) => {
  const db = load();
  const allWa = q.companyId ? companyEvents(db, q.companyId) : db.events;
  const waEvents = allWa.filter(e => (e.date || '') >= MATCH_START); // רק מיולי 2026 והלאה
  try {
    const dates = waEvents.map(e => e.date).filter(Boolean).sort();
    const timeMin = dates[0] ? `${dates[0]}T00:00:00Z` : undefined;
    const timeMax = dates.length ? `${dates[dates.length - 1]}T23:59:59Z` : undefined;
    const cal = (await fetchCalendarEvents({ timeMin, timeMax })).filter(e => (e.date || '') >= MATCH_START);
    const r = matchEvents(waEvents, cal);
    // אירועים שסומנו ידנית כ"הותאם" — מוציאים מרשימת חוסר-ההתאמה וסופרים כהותאמו
    for (const entry of r.matched) {
      if (!entry.calendar && entry.whatsapp && entry.whatsapp.manualMatched) {
        entry.calendar = { manual: true, summary: 'סומן ידנית כהותאם' };
        entry.manual = true;
      }
    }
    r.missingInCalendar = r.missingInCalendar.filter(w => !w.manualMatched);
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

// POST /api/calendar/mark-matched { eventId, matched } — סימון/ביטול ידני של "הותאם" לאי-התאמה
add('POST', /^\/api\/calendar\/mark-matched$/, (req, res, _p, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === body.eventId);
  if (!ev) return json(res, { error: 'האירוע לא נמצא' }, 404);
  ev.manualMatched = body.matched !== false;
  save(db);
  json(res, { ok: true, manualMatched: ev.manualMatched });
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
  const dbEvents = (q.companyId ? companyEvents(db, q.companyId) : db.events);
  const adoptedGcal = new Set(dbEvents.map(e => e.gcalId).filter(Boolean));
  const wa = dbEvents
    .filter(e => inRange(e.date))
    .map(e => ({ eventId: e.id, date: e.date, title: e.artist || 'אירוע', location: e.location || '',
      clientName: e.clientName || null, price: e.price ?? null, source: 'whatsapp' }));
  let cal = [];
  let calendarError = null;
  try {
    if (hasCalendar()) {
      cal = (await fetchCalendarEvents())
        .filter(e => inRange(e.date) && !adoptedGcal.has(e.id))   // מסתירים אירועי יומן שכבר אומצו
        .map(e => ({ gcalId: e.id, date: e.date, title: e.title, location: e.location, source: 'calendar', calendarIndex: e.calendarIndex ?? 0, calendarName: e.calendarName || `יומן ${(e.calendarIndex ?? 0) + 1}` }));
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

// GET /api/invoicing/clients?companyId= — כל האירועים מקובצים לפי לקוח (עם סימון מחויבים)
add('GET', /^\/api\/invoicing\/clients$/, (req, res, _p, q) =>
  json(res, eventsByClient(companyEvents(load(), q.companyId))));

// POST /api/invoicing/preview — { eventIds } → שורות ברירת מחדל + נושא + סכומים (בלי ליצור מסמך)
add('POST', /^\/api\/invoicing\/preview$/, async (req, res, _p, _q, body) => {
  const db = load();
  const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(Boolean);
  const items = invoiceItemsFromEvents(evs);
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  // מייל שמור של הלקוח — כדי שיופיע מראש בתיבה בהפקה (המשתמש מחליט אם לשלוח)
  let clientEmail = null;
  try {
    if (greenInvoice.haveCredentials()) {
      const ev0 = evs.find(e => e.clientId || e.clientName) || {};
      const clients = await greenInvoice.listClients();
      const c = clients.find(cl => (ev0.clientId && cl.id === ev0.clientId) || (ev0.clientName && cl.name === ev0.clientName));
      clientEmail = c?.email || null;
    }
  } catch { }
  json(res, { items, subtotal, vat: +(subtotal * 0.18).toFixed(2), total: +(subtotal * 1.18).toFixed(2), subject: subjectForEvents(evs), clientEmail });
});

// POST /api/invoicing/preview-pdf — תצוגה מקדימה מעוצבת של המסמך (לפני הפקה), מחזיר PDF ב-base64
add('POST', /^\/api\/invoicing\/preview-pdf$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const db = load();
    const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(Boolean);
    const items = (body.items && body.items.length) ? body.items : invoiceItemsFromEvents(evs);
    if (!items.length) return json(res, { error: 'אין שורות לתצוגה' }, 400);
    const type = Number(body.type) || greenInvoice.DOC_TYPES.INVOICE;
    const client = body.clientId ? { id: body.clientId } : { name: body.clientName || 'לקוח' };
    const opts = {
      type, client, items,
      description: body.description || subjectForEvents(evs),
      remarks: body.remarks || null,
      date: body.date || undefined,
    };
    const pv = await greenInvoice.previewDocument(opts);
    let pdfBase64 = pv.pdfBase64 || null;
    if (!pdfBase64 && pv.url) {
      const fr = await fetch(pv.url, { redirect: 'follow' }).catch(() => null);
      if (fr && fr.ok) pdfBase64 = Buffer.from(await fr.arrayBuffer()).toString('base64');
    }
    if (!pdfBase64) return json(res, { error: 'לא התקבלה תצוגה מקדימה', debug: pv.raw || null });
    json(res, { ok: true, pdfBase64 });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/preview-pdf — תצוגה מקדימה מעוצבת גנרית (הצעת מחיר / מסמך המשך וכו') — מחזיר PDF base64
add('POST', /^\/api\/documents\/preview-pdf$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }))
      .filter(it => it.description);
    if (!items.length) return json(res, { error: 'אין שורות לתצוגה' }, 400);
    const type = Number(body.type) || 305;
    const client = body.clientId ? { id: body.clientId } : { name: String(body.clientName || 'לקוח').trim() };
    const opts = { type, client, items, description: body.description || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    const pv = await greenInvoice.previewDocument(opts);
    let pdfBase64 = pv.pdfBase64 || null;
    if (!pdfBase64 && pv.url) { const fr = await fetch(pv.url, { redirect: 'follow' }).catch(() => null); if (fr && fr.ok) pdfBase64 = Buffer.from(await fr.arrayBuffer()).toString('base64'); }
    if (!pdfBase64) return json(res, { error: 'לא התקבלה תצוגה מקדימה', debug: pv.raw || null });
    json(res, { ok: true, pdfBase64 });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/invoicing/generate — יוצר מסמך בחשבונית ירוקה ומסמן את האירועים כמחויבים
add('POST', /^\/api\/invoicing\/generate$/, async (req, res, _p, _q, body) => {
  const db = load();
  const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(Boolean);
  const items = (body.items && body.items.length) ? body.items : invoiceItemsFromEvents(evs);
  const type = Number(body.type) || greenInvoice.DOC_TYPES.INVOICE;
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  if (!items.length) return json(res, { error: 'אין שורות לחיוב' }, 400);
  if (!greenInvoice.haveCredentials()) {
    return json(res, { error: 'חסרים מפתחות חשבונית ירוקה — הוסף אותם כדי להפיק בפועל',
      preview: { type, items, subtotal, subject: subjectForEvents(evs) } }, 400);
  }
  try {
    const client = body.clientId ? { id: body.clientId } : { name: body.clientName || 'לקוח' };
    const doc = await greenInvoice.createDocument({
      type, client, items,
      description: body.description || subjectForEvents(evs),
      remarks: body.remarks || null,
      date: body.date || undefined,   // תאריך המסמך שהמשתמש בחר (ברירת מחדל: היום)
      sendEmail: Boolean(body.sendEmail), email: body.email || null,
    });
    for (const ev of evs) {
      const e = db.events.find(x => x.id === ev.id);
      if (e) { e.invoiceStatus = 'invoiced'; e.invoiceId = doc.id; e.invoiceNumber = doc.number; e.invoiceType = type; }
    }
    save(db);
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/invoicing/open-for-client?clientName= — חשבוניות עסקה/מס פתוחות של לקוח (לשיוך אירועים)
add('GET', /^\/api\/invoicing\/open-for-client$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try {
    const name = (q.clientName || '').trim();
    const all = await greenInvoice.openDocuments();
    const docs = all.filter(d => [300, 305].includes(Number(d.type)) && (!name || (d.clientName || '').trim() === name));
    json(res, { docs });
  } catch (e) { json(res, { docs: [], error: e.message }, 500); }
});

// GET /api/invoicing/recent-for-client?clientId=&clientName= — מסמכים אחרונים של הלקוח (כל הסוגים לשיוך)
add('GET', /^\/api\/invoicing\/recent-for-client$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try {
    let clientId = q.clientId || null;
    const name = (q.clientName || '').trim();
    if (!clientId && name) {
      const clients = await greenInvoice.listClients();
      const c = clients.find(cl => (cl.name || '').trim() === name);
      clientId = c?.id || null;
    }
    if (!clientId) return json(res, { docs: [] });
    const all = await greenInvoice.clientDocuments(clientId);
    const types = [10, 300, 305, 320, 400]; // הצעת מחיר, עסקה, מס, מס-קבלה, קבלה
    const docs = all.filter(d => types.includes(Number(d.type)))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 30);
    json(res, { docs });
  } catch (e) { json(res, { docs: [], error: e.message }, 500); }
});

// POST /api/invoicing/link { eventIds, docs:[{id,number,type}] } — שיוך אירועים לעד 4 מסמכים קיימים וסגירת האירוע
add('POST', /^\/api\/invoicing\/link$/, (req, res, _p, _q, body) => {
  const db = load();
  const ids = body.eventIds || [];
  let docs = Array.isArray(body.docs) && body.docs.length
    ? body.docs
    : (body.docId ? [{ id: body.docId, number: body.docNumber || null, type: Number(body.docType) || null }] : []);
  if (!ids.length || !docs.length) return json(res, { error: 'חסרים נתונים לשיוך' }, 400);
  docs = docs.slice(0, 4).map(d => ({ id: d.id, number: d.number || null, type: Number(d.type) || null }));
  let n = 0;
  for (const id of ids) {
    const e = db.events.find(x => x.id === id);
    if (!e) continue;
    // צירוף המסמכים החדשים לקיימים (בלי כפילויות) — מאפשר לשייך עוד מסמכים בהמשך
    const merged = Array.isArray(e.linkedDocs) ? e.linkedDocs.slice() : [];
    for (const d of docs) if (!merged.some(x => String(x.id) === String(d.id))) merged.push(d);
    e.linkedDocs = merged.slice(0, 6);
    e.invoiceStatus = 'invoiced';
    // מסמך ראשי לתצוגה: חשבונית מס/מס-קבלה > חשבון עסקה > קבלה > הצעת מחיר
    let primary = e.linkedDocs[0];
    for (const t of [305, 320, 300, 400, 10]) { const d = e.linkedDocs.find(x => x.type === t); if (d) { primary = d; break; } }
    e.invoiceId = primary.id; e.invoiceNumber = primary.number; e.invoiceType = primary.type;
    n++;
  }
  save(db);
  json(res, { ok: true, linked: n, docs: docs.length });
});

// GET /api/open-quotes — הצעות מחיר פתוחות
add('GET', /^\/api\/open-quotes$/, async (req, res) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try { json(res, { docs: await greenInvoice.openQuotes() }); }
  catch (e) { json(res, { docs: [], error: e.message }, 500); }
});

// POST /api/quotes/create { clientId?, clientName?, items, date?, subject?, remarks?, sendEmail?, email? } — הצעת מחיר חדשה
add('POST', /^\/api\/quotes\/create$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }))
      .filter(it => it.description);
    if (!items.length) return json(res, { error: 'אין שורות בהצעת המחיר' }, 400);
    const client = body.clientId ? { id: body.clientId } : { name: String(body.clientName || 'לקוח').trim(), add: true };
    const opts = { type: 10, client, items, description: body.subject || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.sendEmail && body.email) { opts.sendEmail = true; opts.email = String(body.email).trim(); }
    const doc = await greenInvoice.createDocument(opts);
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/create { type, clientId?, clientName?, items, date?, subject?, remarks?, payment? }
// יצירת מסמך חדש מאפס (מס-קבלה / קבלה / חשבונית מס וכו') — כולל תקבולים
add('POST', /^\/api\/documents\/create$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const type = Number(body.type);
    if (!type) return json(res, { error: 'חסר סוג מסמך' }, 400);
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }))
      .filter(it => it.description);
    if (!items.length) return json(res, { error: 'אין שורות במסמך' }, 400);
    const client = body.clientId ? { id: body.clientId } : { name: String(body.clientName || 'לקוח').trim(), add: true };
    const opts = { type, client, items, description: body.subject || body.description || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    const doc = await greenInvoice.createDocument(opts);
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/quotes/close-bulk { ids } — סגירת כמה הצעות מחיר
add('POST', /^\/api\/quotes\/close-bulk$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const results = [];
  for (const id of ids) {
    try { await greenInvoice.closeDocument(id); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  json(res, { ok: true, closed: results.filter(r => r.ok).length, results });
});

// POST /api/expenses/upload-file — העלאת קובץ הוצאה (חשבונית ספק) לחשבונית ירוקה כטיוטת OCR
// body: { fileBase64, fileName, mime }
add('POST', /^\/api\/expenses\/upload-file$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.fileBase64) return json(res, { error: 'חסר קובץ' }, 400);
  try { json(res, await greenInvoice.uploadExpenseFile(body.fileBase64, body.fileName, body.mime)); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/expense-drafts — טיוטות הוצאה שהעלינו (OCR) שממתינות לאישור, ללא כאלה שכבר אושרו/נדחו אצלנו
add('GET', /^\/api\/expense-drafts$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { drafts: [], error: 'חשבונית ירוקה לא מחוברת' });
  if (q.fresh) greenInvoice.clearDataCache();
  try {
    const db = load();
    const approved = db.approvedDrafts || {};
    const dismissed = db.dismissedDrafts || [];
    const all = await greenInvoice.expenseDrafts();
    const drafts = all
      .filter(d => !approved[d.id] && !dismissed.includes(d.id))
      .map(d => ({ ...d, raw: undefined }));
    json(res, { drafts });
  } catch (e) { json(res, { drafts: [], error: e.message }, 500); }
});

// קישור חשבונית לאירועים ב"קבלנים לתשלום" — מסמן אותם כשולמו (יורדים מהרשימה) עם ייחוס לחשבונית
function applyLinkedEvents(db, linkedEvents, invoiceNumber, payableId) {
  if (!Array.isArray(linkedEvents) || !linkedEvents.length) return 0;
  let n = 0;
  for (const le of linkedEvents) {
    const ev = (db.events || []).find(e => String(e.id) === String(le.eventId));
    if (!ev || !Array.isArray(ev.contractorDetails) || !ev.contractorDetails[le.index]) continue;
    ev.contractorDetails[le.index].paid = true;
    ev.contractorDetails[le.index].paidInvoice = invoiceNumber || ev.contractorDetails[le.index].paidInvoice || null;
    ev.contractorDetails[le.index].paidPayableId = payableId || null;
    n++;
  }
  return n;
}

// POST /api/expense-drafts/:id/approve — אישור טיוטה → יצירת הוצאה אמיתית מנתוני ה-OCR (עם תיקונים)
// body: { supplierId, number, date, documentType, amount, vatIncluded, description, accountingClassificationId? }
add('POST', /^\/api\/expense-drafts\/([^/]+)\/approve$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const draftId = params[0];
  try {
    const draft = await greenInvoice.getExpenseDraft(draftId);
    if (!draft) return json(res, { error: 'הטיוטה לא נמצאה (ייתכן שכבר טופלה)' }, 404);
    const supplierId = body.supplierId || draft.supplierId;
    if (!supplierId) return json(res, { error: 'יש לבחור ספק עבור ההוצאה' }, 400);

    // חשבון עסקה (20) = רישום פנימי בלבד — לא נוצר בחשבונית ירוקה ולא נשלח לרו"ח
    const isBusiness = Number(body.documentType) === 20;
    const paidFlag = body.paid !== false; // ברירת מחדל שולם (הפרונט שולח במפורש)
    const linkedEvents = Array.isArray(body.linkedEvents) ? body.linkedEvents : [];

    // סיווג חשבונאי — נדרש רק למסמך מס אמיתי (לא לחשבון עסקה)
    let classId = body.accountingClassificationId || draft.accountingClassificationId || null;
    if (!isBusiness) {
      if (!classId) {
        try { const sup = await greenInvoice.getSupplier(supplierId); classId = sup?.accountingClassificationId || sup?.accountingClassification?.id || null; } catch { }
      }
      if (!classId) return json(res, { error: 'לספק אין סיווג הוצאה מוגדר בחשבונית ירוקה. הגדר לו "סיווג חשבונאי" בכרטיס הספק ונסה שוב.' }, 400);
    }

    const amount = Number(body.amount != null ? body.amount : draft.amount) || 0; // כולל מע"מ
    if (amount <= 0) return json(res, { error: 'סכום לא תקין' }, 400);
    // אם המשתמש הזין סכום ללא מע"מ מפורש — נשתמש בו; אחרת נחשב לפי 18%
    let net, vat;
    if (body.amountExcludeVat != null && Number(body.amountExcludeVat) > 0) {
      net = +Number(body.amountExcludeVat).toFixed(2);
      vat = +(amount - net).toFixed(2);
    } else {
      net = +(amount / 1.18).toFixed(2);
      vat = +(amount - net).toFixed(2);
    }
    const date = body.date || draft.date || new Date().toISOString().slice(0, 10);
    const number = String(body.number || draft.number || '').trim();
    if (!number) return json(res, { error: 'חסר מספר חשבונית של הספק' }, 400);

    // מספר הקצאה (חובה לחשבונית מס/מס-קבלה מעל 5,000 ₪) — נשמר בתיאור ההוצאה כדי לתעד אותו
    const alloc = String(body.allocationNumber || '').replace(/[^\d]/g, '').trim();
    const baseDesc = (body.description || draft.description || '').trim() || 'הוצאת ספק';
    const newPayable = (extra) => ({
      id: 'pay_' + Math.random().toString(36).slice(2, 10),
      supplierId, supplierName: body.supplierName || draft.supplierName || '',
      taxId: (body.taxId || '').trim() || null,
      documentType: Number(body.documentType || draft.documentType) || 305,
      number, date, amount, amountExcludeVat: net, vat,
      description: baseDesc, allocationNumber: alloc || null,
      paid: paidFlag, paidAt: paidFlag ? new Date().toISOString() : null,
      linkedEvents, createdAt: new Date().toISOString(),
      ...extra,
    });

    // ===== חשבון עסקה — רישום פנימי בלבד (לא בחשבונית ירוקה, לא לרו"ח) =====
    if (isBusiness) {
      const db = load();
      db.supplierPayables = db.supplierPayables || [];
      // שומרים את draftId (הקובץ נשאר בחשבונית ירוקה כטיוטה מוסתרת) כדי שתהיה צפייה/הורדה — לא נוצר כהוצאה
      const payable = newPayable({ isBusinessDoc: true, giExpenseId: null, draftId });
      db.supplierPayables.push(payable);
      const linked = applyLinkedEvents(db, linkedEvents, number, payable.id);
      db.approvedDrafts = db.approvedDrafts || {};
      db.approvedDrafts[draftId] = { businessPayableId: payable.id, at: new Date().toISOString() };
      save(db); // הטיוטה מוסתרת מרשימת הטיוטות (approvedDrafts) אך נשמרת כדי לשמור על הקובץ
      return json(res, { ok: true, businessDoc: true, payableId: payable.id, linkedCount: linked });
    }

    // ===== מסמך מס אמיתי — נוצר בחשבונית ירוקה =====
    const expBody = {
      supplier: { id: supplierId },
      documentType: Number(body.documentType || draft.documentType) || 305,
      number,
      date, reportingDate: date,
      currency: 'ILS', paymentType: paidFlag ? 4 : -1, // -1 = לא שולם
      amount, amountExcludeVat: net, vat,
      accountingClassification: { id: classId },
      description: alloc ? `${baseDesc} · מס' הקצאה ${alloc}` : baseDesc,
    };
    let created;
    try {
      created = await greenInvoice.createExpense(expBody);
    } catch (err) {
      // errorCode 1010 = הוצאה כפולה (כבר קיימת הוצאה עם אותו ספק/מספר) — לא שגיאה אמיתית.
      // מטפלים כאילו נקלטה: מוחקים את הטיוטה הכפולה ומסמנים כטופלה.
      if (/"errorCode"\s*:\s*1010/.test(err.message || '')) {
        try { await greenInvoice.deleteExpenseDraft(draftId); } catch { }
        const db = load();
        db.approvedDrafts = db.approvedDrafts || {};
        db.approvedDrafts[draftId] = { expenseId: null, at: new Date().toISOString(), duplicate: true };
        save(db);
        return json(res, { ok: true, duplicate: true, message: 'החשבונית כבר נקלטה במערכת — הקובץ הכפול נמחק.' });
      }
      throw err;
    }

    // הורדת קובץ הטיוטה פעם אחת (לפני מחיקתה) — לצירוף להוצאה ולשליחה לרו"ח
    let fileBuf = null, fileCt = 'application/pdf';
    try {
      if (draft.url) {
        const fr = await fetch(draft.url, { redirect: 'follow' });
        if (fr.ok) { fileBuf = Buffer.from(await fr.arrayBuffer()); fileCt = fr.headers.get('content-type') || 'application/pdf'; }
      }
    } catch { }
    const fileExt = /pdf/i.test(fileCt) ? 'pdf' : (/png/i.test(fileCt) ? 'png' : (/jpe?g/i.test(fileCt) ? 'jpg' : 'pdf'));
    const safeNum = String(number).replace(/[^\w.-]/g, '_');

    // צירוף קובץ החשבונית להוצאה שנוצרה — כדי שתהיה אפשרות תצוגה/הורדה (best-effort)
    if (created?.id && fileBuf) {
      try { await greenInvoice.uploadExpenseFile(fileBuf.toString('base64'), `expense-${safeNum}.${fileExt}`, fileCt, created.id); } catch { }
    }

    // העברת קובץ ההוצאה אוטומטית לכתובת רו"ח (best-effort)
    let forwarded = false, forwardError = null;
    try {
      const fwd = mailer.forwardExpenseTo();
      if (mailer.mailerConfigured() && fwd && fileBuf) {
        await mailer.sendMail({
          to: fwd,
          subject: `הוצאה #${number}${alloc ? ` · מס' הקצאה ${alloc}` : ''}`,
          text: `מצורפת חשבונית הוצאה שנקלטה במערכת.\nמספר מסמך: ${number}\nתאריך: ${date}\nסכום כולל מע"מ: ${amount}\nתיאור: ${baseDesc}`,
          attachments: [{ filename: `expense-${safeNum}.${fileExt}`, content: fileBuf, contentType: fileCt }],
        });
        forwarded = true;
      } else if (mailer.mailerConfigured() && fwd && !fileBuf) { forwardError = 'הורדת הקובץ נכשלה'; }
    } catch (e) { forwardError = e.message; }

    // ננסה למחוק את הטיוטה במורנינג; אם לא נתמך — נסמן אצלנו כמאושרת כדי שלא תופיע שוב
    let draftRemoved = false;
    try { await greenInvoice.deleteExpenseDraft(draftId); draftRemoved = true; } catch { }
    const db = load();
    db.approvedDrafts = db.approvedDrafts || {};
    db.approvedDrafts[draftId] = { expenseId: created?.id || null, at: new Date().toISOString() };
    // אם לא שולם — נוסיף ל"הוצאות ספקים לתשלום". בכל מקרה נקשר אירועים אם נבחרו.
    let payableId = null;
    if (!paidFlag) {
      db.supplierPayables = db.supplierPayables || [];
      const payable = newPayable({ isBusinessDoc: false, giExpenseId: created?.id || null });
      db.supplierPayables.push(payable);
      payableId = payable.id;
    }
    const linkedCount = applyLinkedEvents(db, linkedEvents, number, payableId);
    save(db);

    // שמירת הסיווג שנבחר כברירת מחדל לספק (אם התבקש) — כדי שקליטות הבאות יהיו אוטומטיות
    if (body.saveClassToSupplier && body.accountingClassificationId) {
      try { await greenInvoice.updateSupplier(supplierId, { accountingClassificationId: body.accountingClassificationId }); } catch { }
    }

    json(res, { ok: true, expense: created, draftRemoved, forwarded, forwardError, forwardTo: mailer.forwardExpenseTo(), payableId, linkedCount });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/contractors/open-events?name=&amount=&date=&desc=&companyId= — אירועים פתוחים של קבלן + הצעה חכמה
add('GET', /^\/api\/contractors\/open-events$/, (req, res, _p, q) => {
  const db = load();
  const name = (q.name || '').trim();
  if (!name) return json(res, { ok: true, events: [] });
  const amount = Number(q.amount) || 0;
  const invDate = (q.date || '').slice(0, 10);
  const desc = String(q.desc || '');
  const evs = q.companyId ? companyEvents(db, q.companyId) : db.events;
  const norm = (s) => String(s || '').trim();
  const items = [];
  for (const ev of (evs || [])) {
    const details = ev.contractorDetails || [];
    for (let i = 0; i < details.length; i++) {
      const c = details[i];
      const cn = norm(c.name);
      if (!cn || c.paid) continue;
      if (!(cn === name || cn.includes(name) || name.includes(cn))) continue;
      items.push({ eventId: ev.id, index: i, date: ev.date || ev.dateRaw || null, artist: ev.artist || '', location: ev.location || '', amount: Number(c.amount) || 0, suggested: false });
    }
  }
  // הצעה חכמה 1: תאריך/מקום/אמן שמופיעים בתיאור החשבונית (התאמה כמעט ודאית)
  const dateForms = (d) => { if (!d) return []; const [y, m, dd] = String(d).split('-'); if (!dd) return [d]; const yy = String(y).slice(2); return [`${dd}.${m}`, `${dd}/${m}`, `${dd}.${m}.${yy}`, `${dd}/${m}/${yy}`, d]; };
  let anyByText = false;
  for (const it of items) {
    const hitDate = dateForms(it.date).some(f => f && desc.includes(f));
    const hitLoc = it.location && desc.includes(it.location);
    const hitArt = it.artist && desc.includes(it.artist);
    if (hitDate || hitLoc || hitArt) { it.suggested = true; anyByText = true; }
  }
  // הצעה חכמה 2 (fallback): צירוף בחלון תאריכים שסכומו מסתדר עם החשבונית
  if (!anyByText && amount > 0) {
    const win = items.filter(it => {
      if (!it.date || !invDate) return true;
      const diff = (new Date(invDate) - new Date(it.date)) / 86400000;
      return diff >= -3 && diff <= 75;
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let acc = 0;
    for (const it of win) { if (acc >= amount - 1) break; it.suggested = true; acc += it.amount; }
    if (Math.abs(acc - amount) > Math.max(amount * 0.15, 50)) items.forEach(it => (it.suggested = false)); // לא בטוח — לא מציעים
  }
  items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  json(res, { ok: true, events: items });
});

// GET /api/supplier-payables?all= — הוצאות ספקים לתשלום (ברירת מחדל: רק שלא שולמו)
add('GET', /^\/api\/supplier-payables$/, (req, res, _p, q) => {
  const db = load();
  const list = db.supplierPayables || [];
  const out = (q.all ? list : list.filter(p => !p.paid)).slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(p => ({ ...p, hasFile: !!(p.giExpenseId || p.draftId) }));
  json(res, { ok: true, payables: out });
});

// GET /api/supplier-payables/:id/file — צפייה/הורדה של קובץ החשבונית (מההוצאה בחשבונית ירוקה או מהטיוטה)
add('GET', /^\/api\/supplier-payables\/([^/]+)\/file$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const db = load();
    const p = (db.supplierPayables || []).find(x => x.id === params[0]);
    if (!p) return json(res, { error: 'לא נמצא' }, 404);
    let fileUrl = null;
    if (p.giExpenseId) { try { const e = await greenInvoice.getExpense(p.giExpenseId); fileUrl = (e?.url && (e.url.he || e.url.origin || e.url.pdf)) || (typeof e?.url === 'string' ? e.url : null); } catch { } }
    if (!fileUrl && p.draftId) { try { const d = await greenInvoice.getExpenseDraft(p.draftId); fileUrl = d?.url || null; } catch { } }
    if (!fileUrl) return json(res, { error: 'אין קובץ למסמך זה' }, 404);
    const r = await fetch(fileUrl, { redirect: 'follow' });
    if (!r.ok) return json(res, { error: `שגיאה בטעינת הקובץ: ${r.status}` }, 502);
    let ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!ct || /octet-stream/i.test(ct)) {
      if (buf.slice(0, 4).toString('latin1') === '%PDF') ct = 'application/pdf';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';
      else if (buf[0] === 0xFF && buf[1] === 0xD8) ct = 'image/jpeg';
      else ct = 'application/pdf';
    }
    if (/image\/jpg/i.test(ct)) ct = 'image/jpeg';
    res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300' });
    res.end(buf);
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/supplier-payables/:id/paid { paid } — סימון הוצאת ספק כשולמה
add('POST', /^\/api\/supplier-payables\/([^/]+)\/paid$/, (req, res, params, _q, body) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  p.paid = body.paid !== false;
  p.paidAt = p.paid ? new Date().toISOString() : null;
  save(db); json(res, { ok: true, payable: p });
});

// POST /api/supplier-payables/:id/update — עריכת פרטי הוצאת ספק (השלמת מידע חסר, למשל מס' הקצאה)
add('POST', /^\/api\/supplier-payables\/([^/]+)\/update$/, (req, res, params, _q, body) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  const b = body || {};
  if (b.number != null) p.number = String(b.number).trim();
  if (b.date) p.date = String(b.date).slice(0, 10);
  if (b.description != null) {
    p.description = String(b.description).trim();
    // סנכרון לתיאור-הוצאה מותאם כדי שישתקף בהתאמות הבנק (אם ההוצאה קיימת בחשבונית ירוקה)
    if (p.giExpenseId) {
      db.expenseNotes = db.expenseNotes || {};
      if (p.description) db.expenseNotes[p.giExpenseId] = p.description; else delete db.expenseNotes[p.giExpenseId];
      for (const t of (db.bankTx || [])) for (const inv of (t.matchedInvoices || [])) if (inv.id === p.giExpenseId) inv.description = p.description;
    }
  }
  if (b.documentType != null) p.documentType = Number(b.documentType) || p.documentType;
  if (b.allocationNumber !== undefined) p.allocationNumber = String(b.allocationNumber || '').replace(/[^\d]/g, '').trim() || null;
  if (b.amount != null && b.amount !== '') {
    p.amount = Number(b.amount) || 0;
    p.amountExcludeVat = (b.amountExcludeVat != null && b.amountExcludeVat !== '') ? Number(b.amountExcludeVat) : +(p.amount / (1 + 0.18)).toFixed(2);
    p.vat = +(p.amount - p.amountExcludeVat).toFixed(2);
  } else if (b.amountExcludeVat != null && b.amountExcludeVat !== '') {
    p.amountExcludeVat = Number(b.amountExcludeVat) || 0;
  }
  p.updatedAt = new Date().toISOString();
  save(db); json(res, { ok: true, payable: p });
});

// POST /api/supplier-payables/:id/delete — הסרת רשומת הוצאת ספק פנימית
add('POST', /^\/api\/supplier-payables\/([^/]+)\/delete$/, (req, res, params) => {
  const db = load();
  const before = (db.supplierPayables || []).length;
  db.supplierPayables = (db.supplierPayables || []).filter(x => x.id !== params[0]);
  save(db); json(res, { ok: true, removed: before - (db.supplierPayables || []).length });
});

// GET /api/mail/status — האם שליחת מייל מוגדרת ולאן מועברות הוצאות
add('GET', /^\/api\/mail\/status$/, (req, res) => {
  json(res, { configured: mailer.mailerConfigured(), forwardTo: mailer.forwardExpenseTo() });
});

// GET /api/mail/test — אימות SMTP ושליחת מייל בדיקה. דורש ?key=<MAIL_TEST_KEY> כדי למנוע הפעלה לא רצויה.
// אפשר ?to=כתובת כדי לשלוח ליעד אחר (ברירת מחדל: הכתובת השולחת עצמה).
add('GET', /^\/api\/mail\/test$/, async (req, res, params, q) => {
  const expected = process.env.MAIL_TEST_KEY || 'bpm-mail-check';
  if (!q || q.key !== expected) return json(res, { ok: false, error: 'נדרש מפתח (?key=...)' }, 403);
  if (!mailer.mailerConfigured()) return json(res, { ok: false, error: 'שליחת מייל לא מוגדרת (חסר SMTP_USER/SMTP_PASS)' }, 400);
  const v = await mailer.verifyMailer();
  if (!v.ok) return json(res, { ok: false, stage: 'verify', error: v.error }, 502);
  const to = (q && q.to) ? String(q.to) : (process.env.SMTP_FROM || process.env.SMTP_USER);
  try {
    const info = await mailer.sendMail({
      to,
      subject: 'בדיקת חיבור מייל — מערכת BPM',
      text: 'זהו מייל בדיקה אוטומטי שנשלח כדי לוודא שחיבור ה-SMTP של מערכת BPM עובד. אם קיבלת אותו — הכל תקין.',
    });
    json(res, { ok: true, verified: true, to, messageId: info?.messageId || null });
  } catch (e) { json(res, { ok: false, stage: 'send', error: e.message }, 502); }
});

// GET /api/expense-drafts/:id/file — פרוקסי לקובץ הטיוטה (כדי שהתצוגה המקדימה תרוץ מאותו מקור, בלי חסימת iframe)
add('GET', /^\/api\/expense-drafts\/([^/]+)\/file$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const draft = await greenInvoice.getExpenseDraft(params[0]);
    if (!draft?.url) return json(res, { error: 'אין קובץ לטיוטה' }, 404);
    const r = await fetch(draft.url, { redirect: 'follow' });
    if (!r.ok) return json(res, { error: `שגיאה בטעינת הקובץ: ${r.status}` }, 502);
    let ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    // זיהוי סוג מהבייטים אם ה-content-type חסר/כללי (חשבונית ירוקה מחזירה לעיתים octet-stream)
    if (!ct || /octet-stream/i.test(ct)) {
      if (buf.slice(0, 4).toString('latin1') === '%PDF') ct = 'application/pdf';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';
      else if (buf[0] === 0xFF && buf[1] === 0xD8) ct = 'image/jpeg';
      else if (buf.slice(0, 3).toString('latin1') === 'GIF') ct = 'image/gif';
      else if (buf.slice(0, 4).toString('latin1') === 'RIFF') ct = 'image/webp';
      else ct = 'application/pdf';
    }
    if (/image\/jpg/i.test(ct)) ct = 'image/jpeg'; // נרמול
    res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300' });
    res.end(buf);
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/expense-drafts/:id/ai-extract — קורא את קובץ החשבונית עם AI ומחזיר שדות מוכנים לאישור
// התוצאה נשמרת במטמון (db.draftAi) כדי שקריאה חוזרת/פתיחת המסך תהיה מיידית. ?force=1 מריץ מחדש.
add('POST', /^\/api\/expense-drafts\/([^/]+)\/ai-extract$/, async (req, res, params, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!chatConfigured()) return json(res, { error: 'AI לא מוגדר. הוסף ANTHROPIC_API_KEY (או GEMINI_API_KEY) בהגדרות Render.' }, 400);
  const draftId = params[0];
  try {
    const db = load();
    db.draftAi = db.draftAi || {};
    if (!q?.force && db.draftAi[draftId]) return json(res, { ok: true, fields: db.draftAi[draftId], cached: true });
    const draft = await greenInvoice.getExpenseDraft(draftId);
    if (!draft?.url) return json(res, { error: 'אין קובץ לטיוטה' }, 404);
    const fr = await fetch(draft.url, { redirect: 'follow' });
    if (!fr.ok) return json(res, { error: `שגיאה בטעינת הקובץ: ${fr.status}` }, 502);
    const mime = fr.headers.get('content-type') || 'application/pdf';
    const b64 = Buffer.from(await fr.arrayBuffer()).toString('base64');
    const suppliers = await greenInvoice.listSuppliers().catch(() => []);
    const fields = await extractInvoiceFields(b64, mime, suppliers);
    const db2 = load(); db2.draftAi = db2.draftAi || {}; db2.draftAi[draftId] = fields; save(db2);
    json(res, { ok: true, fields });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/expense-drafts/:id/delete — מחיקת טיוטת ההוצאה (במורנינג + הסתרה אצלנו)
add('POST', /^\/api\/expense-drafts\/([^/]+)\/delete$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const draftId = params[0];
  let removed = false;
  try { await greenInvoice.deleteExpenseDraft(draftId); removed = true; } catch { }
  try {
    const db = load();
    db.dismissedDrafts = db.dismissedDrafts || [];
    if (!db.dismissedDrafts.includes(draftId)) db.dismissedDrafts.push(draftId);
    save(db);
  } catch { }
  json(res, { ok: true, removed });
});

// POST /api/expense-drafts/:id/dismiss — התעלמות מטיוטה (מסתירה אותה אצלנו, לא מוחקת במורנינג)
add('POST', /^\/api\/expense-drafts\/([^/]+)\/dismiss$/, async (req, res, params) => {
  const draftId = params[0];
  try {
    const db = load();
    db.dismissedDrafts = db.dismissedDrafts || [];
    if (!db.dismissedDrafts.includes(draftId)) db.dismissedDrafts.push(draftId);
    save(db);
    json(res, { ok: true });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/contractors/:id/expense — רישום הוצאה של קבלן ישירות בחשבונית ירוקה
// body: { number, date, documentType, amount, vatIncluded, description }
add('POST', /^\/api\/contractors\/([^/]+)\/expense$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const supplierId = params[0];
  try {
    // סיווג חשבונאי — לפי ברירת המחדל של הספק
    let classId = body.accountingClassificationId || null;
    if (!classId) {
      try { const sup = await greenInvoice.getSupplier(supplierId); classId = sup?.accountingClassificationId || sup?.accountingClassification?.id || null; } catch { }
    }
    if (!classId) return json(res, { error: 'לקבלן אין סיווג הוצאה מוגדר בחשבונית ירוקה. הגדר לו "סיווג חשבונאי" בכרטיס הספק ונסה שוב.' }, 400);

    const total = Number(body.amount) || 0;
    if (total <= 0) return json(res, { error: 'סכום לא תקין' }, 400);
    const net = body.vatIncluded === false ? total : +(total / 1.18).toFixed(2);
    const vat = body.vatIncluded === false ? +(total * 0.18).toFixed(2) : +(total - net).toFixed(2);
    const amount = body.vatIncluded === false ? +(total + vat).toFixed(2) : total;
    const date = body.date || new Date().toISOString().slice(0, 10);

    const expBody = {
      supplier: { id: supplierId },
      documentType: Number(body.documentType) || 305,
      number: String(body.number || '').trim() || undefined,
      date, reportingDate: date,
      currency: 'ILS', paymentType: 4,
      amount, amountExcludeVat: net, vat,
      accountingClassification: { id: classId },
      description: (body.description || '').trim() || 'הוצאת קבלן',
    };
    if (!expBody.number) return json(res, { error: 'חסר מספר חשבונית של הקבלן' }, 400);
    const created = await greenInvoice.createExpense(expBody);
    json(res, { ok: true, expense: created });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/quotes/:id/close — סגירת הצעת מחיר
add('POST', /^\/api\/quotes\/([^/]+)\/close$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, result: await greenInvoice.closeDocument(params[0]) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/quotes/:id/followup { type } — יצירת מסמך המשך מהצעת מחיר (אותן שורות, מקושר)
add('POST', /^\/api\/quotes\/([^/]+)\/followup$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const type = Number(body.type) || greenInvoice.DOC_TYPES.INVOICE;
    const items = (src.income || []).map(it => ({
      catalogNum: it.catalogNum || undefined, description: it.description,
      quantity: it.quantity ?? 1, price: it.price ?? 0,
    }));
    if (!items.length) return json(res, { error: 'אין שורות בהצעה' }, 400);
    const doc = await greenInvoice.createDocument({
      type, client: src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' },
      items, description: src.description || '', remarks: src.remarks || null,
      linkedDocumentIds: [params[0]],
    });
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/lines — שורות + פרטי מסמך מקור, לעריכה לפני הפקת מסמך המשך
add('GET', /^\/api\/documents\/([^/]+)\/lines$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const items = (src.income || []).map(it => ({
      catalogNum: it.catalogNum || undefined, description: it.description,
      quantity: it.quantity ?? 1, price: it.price ?? 0,
    }));
    let lastDocDate = null;
    try { lastDocDate = await greenInvoice.latestDocumentDate(); } catch { /* לא חוסם */ }
    json(res, {
      ok: true,
      items,
      client: { id: src.client?.id || null, name: src.client?.name || '' },
      description: src.description || '',
      remarks: src.remarks || '',
      srcType: src.type, srcNumber: src.number,
      lastDocDate,
    });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/quick-search?q= — חיפוש מסמכים לפי מספר/תיאור (לשורת החיפוש בלקוחות)
add('GET', /^\/api\/documents\/quick-search$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { items: [] });
  const term = (q.q || '').trim();
  if (term.length < 2) return json(res, { items: [] });
  try { json(res, { ok: true, items: await greenInvoice.quickSearchDocuments(term) }); }
  catch (e) { json(res, { items: [], error: e.message }); }
});

// GET /api/documents/last-date — תאריך המסמך האחרון (להגבלת בורר תאריך)
add('GET', /^\/api\/documents\/last-date$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { lastDocDate: null });
  try {
    const type = q.type ? Number(q.type) : null;
    json(res, { ok: true, lastDocDate: await greenInvoice.latestDocumentDate(type) });
  } catch (e) { json(res, { lastDocDate: null, error: e.message }); }
});

// POST /api/documents/:id/close — סימון מסמך כטופל (סגירה)
add('POST', /^\/api\/documents\/([^/]+)\/close$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, result: await greenInvoice.closeDocument(params[0]) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/:id/open — פתיחה מחדש של מסמך סגור
add('POST', /^\/api\/documents\/([^/]+)\/open$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, result: await greenInvoice.openDocument(params[0]) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/:id/credit { date? } — הפקת זיכוי
//   חשבונית מס (305) → חשבונית זיכוי אחת (330, linkType cancel)
//   חשבונית מס-קבלה (320) → זיכוי דו-שלבי: חשבונית זיכוי (330) + קבלה שלילית (400 עם תקבול שלילי)
add('POST', /^\/api\/documents\/([^/]+)\/credit$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const srcType = Number(src.type);
    if (![305, 320].includes(srcType)) return json(res, { error: 'זיכוי אפשרי רק מחשבונית מס או חשבונית מס-קבלה' }, 400);
    const client = src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' };
    const items = (src.income || []).map(it => ({
      catalogNum: it.catalogNum || undefined, description: it.description,
      quantity: Number(it.quantity) || 1, price: Number(it.price) || 0,
    })).filter(it => it.description && String(it.description).trim());
    if (!items.length) return json(res, { error: 'אין שורות במסמך המקור' }, 400);
    const date = body && body.date ? String(body.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const baseDesc = `זיכוי עבור ${srcType === 320 ? 'חשבונית מס-קבלה' : 'חשבונית מס'} #${src.number}`;

    // שלב 1 — חשבונית זיכוי (330), מקושרת כביטול המסמך המקורי
    const credit = await greenInvoice.createDocument({
      type: 330, client, items, date,
      description: src.description ? `${baseDesc} — ${src.description}` : baseDesc,
      linkedDocumentIds: [params[0]], linkType: 'cancel',
    });

    if (srcType === 305) return json(res, { ok: true, mode: 'single', credit });

    // שלב 2 (רק ל-320) — קבלה שלילית לביטול חלק התקבול
    const srcPay = Array.isArray(src.payment) ? src.payment : [];
    const negPayment = (srcPay.length ? srcPay : [{ type: 4, price: Number(src.amount) || 0 }]).map(p => {
      const row = { type: Number(p.type) || 4, price: -Math.abs(Number(p.price) || 0), date, currency: 'ILS' };
      if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
      if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
      return row;
    }).filter(p => Math.abs(p.price) > 0);
    const negativeReceipt = await greenInvoice.createDocument({
      type: 400, client, items: [], payment: negPayment, date,
      description: `ביטול קבלה — חשבונית מס-קבלה #${src.number}`,
    });
    json(res, { ok: true, mode: 'two-stage', credit, negativeReceipt });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/url — קישור לקובץ המסמך (PDF) בחשבונית ירוקה, לפתיחה/הורדה
add('GET', /^\/api\/documents\/([^/]+)\/url$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const raw = await greenInvoice.getDocument(params[0]);
    const url = (raw.url && (raw.url.he || raw.url.origin || raw.url.pdf)) || (typeof raw.url === 'string' ? raw.url : null);
    if (!url) return json(res, { error: 'לא נמצא קובץ למסמך זה' }, 404);
    json(res, { ok: true, url });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/:id/derive { type, linked, items?, date?, payment?, description?, remarks? }
// מסמך המשך (מקושר) או שכפול (חופשי). אם נשלחות שורות/תאריך/תקבולים ערוכים — משתמשים בהם.
add('POST', /^\/api\/documents\/([^/]+)\/derive$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const type = Number(body.type);
    if (!type) return json(res, { error: 'חסר סוג מסמך' }, 400);
    // שורות ערוכות מהלקוח (אם נשלחו), אחרת שורות המקור
    const edited = Array.isArray(body.items) && body.items.length ? body.items : null;
    const items = (edited || src.income || []).map(it => ({
      catalogNum: it.catalogNum || undefined, description: it.description,
      quantity: Number(it.quantity) || 1, price: Number(it.price) || 0,
    })).filter(it => it.description && it.description.trim());
    if (!items.length) return json(res, { error: 'אין שורות במסמך' }, 400);
    const opts = {
      type,
      client: src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' },
      items,
      description: body.description != null ? body.description : (src.description || ''),
      remarks: body.remarks != null ? body.remarks : (src.remarks || null),
    };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    // תקבולים ערוכים (למסמכי מס-קבלה/קבלה) — סוג + סכום + תאריך + פרטים
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum); // צ'ק
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);    // העברה בנקאית
        return row;
      }).filter(p => Math.abs(p.price) > 0); // מתעלמים משורות תקבול ריקות
    }
    if (body.linked) opts.linkedDocumentIds = [params[0]]; // מסמך המשך — קישור למקור
    const doc = await greenInvoice.createDocument(opts);
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/open-invoices — חשבון עסקה + חשבונית מס פתוחים מחשבונית ירוקה
add('GET', /^\/api\/open-invoices$/, async (req, res) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try { json(res, { docs: await greenInvoice.openDocuments() }); }
  catch (e) { json(res, { docs: [], error: e.message }, 500); }
});

// GET /api/contractors/payables?companyId=
add('GET', /^\/api\/contractors\/payables$/, (req, res, _p, q) =>
  json(res, contractorPayables(companyEvents(load(), q.companyId))));

// POST /api/contractors/toggle-paid — סימון תשלום לקבלן על אירוע מסוים
add('POST', /^\/api\/contractors\/toggle-paid$/, (req, res, _p, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === body.eventId);
  if (!ev || !ev.contractorDetails || !ev.contractorDetails[body.index]) return json(res, { error: 'לא נמצא' }, 404);
  ev.contractorDetails[body.index].paid = Boolean(body.paid);
  if (!body.paid) ev.contractorDetails[body.index].paidInvoice = null;
  save(db); json(res, { ok: true });
});

// POST /api/contractors/mark-paid-bulk — סימון תשלום למספר אירועים עם מספר חשבונית
add('POST', /^\/api\/contractors\/mark-paid-bulk$/, (req, res, _p, _q, body) => {
  const db = load();
  const items = Array.isArray(body.items) ? body.items : [];
  const paid = body.paid !== false;
  let n = 0;
  for (const it of items) {
    const ev = db.events.find(e => e.id === it.eventId);
    if (ev && ev.contractorDetails && ev.contractorDetails[it.index]) {
      const cd = ev.contractorDetails[it.index];
      cd.paid = paid;
      cd.paidInvoice = paid ? (body.invoiceNumber || null) : null;
      cd.paidExpenseId = paid ? (body.expenseId || null) : null;
      cd.paidExpenseUrl = paid ? (body.expenseUrl || null) : null;
      n++;
    }
  }
  save(db); json(res, { ok: true, updated: n });
});

// POST /api/contractors/dismiss-supplier { name } — סימון כל האירועים שנותרו (לא שולמו) של הספק כ"טופל"
add('POST', /^\/api\/contractors\/dismiss-supplier$/, (req, res, _p, _q, body) => {
  const db = load();
  const name = String(body?.name || '').trim();
  if (!name) return json(res, { error: 'חסר שם ספק' }, 400);
  const undo = body?.undo === true;
  let n = 0;
  for (const ev of db.events) {
    for (const c of (ev.contractorDetails || [])) {
      if ((c.name || '').trim() !== name) continue;
      if (undo) { if (c.handled) { c.handled = false; n++; } }
      else if (!c.paid && !c.handled) { c.handled = true; n++; }
    }
  }
  save(db); json(res, { ok: true, updated: n });
});

// GET /api/contractors/names — שמות קבלנים ייחודיים מתוך האירועים (עם ספירה וסכום)
add('GET', /^\/api\/contractors\/names$/, (req, res, _p, q) => {
  const db = load();
  const evs = q.companyId ? companyEvents(db, q.companyId) : db.events;
  const map = {};
  for (const ev of evs) {
    for (const c of (ev.contractorDetails || [])) {
      const name = (c.name || '').trim();
      if (!name) continue;
      if (!map[name]) map[name] = { name, count: 0, total: 0 };
      map[name].count++;
      map[name].total += Number(c.amount) || 0;
    }
  }
  json(res, Object.values(map).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'he')));
});

// POST /api/contractors/rename-bulk { renames:[{from,to}] } — עדכון שם קבלן בכל האירועים (לפי שמות חשבונית ירוקה)
add('POST', /^\/api\/contractors\/rename-bulk$/, (req, res, _p, _q, body) => {
  const db = load();
  const map = new Map((Array.isArray(body.renames) ? body.renames : [])
    .filter(r => r && r.from && r.to && String(r.from).trim() !== String(r.to).trim())
    .map(r => [String(r.from).trim(), String(r.to).trim()]));
  if (!map.size) return json(res, { error: 'אין שינויים לביצוע' }, 400);
  let changed = 0; const applied = {};
  for (const ev of db.events) {
    for (const c of (ev.contractorDetails || [])) {
      const key = (c.name || '').trim();
      if (map.has(key)) { c.name = map.get(key); changed++; applied[key] = (applied[key] || 0) + 1; }
    }
    if (Array.isArray(ev.contractors)) ev.contractors = ev.contractors.map(n => map.get((n || '').trim()) || n);
  }
  save(db); json(res, { ok: true, changed, applied });
});

// POST /api/contractors/auto-sync-names — עדכון אוטומטי של שמות קבלנים לפי חשבונית ירוקה (רק התאמות ודאיות)
// התאמה ודאית = שם הקבלן זהה לספק, או שקיים בדיוק ספק אחד שהשם שלו מכיל את שם הקבלן (או להיפך).
add('POST', /^\/api\/contractors\/auto-sync-names$/, async (req, res) => {
  const db = load();
  let suppliers = [];
  try { suppliers = (await greenInvoice.listSuppliers()).map(s => (s.name || '').trim()).filter(Boolean); }
  catch (e) { return json(res, { ok: false, changed: 0, error: e.message }); }
  const supSet = new Set(suppliers);
  // שמות קבלנים ייחודיים מהאירועים
  const names = new Set();
  for (const ev of db.events) for (const c of (ev.contractorDetails || [])) { const n = (c.name || '').trim(); if (n) names.add(n); }
  const renameMap = new Map();
  for (const name of names) {
    if (supSet.has(name)) continue; // כבר תואם במדויק
    const cand = suppliers.filter(s => s !== name && (s.includes(name) || name.includes(s)));
    if (cand.length === 1) renameMap.set(name, cand[0]); // רק כשיש התאמה יחידה וודאית
  }
  let changed = 0; const applied = {};
  if (renameMap.size) {
    for (const ev of db.events) {
      for (const c of (ev.contractorDetails || [])) {
        const k = (c.name || '').trim();
        if (renameMap.has(k)) { c.name = renameMap.get(k); changed++; applied[k] = renameMap.get(k); }
      }
      if (Array.isArray(ev.contractors)) ev.contractors = ev.contractors.map(n => renameMap.get((n || '').trim()) || n);
    }
    if (changed) save(db);
  }
  json(res, { ok: true, changed, applied });
});

// GET /api/contractors/:id/documents — מסמכי הוצאה של קבלן/ספק מחשבונית ירוקה
add('GET', /^\/api\/contractors\/([^/]+)\/documents$/, async (req, res, params) => {
  try { json(res, await greenInvoice.supplierExpenses(params[0])); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/payroll?companyId=&month=
add('GET', /^\/api\/payroll$/, (req, res, _p, q) => {
  const db = load();
  const emps = (db.employees || []).filter(e => !e.companyId || e.companyId === q.companyId);
  json(res, employeePayForMonth(companyEvents(db, q.companyId), q.month, emps));
});

// ---- עובדים (רשימה מרכזית עם שכר בסיס) ----
// GET /api/employees?companyId=
add('GET', /^\/api\/employees$/, (req, res, _p, q) => {
  const db = load();
  json(res, (db.employees || []).filter(e => !e.companyId || e.companyId === q.companyId)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he')));
});
// POST /api/employees  { name, baseRate }
add('POST', /^\/api\/employees$/, (req, res, _p, _q, body) => {
  const db = load();
  const cid = body.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  const name = (body.name || '').trim();
  if (!name) return json(res, { error: 'חסר שם עובד' }, 400);
  let emp = (db.employees || []).find(e => e.name === name && (!e.companyId || e.companyId === cid));
  if (emp) { emp.baseRate = body.baseRate ?? emp.baseRate; }
  else { emp = { id: id('emp'), companyId: cid, name, baseRate: body.baseRate ?? null, salaryType: body.salaryType || 'gross', active: true }; db.employees.push(emp); }
  save(db); json(res, emp);
});
// PUT /api/employees/:id
add('PUT', /^\/api\/employees\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const emp = (db.employees || []).find(e => e.id === params[0]);
  if (!emp) return json(res, { error: 'עובד לא נמצא' }, 404);
  Object.assign(emp, body); save(db); json(res, emp);
});
// DELETE /api/employees/:id
add('DELETE', /^\/api\/employees\/([^/]+)$/, (req, res, params) => {
  const db = load();
  const before = (db.employees || []).length;
  db.employees = (db.employees || []).filter(e => e.id !== params[0]);
  if (db.employees.length === before) return json(res, { error: 'עובד לא נמצא' }, 404);
  save(db); json(res, { ok: true });
});

// POST /api/employees/sync — יוצר עובדים מרכזיים מכל השמות שמופיעים באירועים
add('POST', /^\/api\/employees\/sync$/, (req, res, _p, q, body) => {
  const db = load();
  const cid = (body && body.companyId) || q.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  const names = new Set();
  for (const ev of companyEvents(db, cid)) for (const w of (ev.employeeDetails || [])) if (w.name) names.add(String(w.name).trim());
  const existing = new Set((db.employees || []).filter(e => !e.companyId || e.companyId === cid).map(e => e.name));
  let added = 0;
  for (const name of names) { if (name && !existing.has(name)) { db.employees.push({ id: id('emp'), companyId: cid, name, baseRate: null, salaryType: 'gross', active: true }); added++; } }
  save(db); json(res, { added });
});

// ---- מסמכי עובד (העלאה/צפייה/מחיקה) ----
// POST /api/employees/:id/files  { kind, filename, mime, data(base64) }
add('POST', /^\/api\/employees\/([^/]+)\/files$/, async (req, res, params, _q, body) => {
  const db = load();
  const emp = (db.employees || []).find(e => e.id === params[0]);
  if (!emp) return json(res, { error: 'עובד לא נמצא' }, 404);
  if (!body || !body.data || !body.kind) return json(res, { error: 'חסר קובץ או סוג' }, 400);
  const fileId = id('file');
  await saveFile({ id: fileId, employeeId: emp.id, kind: body.kind, filename: body.filename || 'file', mime: body.mime || 'application/octet-stream', data: body.data });
  emp.docs = emp.docs || {};
  // אם היה קובץ קודם מאותו סוג — נמחק אותו
  const prev = emp.docs[body.kind];
  if (prev) { try { await deleteFile(prev); } catch { } }
  emp.docs[body.kind] = fileId;
  save(db);
  json(res, { fileId, kind: body.kind, filename: body.filename || 'file' });
});
// GET /api/files/:id — הגשת הקובץ (צפייה=inline / הורדה=?download=1)
add('GET', /^\/api\/files\/([^/]+)$/, async (req, res, params, q) => {
  const f = await getFile(params[0]);
  if (!f) return json(res, { error: 'קובץ לא נמצא' }, 404);
  const buf = Buffer.from(f.data || '', 'base64');
  const disp = (q && q.download) ? 'attachment' : 'inline';
  res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `${disp}; filename="${encodeURIComponent(f.filename || 'file')}"`, 'Content-Length': buf.length });
  res.end(buf);
});
// DELETE /api/files/:id — מחיקת קובץ + הסרת ההפניה מהעובד
add('DELETE', /^\/api\/files\/([^/]+)$/, async (req, res, params) => {
  const db = load();
  for (const emp of (db.employees || [])) {
    if (emp.docs) for (const k of Object.keys(emp.docs)) if (emp.docs[k] === params[0]) delete emp.docs[k];
  }
  save(db);
  try { await deleteFile(params[0]); } catch { }
  json(res, { ok: true });
});

// ===== פרטי העסק (Business Profile) — פר-חברה, עם מסמכים בטבלה נפרדת =====
function bizProfile(db, cid) {
  db.businessProfiles = db.businessProfiles || {};
  if (!db.businessProfiles[cid]) {
    db.businessProfiles[cid] = { name: '', businessNumber: '', email: '', address: '', managers: [{}, {}], bankConfirmation: null, taxConfirmation: null, additionalDocs: [] };
  }
  const p = db.businessProfiles[cid];
  p.managers = Array.isArray(p.managers) ? p.managers : [{}, {}];
  while (p.managers.length < 2) p.managers.push({});
  p.additionalDocs = Array.isArray(p.additionalDocs) ? p.additionalDocs : [];
  return p;
}
// GET /api/business-profile?companyId=
add('GET', /^\/api\/business-profile$/, (req, res, _p, q) => {
  const db = load();
  json(res, bizProfile(db, q.companyId || giCompanyId()));
});
// GET /api/business-profile/alerts — אישורי ניכוי מס שפגים בתוך 14 יום (לכל החברות)
add('GET', /^\/api\/business-profile\/alerts$/, (req, res) => {
  const db = load();
  const profs = db.businessProfiles || {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const c of (db.companies || [])) {
    const prof = profs[c.id] || {};
    const tc = prof.taxConfirmation;
    if (tc && tc.expiry) {
      const days = Math.round((new Date(tc.expiry + 'T00:00:00') - today) / 86400000);
      if (days <= 14) out.push({ companyId: c.id, companyName: c.name, kind: 'taxCert', expiry: tc.expiry, daysLeft: days, expired: days < 0 });
    }
    // חיבור לרשות המיסים (מספרי הקצאה) — תוקף = תאריך חידוש + מספר ימים (ברירת מחדל 90)
    const ta = prof.taxAuthority;
    if (ta && ta.renewedAt) {
      const vd = Number(ta.validDays) || 90;
      const exp = new Date(ta.renewedAt + 'T00:00:00'); exp.setDate(exp.getDate() + vd);
      const days = Math.round((exp - today) / 86400000);
      if (days <= 14) out.push({ companyId: c.id, companyName: c.name, kind: 'taxAuthority', expiry: exp.toISOString().slice(0, 10), daysLeft: days, expired: days < 0 });
    }
  }
  json(res, { alerts: out });
});
// PUT /api/business-profile?companyId= — שמירת שדות טקסט
add('PUT', /^\/api\/business-profile$/, (req, res, _p, q, body) => {
  const db = load();
  const p = bizProfile(db, q.companyId || giCompanyId());
  const b = body || {};
  ['name', 'businessNumber', 'email', 'address'].forEach(k => { if (k in b) p[k] = String(b[k] || ''); });
  if (Array.isArray(b.managers)) b.managers.slice(0, 2).forEach((m, i) => {
    p.managers[i] = p.managers[i] || {};
    ['name', 'idNumber', 'phone', 'email'].forEach(k => { if (k in m) p.managers[i][k] = String(m[k] || ''); });
  });
  if ('taxExpiry' in b) { p.taxConfirmation = p.taxConfirmation || {}; p.taxConfirmation.expiry = b.taxExpiry ? String(b.taxExpiry).slice(0, 10) : ''; }
  if ('taxAuthorityRenewedAt' in b) { p.taxAuthority = p.taxAuthority || {}; p.taxAuthority.renewedAt = b.taxAuthorityRenewedAt ? String(b.taxAuthorityRenewedAt).slice(0, 10) : ''; }
  if ('taxAuthorityValidDays' in b) { p.taxAuthority = p.taxAuthority || {}; p.taxAuthority.validDays = Number(b.taxAuthorityValidDays) || 90; }
  save(db); json(res, p);
});
// POST /api/business-profile/file?companyId=&slot= { filename, mime, data(base64), expiry?, label? }
add('POST', /^\/api\/business-profile\/file$/, async (req, res, _p, q, body) => {
  const db = load();
  const cid = q.companyId || giCompanyId();
  const slot = String(q.slot || (body && body.slot) || '');
  if (!body || !body.data || !slot) return json(res, { error: 'חסר קובץ או משבצת' }, 400);
  const p = bizProfile(db, cid);
  const fileId = id('file');
  await saveFile({ id: fileId, employeeId: 'biz:' + cid, kind: slot, filename: body.filename || 'file', mime: body.mime || 'application/octet-stream', data: body.data });
  const meta = { fileId, filename: body.filename || 'file', mime: body.mime || 'application/octet-stream' };
  const mgr = slot.match(/^mgr(\d)_(.+)$/);
  if (mgr) {
    const i = +mgr[1], key = mgr[2];
    p.managers[i] = p.managers[i] || {};
    p.managers[i].files = p.managers[i].files || {};
    const prev = p.managers[i].files[key];
    if (prev && prev.fileId) { try { await deleteFile(prev.fileId); } catch { } }
    p.managers[i].files[key] = meta;
  } else if (slot === 'bank') {
    if (p.bankConfirmation && p.bankConfirmation.fileId) { try { await deleteFile(p.bankConfirmation.fileId); } catch { } }
    p.bankConfirmation = meta;
  } else if (slot === 'tax') {
    const oldExpiry = (p.taxConfirmation && p.taxConfirmation.expiry) || '';
    if (p.taxConfirmation && p.taxConfirmation.fileId) { try { await deleteFile(p.taxConfirmation.fileId); } catch { } }
    p.taxConfirmation = { ...meta, expiry: body.expiry ? String(body.expiry).slice(0, 10) : oldExpiry };
  } else if (slot === 'add') {
    if ((p.additionalDocs || []).length >= 6) return json(res, { error: 'ניתן עד 6 מסמכים נוספים' }, 400);
    p.additionalDocs.push({ ...meta, label: body.label || body.filename || 'מסמך' });
  } else return json(res, { error: 'משבצת לא מוכרת' }, 400);
  save(db); json(res, { ok: true, fileId, slot });
});
// DELETE /api/business-profile/file?companyId=&slot=&fileId=
add('DELETE', /^\/api\/business-profile\/file$/, async (req, res, _p, q) => {
  const db = load();
  const p = bizProfile(db, q.companyId || giCompanyId());
  const slot = String(q.slot || ''), fid = String(q.fileId || '');
  const mgr = slot.match(/^mgr(\d)_(.+)$/);
  if (mgr) { const i = +mgr[1], key = mgr[2]; if (p.managers[i] && p.managers[i].files) delete p.managers[i].files[key]; }
  else if (slot === 'bank') p.bankConfirmation = null;
  else if (slot === 'tax') { const ex = p.taxConfirmation && p.taxConfirmation.expiry; p.taxConfirmation = ex ? { expiry: ex } : null; }
  else if (slot === 'add') p.additionalDocs = (p.additionalDocs || []).filter(d => d.fileId !== fid);
  save(db);
  if (fid) { try { await deleteFile(fid); } catch { } }
  json(res, { ok: true });
});

// GET /api/employees/:id/jobs?month= — עבודות של עובד לחודש (מתוך חישוב השכר)
add('GET', /^\/api\/employees\/([^/]+)\/jobs$/, (req, res, params, q) => {
  const db = load();
  const emp = (db.employees || []).find(e => e.id === params[0]);
  if (!emp) return json(res, { error: 'עובד לא נמצא' }, 404);
  const emps = (db.employees || []).filter(e => !e.companyId || e.companyId === emp.companyId);
  const pay = employeePayForMonth(companyEvents(db, emp.companyId), q.month, emps).find(p => p.name === emp.name);
  json(res, { employee: emp, month: q.month, pay: pay || { shifts: [], base: 0, bonus: 0, total: 0 } });
});

// POST /api/interpret-bonuses  { note, employees:[names] } — מפרש הוראת בונוס להחלה על עובדים
add('POST', /^\/api\/interpret-bonuses$/, async (req, res, _p, _q, body) => {
  try { json(res, await interpretBonuses(body?.note || '', body?.employees || [])); }
  catch (e) { json(res, { error: e.message }, 200); }
});

// GET /api/suppliers — ספקים מחשבונית ירוקה (fresh=1 מרענן)
add('GET', /^\/api\/suppliers$/, async (req, res, _p, q) => {
  if (q.fresh) greenInvoice.clearDataCache();
  try { json(res, await greenInvoice.listSuppliers()); }
  catch (e) { json(res, { error: e.message }, 200); }
});

// GET /api/accounting/classifications — סיווגים חשבונאיים (סיווגי הוצאה) מחשבונית ירוקה
add('GET', /^\/api\/accounting\/classifications$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { classifications: [], error: 'חשבונית ירוקה לא מחוברת' });
  if (q.debug) { try { return json(res, { debug: await greenInvoice.debugClassifications() }); } catch (e) { return json(res, { error: e.message }); } }
  try { json(res, { classifications: await greenInvoice.listAccountingClassifications() }); }
  catch (e) { json(res, { classifications: [], error: e.message }); }
});

// POST /api/clients — יצירת לקוח חדש בחשבונית ירוקה
add('POST', /^\/api\/clients$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.name) return json(res, { error: 'חסר שם' }, 400);
  try { json(res, { ok: true, client: await greenInvoice.createClient(body) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/suppliers — יצירת ספק חדש בחשבונית ירוקה
add('POST', /^\/api\/suppliers$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.name) return json(res, { error: 'חסר שם' }, 400);
  try { json(res, { ok: true, supplier: await greenInvoice.createSupplier(body) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// PUT /api/clients/:id/details — עריכת פרטי לקוח (שם, מייל, טלפון, ח.פ) בחשבונית ירוקה
add('PUT', /^\/api\/clients\/([^/]+)\/details$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, client: await greenInvoice.updateClientDetails(params[0], body || {}) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});
// PUT /api/suppliers/:id/details — עריכת פרטי ספק (שם, מייל, טלפון, ח.פ) בחשבונית ירוקה
add('PUT', /^\/api\/suppliers\/([^/]+)\/details$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, supplier: await greenInvoice.updateSupplierDetails(params[0], body || {}) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

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
  const image = (body?.image && body.image.data) ? { data: String(body.image.data), mime: body.image.mime || 'image/png' } : null;
  if (!text && !image) return json(res, { error: 'חסר טקסט' }, 400);
  if (!chatConfigured()) return json(res, { error: 'הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY ב-Render' }, 400);

  const db = load();
  db.chats = db.chats || {};
  db.memory = db.memory || {};
  const appMap = buildAppMap(db); // מפה מלאה ומתעדכנת של האפליקציה — מוזרקת לכל דמות
  const now = new Date().toISOString();

  if (id === 'group') {
    const history = db.chats.group = db.chats.group || [];
    history.push({ role: 'user', name: 'אתה', content: text, at: now });
    try {
      // כל חבר צוות עונה בתורו על סמך התמלול המתעדכן, עם הזיכרון האישי שלו ומפת האפליקציה
      for (const member of TEAM) {
        const transcript = history.map(m => `${m.name || (m.role === 'user' ? 'אתה' : 'צוות')}: ${m.content}`).join('\n');
        const reply = await chatGroupReply(member, transcript, db.memory[member.id] || '', appMap);
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
  // לא שומרים את ה-base64 של התמונה ב-DB (רק סימון) כדי לא לנפח את המסמך
  history.push({ role: 'user', content: image ? ('📷 צילום מסך' + (text ? ' — ' + text : '')) : text, hasImage: !!image, at: now });
  try {
    const reply = image
      ? await chatWithMemberVision(member, history, db.memory[id] || '', appMap, image, text)
      : await chatWithMember(member, history, db.memory[id] || '', appMap);
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

// ---- בקשות פיתוח (נוצרות מסיכום שיחות עם הצוות) ----
// POST /api/team/:id/summarize-request — הופך את השיחה לבקשת פיתוח בתיבה
add('POST', /^\/api\/team\/([^/]+)\/summarize-request$/, async (req, res, params) => {
  const chatId = params[0];
  if (!chatConfigured()) return json(res, { error: 'הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY ב-Render' }, 400);
  const db = load();
  const history = db.chats?.[chatId] || [];
  if (!history.length) return json(res, { error: 'אין שיחה לסכם — כתוב קודם מה תרצה' }, 400);
  const member = chatId === 'group' ? { name: 'הצוות', role: 'צוות' } : (findMember(chatId) || { name: 'עוזר', role: '' });
  const transcript = history.slice(-30).map(m => `${m.name || (m.role === 'user' ? 'מנהל' : member.name)}: ${m.content}`).join('\n');
  try {
    const spec = await summarizeAsRequest(member, transcript);
    db.requests = db.requests || [];
    const request = {
      id: id('req'),
      memberId: chatId, memberName: member.name,
      title: spec.title, summary: spec.summary, details: spec.details, priority: spec.priority,
      status: 'open',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.requests.unshift(request);
    save(db);
    json(res, { ok: true, request });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/requests
add('GET', /^\/api\/requests$/, (req, res) => json(res, load().requests || []));

// PUT /api/requests/:id  { status?, title? }
add('PUT', /^\/api\/requests\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const r = (db.requests || []).find(x => x.id === params[0]);
  if (!r) return json(res, { error: 'לא נמצא' }, 404);
  if (body.status) r.status = body.status;
  if (body.title != null) r.title = body.title;
  r.updatedAt = new Date().toISOString();
  save(db);
  json(res, { ok: true, request: r });
});

// DELETE /api/requests/:id
add('DELETE', /^\/api\/requests\/([^/]+)$/, (req, res, params) => {
  const db = load();
  db.requests = (db.requests || []).filter(x => x.id !== params[0]);
  save(db);
  json(res, { ok: true });
});

// GET /api/dashboard?month=YYYY-MM  — נתוני דף הבית מחשבונית ירוקה
add('GET', /^\/api\/dashboard$/, async (req, res, _p, q) => {
  // טווח: from/to בפורמט YYYY-MM (או YYYY-MM-DD). ברירת מחדל — החודש הנוכחי.
  const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
  let fromDate, toDate;
  if (q.from && q.to) {
    fromDate = q.from.length === 7 ? `${q.from}-01` : q.from;
    toDate = q.to.length === 7 ? lastDay(q.to) : q.to;
  } else {
    const month = q.month || new Date().toISOString().slice(0, 7);
    fromDate = `${month}-01`; toDate = lastDay(month);
  }
  const types = q.types ? String(q.types).split(',').map(Number).filter(Boolean) : [305, 320];
  const out = { month: q.month || null, fromDate, toDate, types, income: null, vat: null, openInvoices: null, openInvoicesSum: null, monthDocs: null, docs: [], clients: [], bank: null, errors: {} };
  if (greenInvoice.haveCredentials()) {
    try { const m = await greenInvoice.incomeForRange(fromDate, toDate, types); out.income = m.income; out.vat = m.vat; out.monthDocs = m.count; out.docs = m.docs; }
    catch (e) { out.errors.income = e.message; }
    try {
      const openDocs = await greenInvoice.openDocuments();
      out.openInvoices = openDocs.length;
      out.openInvoicesSum = openDocs.reduce((s, d) => s + (d.amountDue != null ? Number(d.amountDue) : Number(d.amount) || 0), 0);
    } catch (e) { out.errors.open = e.message; }
    try { out.clients = await greenInvoice.listClients(); } catch (e) { out.errors.clients = e.message; }
  } else { out.errors.greenInvoice = 'חשבונית ירוקה לא מחוברת'; }
  json(res, out);
});

// GET /api/clients — רשימת לקוחות (fresh=1 מרענן מחשבונית ירוקה)
add('GET', /^\/api\/clients$/, async (req, res, _p, q) => {
  if (q.fresh) greenInvoice.clearDataCache();
  try { json(res, await greenInvoice.listClients()); } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/clients/:id/documents — כל המסמכים של לקוח
add('GET', /^\/api\/clients\/([^/]+)\/documents$/, async (req, res, params) => {
  try { json(res, await greenInvoice.clientDocuments(params[0])); } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/suppliers/:id/documents — מסמכי ההוצאה של ספק (לשיוך ידני בבנק)
add('GET', /^\/api\/suppliers\/([^/]+)\/documents$/, async (req, res, params) => {
  try { json(res, await greenInvoice.supplierExpenses(params[0])); } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/expenses/notes — מפת תיאורים מותאמים להוצאות (override) לשימוש בהתאמות הבנק
add('GET', /^\/api\/expenses\/notes$/, (req, res) => json(res, load().expenseNotes || {}));

// POST /api/expenses/:id/note { description } — עריכת תיאור הוצאה בחשבונית ירוקה + עדכון בהתאמות הבנק
add('POST', /^\/api\/expenses\/([^/]+)\/note$/, async (req, res, params, _q, body) => {
  const id = params[0];
  const desc = String(body?.description ?? '').trim();
  // 1) עדכון בחשבונית ירוקה עצמה (המסמך האמיתי)
  let greenInvoiceUpdated = false, giError = null;
  if (greenInvoice.haveCredentials()) {
    try { await greenInvoice.updateExpenseDescription(id, desc); greenInvoiceUpdated = true; }
    catch (e) { giError = e.message; }
  }
  // 2) שמירת override מקומי + עדכון תנועות הבנק המותאמות (כדי שישתקף גם אם ה-API נכשל)
  const db = load();
  db.expenseNotes = db.expenseNotes || {};
  if (desc) db.expenseNotes[id] = desc; else delete db.expenseNotes[id];
  for (const t of (db.bankTx || [])) for (const inv of (t.matchedInvoices || [])) if (inv.id === id) inv.description = desc;
  save(db);
  json(res, { ok: true, id, description: desc, greenInvoiceUpdated, giError });
});

// GET /api/expenses/quick-search?q= — חיפוש מסמכי הוצאה לפי מספר/תיאור
add('GET', /^\/api\/expenses\/quick-search$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { items: [] });
  const term = (q.q || '').trim();
  if (term.length < 2) return json(res, { items: [] });
  try { json(res, { ok: true, items: await greenInvoice.quickSearchExpenses(term) }); }
  catch (e) { json(res, { items: [], error: e.message }); }
});

// ---- בנק: ייבוא תנועות + התאמה לחשבוניות הכנסה ----
function ddmmyyyyToISO(d) { const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }
function shiftISODays(iso, days) { const d = new Date(iso); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function bankSig(t) { return `${t.date}|${t.absAmount}|${t.reference || ''}|${(t.description || '').slice(0, 20)}`; }

// POST /api/bank/import  { text, companyId }
add('POST', /^\/api\/bank\/import$/, async (req, res, _p, _q, body) => {
  const text = body?.text || '';
  const companyId = body?.companyId || null;
  // יתרת עו"ש רשמית מכותרת הקובץ — נשמרת בנפרד ומשמשת כיתרה הקובעת
  const acctBal = extractAccountBalance(text);
  if (acctBal) {
    const db2 = load();
    db2.bankBalance = (db2.bankBalance || []).filter(b => b.companyId !== companyId);
    db2.bankBalance.push({ companyId, balance: acctBal.balance, date: acctBal.date, time: acctBal.time || null, importedAt: new Date().toISOString() });
    save(db2);
  }
  const parsed = parseBank(text);
  if (!parsed.length) return json(res, { ok: true, added: 0, total: 0, accountBalance: acctBal || null, message: acctBal ? `עודכנה יתרת עו"ש: ${acctBal.balance}` : 'לא זוהו תנועות בטקסט' });
  // טווח תאריכים לשליפת חשבוניות (הכנסה) + הוצאות (ספקים) להתאמה אוטומטית בשני הצדדים
  let invoices = [], receipts = [], expenses = [];
  const iso = parsed.map(t => ddmmyyyyToISO(t.date)).filter(Boolean).sort();
  if (greenInvoice.haveCredentials() && iso.length && companyId === giCompanyId()) {
    const from = shiftISODays(iso[0], -75), to = shiftISODays(iso[iso.length - 1], 5);
    try { const inc = await greenInvoice.incomeForRange(from, to); invoices = inc.docs || []; } catch (e) { /* נמשיך בלי התאמה */ }
    try { receipts = await greenInvoice.receiptsForRange(from, to); } catch (e) { /* קבלות אופציונליות */ }
    try { expenses = await greenInvoice.expensesInRange(from, to); } catch (e) { /* הוצאות אופציונליות */ }
  }
  const matched = attachReceipts(matchCredits(parsed, invoices), receipts);
  // החלת תיאורים מותאמים (override) על ההוצאות לפני ההתאמה
  try { const _notes = load().expenseNotes || {}; if (Object.keys(_notes).length) expenses.forEach(e => { if (_notes[e.id]) e.description = _notes[e.id]; }); } catch { }
  // התאמת צד ההוצאות: חשבוניות ספקים ↔ תנועות חובה (אוטומטי כמו בהכנסות)
  try {
    for (const dm of matchDebits(parsed, expenses)) {
      const t = matched[dm.i];
      if (t) { t.matchStatus = dm.matchStatus; t.matchedInvoices = dm.matchedInvoices; t.suggestions = dm.suggestions; }
    }
  } catch { /* לא חוסם ייבוא */ }
  const db = load();
  db.bankTx = db.bankTx || [];
  const bySig = new Map(db.bankTx.filter(t => !companyId || t.companyId === companyId).map(t => [t.sig, t]));
  let added = 0, backfilled = 0;
  for (const t of matched) {
    const sig = bankSig(t);
    const ex = bySig.get(sig);
    if (ex) {
      // תנועה קיימת — נשלים יתרה רצה (balance) אם חסרה, כדי שעו"ש יתעדכן גם בלי כותרת
      if (t.balance != null && ex.balance !== t.balance) { ex.balance = t.balance; backfilled++; }
      // רענון הצעות החובה על תנועות קיימות שלא אושרו/סומנו ידנית (בלי התאמה אוטומטית — רק הצעות)
      if (ex.direction === 'debit' && ex.matchStatus !== 'manual' && ex.matchStatus !== 'ignored') {
        ex.matchStatus = t.matchStatus; ex.matchedInvoices = t.matchedInvoices || []; ex.suggestions = t.suggestions || [];
      }
      continue;
    }
    const rec = {
      id: id('btx'), companyId, sig,
      date: t.date, description: t.description, amount: t.amount, absAmount: t.absAmount,
      direction: t.direction, reference: t.reference, invoiceNumber: t.invoiceNumber,
      nameHint: t.nameHint, memo: t.memo, balance: t.balance ?? null,
      matchStatus: t.matchStatus, matchedInvoices: t.matchedInvoices || [], suggestions: t.suggestions || [],
      importedAt: new Date().toISOString(),
    };
    db.bankTx.push(rec); bySig.set(sig, rec); added++;
  }
  save(db);
  const credits = matched.filter(t => t.direction === 'credit');
  const debits = matched.filter(t => t.direction === 'debit');
  json(res, { ok: true, added, backfilled, total: parsed.length, credits: credits.length, autoMatched: credits.filter(t => t.matchStatus === 'auto').length, debits: debits.length, debitMatched: debits.filter(t => t.matchStatus === 'auto').length, invoicesLoaded: invoices.length, expensesLoaded: expenses.length, accountBalance: acctBal || null });
});

// POST /api/bank/rematch { companyId } — הרצת התאמה אוטומטית מחדש של תנועות חובה על התנועות הקיימות (בלי העלאה חוזרת)
add('POST', /^\/api\/bank\/rematch$/, async (req, res, _p, _q, body) => {
  const companyId = body?.companyId || null;
  const db = load();
  const txns = (db.bankTx || []).filter(t => !companyId || t.companyId === companyId);
  if (!txns.length) return json(res, { ok: true, updated: 0, message: 'אין תנועות' });
  const iso = txns.map(t => ddmmyyyyToISO(t.date)).filter(Boolean).sort();
  let expenses = [];
  if (greenInvoice.haveCredentials() && iso.length && companyId === giCompanyId()) {
    const from = shiftISODays(iso[0], -75), to = shiftISODays(iso[iso.length - 1], 5);
    try { expenses = await greenInvoice.expensesInRange(from, to); } catch { /* בלי התאמה */ }
  }
  try { const _notes = db.expenseNotes || {}; if (Object.keys(_notes).length) expenses.forEach(e => { if (_notes[e.id]) e.description = _notes[e.id]; }); } catch { }
  const dmap = new Map();
  for (const dm of matchDebits(txns, expenses)) dmap.set(dm.i, dm);
  let updated = 0;
  txns.forEach((t, i) => {
    if (t.direction !== 'debit' || t.matchStatus === 'manual' || t.matchStatus === 'ignored') return; // לא נוגעים בידני/מסומן
    const dm = dmap.get(i);
    if (dm) { t.matchStatus = dm.matchStatus; t.matchedInvoices = dm.matchedInvoices || []; t.suggestions = dm.suggestions || []; updated++; }
  });
  save(db);
  const debits = txns.filter(t => t.direction === 'debit');
  json(res, { ok: true, updated, debits: debits.length, debitMatched: debits.filter(t => t.matchStatus === 'auto').length, expensesLoaded: expenses.length });
});

// GET /api/bank/balance?companyId= — יתרת עו"ש הרשמית האחרונה שנקלטה
add('GET', /^\/api\/bank\/balance$/, (req, res, _p, q) => {
  const db = load();
  const b = (db.bankBalance || []).find(x => x.companyId === (q.companyId || null)) || (db.bankBalance || [])[0] || null;
  json(res, b);
});

// GET /api/bank?companyId=
add('GET', /^\/api\/bank$/, (req, res, _p, q) => {
  const db = load();
  let list = (db.bankTx || []).filter(t => !q.companyId || t.companyId === q.companyId);
  const key = (d) => (d || '').split('/').reverse().join('');
  list = [...list].sort((a, b) => key(b.date).localeCompare(key(a.date)));
  json(res, list);
});

// PUT /api/bank/:id  { matchStatus?, matchedInvoice? }
add('PUT', /^\/api\/bank\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const t = (db.bankTx || []).find(x => x.id === params[0]);
  if (!t) return json(res, { error: 'לא נמצא' }, 404);
  if (body.matchStatus) t.matchStatus = body.matchStatus;
  if (body.matchedInvoices !== undefined) t.matchedInvoices = body.matchedInvoices;
  if (body.notes !== undefined) t.notes = body.notes;
  save(db);
  json(res, { ok: true, tx: t });
});

// DELETE /api/bank/:id
add('DELETE', /^\/api\/bank\/([^/]+)$/, (req, res, params) => {
  const db = load();
  db.bankTx = (db.bankTx || []).filter(x => x.id !== params[0]);
  save(db);
  json(res, { ok: true });
});

// DELETE /api/bank  — ניקוי כל התנועות של החברה
add('DELETE', /^\/api\/bank$/, (req, res, _p, q) => {
  const db = load();
  db.bankTx = (db.bankTx || []).filter(t => q.companyId && t.companyId !== q.companyId);
  save(db);
  json(res, { ok: true });
});

// ================= התחברות והרשאות =================
const VALID_TABS = ['home', 'events', 'clients', 'invoicing', 'quotes', 'contractors', 'payroll', 'bank', 'team', 'connections'];
const uid = () => id('usr');
const cleanUsername = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// GET /api/auth/status — האם צריך הגדרה ראשונית, והאם המשתמש מחובר
add('GET', /^\/api\/auth\/status$/, (req, res) => {
  const db = load();
  const setupNeeded = !(db.users || []).some(u => u.role === 'admin');
  const user = getSessionUser(db, req);
  json(res, { ok: true, setupNeeded, authenticated: !!user, user: publicUser(user) });
});

// POST /api/auth/setup { username, password } — יצירת משתמש ההנהלה הראשון (רק אם אין עדיין מנהל)
add('POST', /^\/api\/auth\/setup$/, (req, res, _p, _q, body) => {
  const db = load();
  if ((db.users || []).some(u => u.role === 'admin')) return json(res, { error: 'המערכת כבר מוגדרת' }, 400);
  const username = cleanUsername(body?.username);
  const password = String(body?.password || '');
  if (username.length < 2) return json(res, { error: 'שם משתמש קצר מדי' }, 400);
  if (password.length < 6) return json(res, { error: 'הסיסמה חייבת להיות באורך 6 תווים לפחות' }, 400);
  const { salt, hash } = hashPassword(password);
  const user = { id: uid(), username, salt, hash, role: 'admin', tabs: [], companies: [], createdAt: new Date().toISOString() };
  db.users = db.users || []; db.users.push(user);
  const token = createSession(db, user.id);
  save(db);
  setSessionCookie(res, token);
  json(res, { ok: true, user: publicUser(user) });
});

// POST /api/auth/login { username, password }
add('POST', /^\/api\/auth\/login$/, (req, res, _p, _q, body) => {
  const db = load();
  const username = cleanUsername(body?.username);
  const u = (db.users || []).find(x => x.username === username);
  if (!u || !verifyPassword(String(body?.password || ''), u.salt, u.hash)) {
    return json(res, { error: 'שם משתמש או סיסמה שגויים' }, 401);
  }
  const token = createSession(db, u.id);
  save(db);
  setSessionCookie(res, token);
  json(res, { ok: true, user: publicUser(u) });
});

// POST /api/auth/logout
add('POST', /^\/api\/auth\/logout$/, (req, res) => {
  const db = load();
  const u = getSessionUser(db, req);
  if (u && u._token) { destroySession(db, u._token); save(db); }
  clearSessionCookie(res);
  json(res, { ok: true });
});

// GET /api/auth/me — פרטי המשתמש המחובר
add('GET', /^\/api\/auth\/me$/, (req, res) => {
  const db = load();
  json(res, { ok: true, user: publicUser(getSessionUser(db, req)) });
});

// GET /api/users — רשימת משתמשים (מנהל בלבד)
add('GET', /^\/api\/users$/, (req, res) => {
  const db = load();
  json(res, { ok: true, users: (db.users || []).map(publicUser) });
});

// POST /api/users { username, password, tabs, companies } — יצירת משתמש צפייה (מנהל בלבד)
add('POST', /^\/api\/users$/, (req, res, _p, _q, body) => {
  const db = load();
  const username = cleanUsername(body?.username);
  const password = String(body?.password || '');
  if (username.length < 2) return json(res, { error: 'שם משתמש קצר מדי' }, 400);
  if (password.length < 6) return json(res, { error: 'הסיסמה חייבת להיות באורך 6 תווים לפחות' }, 400);
  if ((db.users || []).some(u => u.username === username)) return json(res, { error: 'שם המשתמש כבר קיים' }, 400);
  const tabs = Array.isArray(body?.tabs) ? body.tabs.filter(t => VALID_TABS.includes(t)) : [];
  const companies = Array.isArray(body?.companies) ? body.companies.filter(Boolean) : [];
  const { salt, hash } = hashPassword(password);
  const user = { id: uid(), username, salt, hash, role: 'viewer', tabs, companies, createdAt: new Date().toISOString() };
  db.users = db.users || []; db.users.push(user);
  save(db);
  json(res, { ok: true, user: publicUser(user) });
});

// PUT /api/users/:id { tabs?, companies?, password? } — עדכון משתמש צפייה (מנהל בלבד)
add('PUT', /^\/api\/users\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const u = (db.users || []).find(x => x.id === params[0]);
  if (!u) return json(res, { error: 'לא נמצא' }, 404);
  if (u.role === 'admin') return json(res, { error: 'לא ניתן לשנות הרשאות של משתמש הנהלה' }, 400);
  if (Array.isArray(body?.tabs)) u.tabs = body.tabs.filter(t => VALID_TABS.includes(t));
  if (Array.isArray(body?.companies)) u.companies = body.companies.filter(Boolean);
  if (body?.password) { if (String(body.password).length < 6) return json(res, { error: 'סיסמה קצרה מדי' }, 400); const { salt, hash } = hashPassword(String(body.password)); u.salt = salt; u.hash = hash; }
  save(db);
  json(res, { ok: true, user: publicUser(u) });
});

// DELETE /api/users/:id — מחיקת משתמש צפייה (מנהל בלבד)
add('DELETE', /^\/api\/users\/([^/]+)$/, (req, res, params) => {
  const db = load();
  const u = (db.users || []).find(x => x.id === params[0]);
  if (!u) return json(res, { error: 'לא נמצא' }, 404);
  if (u.role === 'admin') return json(res, { error: 'לא ניתן למחוק משתמש הנהלה' }, 400);
  db.users = (db.users || []).filter(x => x.id !== params[0]);
  // מחיקת סשנים של המשתמש
  for (const [t, s] of Object.entries(db.sessions || {})) if (s && s.userId === params[0]) delete db.sessions[t];
  save(db);
  json(res, { ok: true });
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
  db.companies = COMPANY_SEED.map(c => ({ ...c }));
  save(db);
  console.log('נזרעו החברות (בלי אירוע דוגמה)');
}

// שלוש החברות + ספק חשבונאי לכל אחת. חשבונית ירוקה מחוברת ל-BPM בלבד; אופק=פייפרלס (טרם מחובר); משה=טרם.
const COMPANY_SEED = [
  { id: 'co_bpm', name: 'בי פי אם הגברה ותאורה בע"מ', active: true, accounting: 'greenInvoice' },
  { id: 'co_ofek', name: 'אופק ידעי הגברה ותאורה', active: false, accounting: 'paperless' },
  { id: 'co_moshe', name: 'משה כורסיה בע"מ', active: false, accounting: null },
];
// מזהה החברה שאליה מחוברת חשבונית ירוקה (ברירת מחדל BPM) — לשם בידוד נתונים
function giCompanyId() { const c = (load().companies || []).find(x => x.accounting === 'greenInvoice'); return c ? c.id : 'co_bpm'; }
// תשובה ריקה לכל endpoint שנשען על חשבונית ירוקה — עבור חברות שאינן חברת ה-GI (אופק/משה)
function giEmptyFor(pathname) {
  if (pathname === '/api/dashboard') return { income: 0, vat: 0, openInvoices: 0, openInvoicesSum: 0, monthDocs: 0, docs: [], clients: [], errors: {} };
  if (pathname === '/api/clients' || pathname === '/api/suppliers') return [];
  if (pathname === '/api/open-invoices' || pathname === '/api/open-quotes') return { docs: [] };
  if (pathname === '/api/expense-drafts') return { drafts: [] };
  if (pathname === '/api/expenses/quick-search' || pathname === '/api/documents/quick-search') return { items: [] };
  if (/^\/api\/(clients|suppliers)\/[^/]+\/documents$/.test(pathname)) return [];
  // יומן גוגל (המחובר ל-BPM) — לחברות אחרות ריק עד שיחוברו יומנים משלהן
  if (pathname === '/api/calendar/match') return { matched: [], missingInCalendar: [], missingInWhatsappCount: 0 };
  if (pathname === '/api/calendar/events') return { whatsapp: [], calendar: [] };
  return undefined;
}

// מיגרציות חד-פעמיות בעליית השרת
function runMigrations() {
  const db = load();
  let changed = false;
  // הסרת חשבון ההתחברות 'iris' שנוצר בטעות (איריס היא סוכנת בצוות, לא משתמשת אנושית)
  const before = (db.users || []).length;
  db.users = (db.users || []).filter(u => !(u.username === 'iris' && u.role === 'viewer'));
  if (db.users.length !== before) {
    // ניקוי סשנים של המשתמש שהוסר
    for (const [t, s] of Object.entries(db.sessions || {})) {
      if (s && !(db.users || []).some(u => u.id === s.userId)) delete db.sessions[t];
    }
    changed = true;
    console.log('מיגרציה: הוסר חשבון ההתחברות iris (מיותר — איריס היא סוכנת)');
  }
  // ודא ששלוש החברות קיימות ושלכל אחת מוגדר ספק חשבונאי (accounting)
  db.companies = db.companies || [];
  for (const seed of COMPANY_SEED) {
    let c = db.companies.find(x => x.id === seed.id);
    if (!c) { c = { id: seed.id, name: seed.name, active: seed.active }; db.companies.push(c); changed = true; console.log('מיגרציה: נוספה חברה ' + seed.name); }
    if (c.accounting !== seed.accounting) { c.accounting = seed.accounting; changed = true; }
  }
  if (changed) save(db);
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
    // ---- שכבת הרשאות ----
    const authDb = load();
    const anyAdmin = (authDb.users || []).some(u => u.role === 'admin');
    const authUser = getSessionUser(authDb, req);
    const isPublicAuth = (url.pathname === '/api/auth/status')
      || (url.pathname === '/api/auth/login' && req.method === 'POST')
      || (url.pathname === '/api/auth/setup' && req.method === 'POST');
    const isLogout = url.pathname === '/api/auth/logout';
    const isUsersRoute = /^\/api\/users(\/|$)/.test(url.pathname);
    if (!isPublicAuth) {
      if (!anyAdmin) return json(res, { error: 'setup_required' }, 401);
      if (!authUser) return json(res, { error: 'unauthorized' }, 401);
      // ניהול משתמשים — מנהל בלבד
      if (isUsersRoute && authUser.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
      // משתמש צפייה — קריאה בלבד + הגבלת עסקים
      if (authUser.role !== 'admin' && !isLogout) {
        if (req.method !== 'GET') return json(res, { error: 'אין הרשאה לפעולה זו (צפייה בלבד)' }, 403);
        const comp = q.companyId || null;
        if (comp && Array.isArray(authUser.companies) && !authUser.companies.includes(comp)) {
          return json(res, { error: 'אין הרשאה לעסק זה' }, 403);
        }
      }
    }
    req.user = authUser;
    // בידוד חברות: נתוני חשבונית ירוקה שייכים לחברת ה-GI בלבד (BPM). לחברות אחרות מחזירים ריק.
    if (req.method === 'GET' && q.companyId && q.companyId !== giCompanyId()) {
      const empty = giEmptyFor(url.pathname);
      if (empty !== undefined) return json(res, empty);
    }
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

server.listen(PORT, async () => {
  await initStore();          // מחבר ל-Postgres (Neon) לפני שמתחילים לקרוא/לכתוב נתונים
  seedIfEmpty();
  runMigrations();
  autoVerifyConnections();
  console.log(`מערכת BPM רצה על http://localhost:${PORT}`);
  startWhatsappBridge(async (text) => { try { await ingestText(text); } catch {} })
    .then(r => { if (r && !r.ok) console.log('ווטסאפ:', r.reason); });
});
