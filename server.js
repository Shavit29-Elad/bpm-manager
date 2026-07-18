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
import { parseBank } from './bankParser.js';
import { matchCredits, attachReceipts } from './bankMatch.js';
import { startWhatsappBridge, getBridgeStatus } from './whatsappBridge.js';
import { saveSettings, statusMasked, loadEnvIntoProcess } from './settings.js';
import { DEFS as CONN_DEFS, getRecords, setRecord, clearRecord } from './connections.js';
import { listTeam, findMember, TEAM } from './team.js';
import { chatWithMember, chatGroupReply, chatConfigured, learnFromExchange, summarizeAsRequest, extractEvents, interpretBonuses } from './chat.js';

loadEnvIntoProcess(); // טוען מפתחות מ-.env אם קיים

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = __dirname; // בגרסה השטוחה קובצי הממשק יושבים באותה תיקייה
// רק קבצים אלה מוגשים לדפדפן — כדי לא לחשוף קוד מקור או את קובץ הסודות .env
const STATIC_ALLOW = new Set(['index.html', 'styles.css', 'app.js']);
const PORT = process.env.PORT || 3000;

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
  const created = list.map(parsed => {
    const ctrDetails = (parsed.contractorDetails && parsed.contractorDetails.length)
      ? parsed.contractorDetails
      : (parsed.contractors || []).map(name => ({ name, amount: null }));
    const event = {
      id: id('ev'), companyId: cid,
      ...parsed,
      client: parsed.artist, clientName: null, clientId: null,
      priceSound: parsed.priceSound ?? null, priceExtras: parsed.priceExtras ?? null,
      invoiceStatus: 'pending',
      createdAt: new Date().toISOString(),
      employeeDetails: (parsed.employeeDetails && parsed.employeeDetails.length)
        ? parsed.employeeDetails
        : (parsed.employees || []).map(name => ({ name, rate: null, bonus: null })),
      contractorDetails: ctrDetails,
    };
    upsertEvent(db, event);
    return event;
  });
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

// GET /api/companies
add('GET', /^\/api\/companies$/, (req, res) => json(res, load().companies));

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

// POST /api/events  — יצירה ידנית או "אימוץ" אירוע מיומן גוגל לרשומה שניתן לערוך
add('POST', /^\/api\/events$/, (req, res, _p, _q, body) => {
  const db = load();
  const b = body || {};
  const companyId = b.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  // מניעת כפילות: אם כבר אומץ אירוע יומן זה — מחזירים אותו
  if (b.gcalId) {
    const exist = db.events.find(e => e.gcalId === b.gcalId && e.companyId === companyId);
    if (exist) return json(res, exist);
  }
  const event = {
    id: id('ev'), companyId,
    date: b.date || null, dateRaw: b.date || null,
    artist: b.artist || b.title || null,
    location: b.location || null,
    sound: b.sound || null,
    price: b.price ?? null, priceSound: b.priceSound ?? null, priceExtras: b.priceExtras ?? null,
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
        .map(e => ({ gcalId: e.id, date: e.date, title: e.title, location: e.location, source: 'calendar' }));
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
add('POST', /^\/api\/invoicing\/preview$/, (req, res, _p, _q, body) => {
  const db = load();
  const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(Boolean);
  const items = invoiceItemsFromEvents(evs);
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  json(res, { items, subtotal, vat: +(subtotal * 0.18).toFixed(2), total: +(subtotal * 1.18).toFixed(2), subject: subjectForEvents(evs) });
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
      dueDate: [300, 305].includes(type) ? (body.dueDate || null) : null,
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

// GET /api/open-quotes — הצעות מחיר פתוחות
add('GET', /^\/api\/open-quotes$/, async (req, res) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try { json(res, { docs: await greenInvoice.openQuotes() }); }
  catch (e) { json(res, { docs: [], error: e.message }, 500); }
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

    // סיווג חשבונאי — מהטיוטה, מהבקשה, או מברירת המחדל של הספק
    let classId = body.accountingClassificationId || draft.accountingClassificationId || null;
    if (!classId) {
      try { const sup = await greenInvoice.getSupplier(supplierId); classId = sup?.accountingClassificationId || sup?.accountingClassification?.id || null; } catch { }
    }
    if (!classId) return json(res, { error: 'לספק אין סיווג הוצאה מוגדר בחשבונית ירוקה. הגדר לו "סיווג חשבונאי" בכרטיס הספק ונסה שוב.' }, 400);

    const total = Number(body.amount != null ? body.amount : draft.amount) || 0;
    if (total <= 0) return json(res, { error: 'סכום לא תקין' }, 400);
    const net = body.vatIncluded === false ? total : +(total / 1.18).toFixed(2);
    const vat = body.vatIncluded === false ? +(total * 0.18).toFixed(2) : +(total - net).toFixed(2);
    const amount = body.vatIncluded === false ? +(total + vat).toFixed(2) : total;
    const date = body.date || draft.date || new Date().toISOString().slice(0, 10);
    const number = String(body.number || draft.number || '').trim();
    if (!number) return json(res, { error: 'חסר מספר חשבונית של הספק' }, 400);

    const expBody = {
      supplier: { id: supplierId },
      documentType: Number(body.documentType || draft.documentType) || 305,
      number,
      date, reportingDate: date,
      currency: 'ILS', paymentType: 4,
      amount, amountExcludeVat: net, vat,
      accountingClassification: { id: classId },
      description: (body.description || draft.description || '').trim() || 'הוצאת ספק',
    };
    const created = await greenInvoice.createExpense(expBody);

    // ננסה למחוק את הטיוטה במורנינג; אם לא נתמך — נסמן אצלנו כמאושרת כדי שלא תופיע שוב
    let draftRemoved = false;
    try { await greenInvoice.deleteExpenseDraft(draftId); draftRemoved = true; } catch { }
    const db = load();
    db.approvedDrafts = db.approvedDrafts || {};
    db.approvedDrafts[draftId] = { expenseId: created?.id || null, at: new Date().toISOString() };
    save(db);

    json(res, { ok: true, expense: created, draftRemoved });
  } catch (e) { json(res, { error: e.message }, 500); }
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

// POST /api/documents/:id/derive { type, linked } — מסמך המשך (מקושר) או שכפול (חופשי) ממסמך קיים
// linked=true → מסמך המשך מקושר למקור. linked=false → שכפול שאפשר לבחור לו כל סוג.
add('POST', /^\/api\/documents\/([^/]+)\/derive$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const type = Number(body.type);
    if (!type) return json(res, { error: 'חסר סוג מסמך' }, 400);
    const items = (src.income || []).map(it => ({
      catalogNum: it.catalogNum || undefined, description: it.description,
      quantity: it.quantity ?? 1, price: it.price ?? 0,
    }));
    if (!items.length) return json(res, { error: 'אין שורות במסמך המקור' }, 400);
    const opts = {
      type,
      client: src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' },
      items, description: src.description || '', remarks: src.remarks || null,
    };
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
      ev.contractorDetails[it.index].paid = paid;
      ev.contractorDetails[it.index].paidInvoice = paid ? (body.invoiceNumber || null) : null;
      n++;
    }
  }
  save(db); json(res, { ok: true, updated: n });
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
// GET /api/files/:id — הגשת הקובץ (צפייה/הורדה)
add('GET', /^\/api\/files\/([^/]+)$/, async (req, res, params) => {
  const f = await getFile(params[0]);
  if (!f) return json(res, { error: 'קובץ לא נמצא' }, 404);
  const buf = Buffer.from(f.data || '', 'base64');
  res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(f.filename || 'file')}"`, 'Content-Length': buf.length });
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

// ---- בנק: ייבוא תנועות + התאמה לחשבוניות הכנסה ----
function ddmmyyyyToISO(d) { const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; }
function shiftISODays(iso, days) { const d = new Date(iso); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function bankSig(t) { return `${t.date}|${t.absAmount}|${t.reference || ''}|${(t.description || '').slice(0, 20)}`; }

// POST /api/bank/import  { text, companyId }
add('POST', /^\/api\/bank\/import$/, async (req, res, _p, _q, body) => {
  const text = body?.text || '';
  const companyId = body?.companyId || null;
  const parsed = parseBank(text);
  if (!parsed.length) return json(res, { ok: true, added: 0, total: 0, message: 'לא זוהו תנועות בטקסט' });
  // טווח תאריכים לשליפת חשבוניות
  let invoices = [], receipts = [];
  const iso = parsed.map(t => ddmmyyyyToISO(t.date)).filter(Boolean).sort();
  if (greenInvoice.haveCredentials() && iso.length) {
    const from = shiftISODays(iso[0], -75), to = shiftISODays(iso[iso.length - 1], 5);
    try { const inc = await greenInvoice.incomeForRange(from, to); invoices = inc.docs || []; } catch (e) { /* נמשיך בלי התאמה */ }
    try { receipts = await greenInvoice.receiptsForRange(from, to); } catch (e) { /* קבלות אופציונליות */ }
  }
  const matched = attachReceipts(matchCredits(parsed, invoices), receipts);
  const db = load();
  db.bankTx = db.bankTx || [];
  const existing = new Set(db.bankTx.filter(t => !companyId || t.companyId === companyId).map(t => t.sig));
  let added = 0;
  for (const t of matched) {
    const sig = bankSig(t);
    if (existing.has(sig)) continue;
    db.bankTx.push({
      id: id('btx'), companyId, sig,
      date: t.date, description: t.description, amount: t.amount, absAmount: t.absAmount,
      direction: t.direction, reference: t.reference, invoiceNumber: t.invoiceNumber,
      nameHint: t.nameHint, memo: t.memo,
      matchStatus: t.matchStatus, matchedInvoices: t.matchedInvoices || [], suggestions: t.suggestions || [],
      importedAt: new Date().toISOString(),
    });
    existing.add(sig); added++;
  }
  save(db);
  const credits = matched.filter(t => t.direction === 'credit');
  json(res, { ok: true, added, total: parsed.length, credits: credits.length, autoMatched: credits.filter(t => t.matchStatus === 'auto').length, invoicesLoaded: invoices.length });
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

server.listen(PORT, async () => {
  await initStore();          // מחבר ל-Postgres (Neon) לפני שמתחילים לקרוא/לכתוב נתונים
  seedIfEmpty();
  autoVerifyConnections();
  console.log(`מערכת BPM רצה על http://localhost:${PORT}`);
  startWhatsappBridge(async (text) => { try { await ingestText(text); } catch {} })
    .then(r => { if (r && !r.ok) console.log('ווטסאפ:', r.reason); });
});
