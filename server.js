// server.js
// שרת המערכת: מגיש את הממשק (public/) וחושף REST API.
// ללא תלויות חיצוניות — רץ עם `node server.js` בלבד (Node 18+). הגשר לווטסאפ אופציונלי.

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { init as initStore, load, save, id, upsertEvent, companyEvents, saveFile, getFile, deleteFile } from './store.js';
import { parseEventMessage, parseEventMessages } from './whatsappParser.js';
import { matchEvents, fetchCalendarEvents, verify as calendarVerify, hasCalendar, calendarCompanies, setDbIcal } from './googleCalendar.js';
import { contractorPayables, eventsByClient, invoiceItemsFromEvents, subjectForEvents, eventTotal } from './invoicing.js';
import { employeePayForMonth } from './payroll.js';
import greenInvoice from './greenInvoice.js';
import { parseBank, extractAccountBalance } from './bankParser.js';
import { matchCredits, matchDebits, attachReceipts, nameMatch } from './bankMatch.js';
import { startWhatsappBridge, getBridgeStatus } from './whatsappBridge.js';
import { statusMasked, loadEnvIntoProcess } from './settings.js';
import { chatConfigured, extractEvents, interpretBonuses, extractInvoiceFields, extractIncomeDocFields, classifyExpenseAttachment, aiUsage } from './chat.js';
import { buildBackup, backupFileName, runBackupMail, planRetention } from './backup.js';
import { buildReport, reportHtml, monthClosed, daysSince, DEFAULT_OVERDUE_DAYS } from './dailyReport.js';
import mailer from './mailer.js';
import mailReader from './mailReader.js';
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
function mappedClientName(db, artist, companyId) {
  const a = normName(artist);
  if (!a) return null;
  // מיפוי פר-חברה (רשומות ישנות ללא companyId שייכות ל-BPM)
  const map = (db.artistClientMap || []).filter(m => (m.companyId || 'co_bpm') === (companyId || 'co_bpm'));
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
  const isOfek = cid === 'co_ofek';
  const created = [];
  for (const parsed of list) {
    // אצל אופק "קבלן" = הלקוח שמשלם (לא ספק/הוצאה). לכן כשאין "איש קשר" והקבלן מולא — הוא הופך ללקוח,
    // ולא יוצרים ממנו שורת ספק. בשאר החברות קבלן נשאר ספק/הוצאה כרגיל.
    const contractorIsClient = isOfek && !parsed.contact && Array.isArray(parsed.contractors) && parsed.contractors.length > 0;
    const ctrDetails = contractorIsClient ? []
      : (parsed.contractorDetails && parsed.contractorDetails.length)
        ? parsed.contractorDetails
        : (parsed.contractors || []).map(name => ({ name, amount: null }));
    // ---- קביעת הלקוח לחיוב: איש קשר > קבלן(אופק) > מיפוי אמן ----
    // כל מקור עובר קודם דרך מיפוי הכינוי→שם-מלא (למשל "הפרויקט"→"סינגולד בע״מ"), ואם אין מיפוי — הערך עצמו.
    let clientName = null, clientId = null;
    const clientSrc = parsed.contact || (contractorIsClient ? parsed.contractors[0] : null);
    if (clientSrc) {
      const full = mappedClientName(db, clientSrc, cid) || clientSrc;
      const r = await resolveCached(full);
      clientName = r.clientName; clientId = r.clientId;
    } else {
      const mapped = mappedClientName(db, parsed.artist, cid);
      if (mapped) { const r = await resolveCached(mapped); clientName = r.clientName; clientId = r.clientId; }
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
// שגיאת חשבונית ירוקה "לא ניתן לסגור מסמך שאינו פתוח" (errorCode 2400) — המסמך כבר סגור/הומר, אין צורך לסגור שוב
const isAlreadyClosedErr = (e) => /2400|שאינו פתוח/.test(String((e && e.message) || e || ''));

// ---- בידוד חברות: שני עוזרים שכל ראוט שנוגע בנתוני חברה חייב לעבור דרכם ----
// החברה של הבקשה: מה-query, מגוף הבקשה, ואם אין — חברת ברירת המחדל. לעולם לא "כל החברות".
const reqCompany = (q, body) => (q && q.companyId) || (body && body.companyId) || giCompanyId();
// האם רשומה שייכת לחברה. רשומה ישנה ללא companyId שייכת לחברת ברירת המחדל (מוסכמה קיימת).
const ownedBy = (rec, cid) => Boolean(rec) && (rec.companyId || giCompanyId()) === cid;
// תשובת 403 אחידה לניסיון גישה לרשומה של חברה אחרת
// ניסוח נטול מגדר: הפונקציה מקבלת גם שמות בזכר (האירוע, הרכב, הכלל) וגם בנקבה
// (ההוצאה, התנועה), ו"שייכת" הקבוע הפך את ההודעה לשגויה ברוב הקריאות.
const wrongCompany = (res, what = 'הרשומה') => json(res, { error: `אין הרשאה — ${what} מחברה אחרת` }, 403);

// GET /api/companies — משתמש צפייה רואה רק את העסקים שהורשה אליהם
add('GET', /^\/api\/companies$/, (req, res) => {
  const all = load().companies || [];
  const u = req.user;
  if (u && u.role !== 'admin' && Array.isArray(u.companies)) return json(res, all.filter(c => u.companies.includes(c.id)));
  json(res, all);
});

// GET /api/events?companyId=
add('GET', /^\/api\/events$/, async (req, res, _p, q) => {
  const db = load();
  const cid = q.companyId || giCompanyId();
  const events = companyEvents(db, cid);
  // סטטוס התשלום מהלקוח מחושב כאן ולא בפרונט. לשונית האירועים הסתמכה רק על סוגי
  // המסמכים המקושרים לאירוע, ולכן אירוע שכבר שולם — בהתאמת בנק, או בקבלה שהופקה
  // ישירות בחשבונית ירוקה וסגרה את החשבונית — נשאר "ממתין לתשלום" לנצח.
  // אותה פונקציה בדיוק משרתת את מסך "קבלנים לתשלום", כך שאין שני מקורות אמת.
  // שדה נפרד מ-clientPaid: זה כבר קיים על אירוע שמור כדגל בוליאני, ואסור לדרוס אותו.
  const bankPaid = buildBankPaidMap(db, cid);
  let openNums = null;
  try {
    if (giEnabled(cid) && greenInvoice.haveCredentials()) {
      const open = await greenInvoice.openDocuments();
      openNums = new Set((open || []).map(d => String(d.number)));
    }
  } catch { openNums = null; }
  // אירוע שנשאר על חשבון עסקה שהומרה בחשבונית ירוקה: משלימים את חשבונית המס
  // שנגזרה ממנו, כדי שהיא תוצג לצד הקבלה שלה ושהסטטוס ייקבע לפיה. ההשלמה היא
  // לתצוגה בלבד — linkedDocs אינו נשלח בחזרה בשמירת אירוע, ולכן שום נתון לא משתנה.
  const gi = giEnabled(cid) && greenInvoice.haveCredentials();
  // רשימת מסמכי ההכנסה של החברה, נטענת פעם אחת ומגיעה מהמטמון של חשבונית ירוקה.
  // ממנה נמצא מסמך המשך של חשבון עסקה בלי קריאה נפרדת לכל אירוע.
  let income = [];
  if (gi && events.some(e => (e.linkedDocs || []).some(d => Number(d && d.type) === 300))) {
    const dates = events.map(e => String(e.date || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (dates.length) {
      const from = shiftISODays(dates[0], -30), to = shiftISODays(dates[dates.length - 1], 120);
      try { const r = await greenInvoice.incomeForRange(from, to); income = (r && r.docs) || []; } catch { income = []; }
    }
  }
  const work = load();
  const chainBefore = JSON.stringify(work.docChain || {});
  let chainBudget = 5;
  const out = [];
  for (const e of events) {
    let docs = Array.isArray(e.linkedDocs) ? e.linkedDocs : [];
    const active = docs.filter(d => d && !d.credited && !d.credit && !d.converted);
    const stuckOnProforma = active.length > 0 && active.every(d => Number(d.type) === 300);
    if (gi && stuckOnProforma) {
      const p = active[0];
      if (p.id && !/^(exp_|pay_)/.test(String(p.id))) {
        const hit = chainCached(work, cid, p.id);
        let derived = hit ? hit.doc : null;
        if (!hit && chainBudget > 0) {
          chainBudget--;
          derived = await resolveConvertedInvoice(work, cid, { ...p, clientName: p.clientName || e.clientName }, income);
        }
        if (derived) {
          docs = docs.map(d => String(d.id) === String(p.id) ? { ...d, converted: true } : d)
            .concat([{ ...derived, derived: true }]);
        }
      }
    }
    const ev = { ...e, linkedDocs: docs };
    ev.clientPayStatus = eventClientPaid(ev, bankPaid, openNums);
    out.push(ev);
  }
  if (JSON.stringify(work.docChain || {}) !== chainBefore) {
    const db2 = load(); db2.docChain = work.docChain; save(db2);
  }
  json(res, out.sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});

// POST /api/events/ingest
add('POST', /^\/api\/events\/ingest$/, async (req, res, _p, _q, body) => {
  if (!body?.text) return json(res, { error: 'חסר טקסט' }, 400);
  try { json(res, await ingestText(body.text, body.companyId)); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// ---- מיפוי זמר → לקוח ברירת-מחדל (צפייה/עריכה) ----
// GET /api/artist-map — כל המיפויים
add('GET', /^\/api\/artist-map$/, (req, res, _p, q) => json(res, (load().artistClientMap || []).filter(m => (m.companyId || 'co_bpm') === (q.companyId || 'co_bpm'))));
// POST /api/artist-map — הוספה/עדכון { artist, clientName } (פר-חברה)
add('POST', /^\/api\/artist-map$/, (req, res, _p, q, body) => {
  const db = load();
  const artist = String(body?.artist || '').trim();
  const clientName = String(body?.clientName || '').trim();
  const cid = q.companyId || 'co_bpm';
  if (!artist || !clientName) return json(res, { error: 'חסר זמר או שם לקוח' }, 400);
  db.artistClientMap = db.artistClientMap || [];
  const i = db.artistClientMap.findIndex(m => (m.companyId || 'co_bpm') === cid && normName(m.artist) === normName(artist));
  if (i >= 0) db.artistClientMap[i].clientName = clientName;
  else db.artistClientMap.push({ artist, clientName, companyId: cid });
  save(db); json(res, { ok: true, map: db.artistClientMap.filter(m => (m.companyId || 'co_bpm') === cid) });
});
// DELETE /api/artist-map/:artist — הסרת מיפוי
add('DELETE', /^\/api\/artist-map\/(.+)$/, (req, res, params, q) => {
  const db = load();
  const cid = q.companyId || 'co_bpm';
  const target = normName(decodeURIComponent(params[0]));
  // בידוד: מוחקים רק את המיפוי של החברה הנוכחית, ומחזירים רק את המיפויים שלה
  db.artistClientMap = (db.artistClientMap || []).filter(m => !((m.companyId || 'co_bpm') === cid && normName(m.artist) === target));
  save(db); json(res, { ok: true, map: db.artistClientMap.filter(m => (m.companyId || 'co_bpm') === cid) });
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

// POST /api/events/:id/duplicate — שכפול אירוע כאירוע חדש "לאישור" (למשל חיוב לשני לקוחות שונים על אותו אירוע)
// העותק נקי מכל שיוך חשבונית/מסמכים כדי שאפשר יהיה להפיק לו חשבונית עצמאית ללקוח אחר.
add('POST', /^\/api\/events\/([^/]+)\/duplicate$/, (req, res, params, _q, body) => {
  const db = load();
  const src = db.events.find(e => e.id === params[0]);
  if (!src) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if (!ownedBy(src, reqCompany(_q, body))) return wrongCompany(res, 'האירוע');
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = id('ev');
  copy.confirmed = false;              // ילך ל"אירועים לאישור"
  copy.invoiceStatus = 'pending';
  delete copy.invoiceId; delete copy.invoiceNumber; delete copy.invoiceType;
  copy.linkedDocs = [];                // ללא מסמכים משויכים — חיוב עצמאי
  delete copy.clientPaid;
  copy.gcalId = null;                  // לא קשור לאירוע יומן (שכפול ידני)
  copy.source = 'duplicate';
  copy.createdAt = new Date().toISOString();
  // אם נשלח לקוח אחר לשכפול — נשתמש בו (לתרחיש "אותו אירוע, לקוח אחר")
  if (body && (body.clientId || body.clientName)) { copy.clientId = body.clientId || null; copy.clientName = body.clientName || null; }
  db.events.push(copy); save(db); json(res, copy);
});

// GET /api/events/:id — אירוע בודד
add('GET', /^\/api\/events\/([^/]+)$/, (req, res, params, q) => {
  const ev = load().events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if ((ev.companyId || 'co_bpm') !== (q.companyId || giCompanyId())) return json(res, { error: 'האירוע שייך לחברה אחרת' }, 403); // בידוד
  json(res, ev);
});

// PUT /api/events/:id
add('PUT', /^\/api\/events\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if ((ev.companyId || 'co_bpm') !== ((_q && _q.companyId) || (body && body.companyId) || giCompanyId())) return json(res, { error: 'האירוע שייך לחברה אחרת' }, 403); // בידוד
  const b = { ...(body || {}) };
  delete b.id; delete b.companyId; delete b.createdAt;   // שדות מוגנים — עריכה לא מזיזה אירוע בין חברות ולא משנה מזהה
  Object.assign(ev, b); save(db); json(res, ev);
});

// DELETE /api/events/:id — מוחק רק מרשימת האירועים שלנו (לא מיומן גוגל)
add('DELETE', /^\/api\/events\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if ((ev.companyId || 'co_bpm') !== (q.companyId || giCompanyId())) return json(res, { error: 'האירוע שייך לחברה אחרת' }, 403); // בידוד
  // אם האירוע הגיע מיומן גוגל — נרשום את מזהה-היומן ברשימת "מודחקים", כדי שרענון/אימוץ יומי לא יקלוט אותו שוב.
  if (ev.gcalId && ev.companyId) {
    db.calendarDismissed = db.calendarDismissed || {};
    const arr = db.calendarDismissed[ev.companyId] = db.calendarDismissed[ev.companyId] || [];
    if (!arr.includes(ev.gcalId)) arr.push(ev.gcalId);
  }
  db.events = db.events.filter(e => e.id !== params[0]);
  save(db); json(res, { ok: true });
});

// מתאריך זה והלאה מתבצעות ההתאמות מול היומן (לפני כן לא רלוונטי)
const MATCH_START = process.env.MATCH_START_DATE || '2026-07-01';
// GET /api/calendar/match?companyId=
add('GET', /^\/api\/calendar\/match$/, async (req, res, _p, q) => {
  const db = load();
  const allWa = companyEvents(db, q.companyId || giCompanyId());
  const waEvents = allWa.filter(e => (e.date || '') >= MATCH_START); // רק מיולי 2026 והלאה
  try {
    const dates = waEvents.map(e => e.date).filter(Boolean).sort();
    const timeMin = dates[0] ? `${dates[0]}T00:00:00Z` : undefined;
    const timeMax = dates.length ? `${dates[dates.length - 1]}T23:59:59Z` : undefined;
    const cal = (await fetchCalendarEvents({ companyId: q.companyId })).filter(e => (e.date || '') >= MATCH_START);
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

// --- זיהוי "אירוע יומן שכבר נקלט" לפי תאריך + שם האמן של אירוע מאושר ---
// אותה הופעה מופיעה לעיתים בשני יומני גוגל (עובדים + הגברה ותאורה) בניסוח שונה. אם כבר יש אירוע
// מאושר באותו תאריך ששם האמן שלו מופיע בכותרת/מיקום של אירוע היומן — לא קולטים אותו שוב לאישור.
// נרמול פונטי עברי — סובלני לשגיאות כתיב נפוצות: ט↔ת, ק↔כ, אותיות גרוניות/שקטות א/ע/ה מתחלפות,
// ואימות קריאה ו/י שנשמטות (למשל "שאולב" מול "שאולוב", "טרין" מול "תרין"). כך מקשרים אירועים חרף טעויות.
function _normHe(s) {
  return String(s || '').toLowerCase()
    .replace(/[֑-ׇ]/g, '')                                             // ניקוד/טעמים
    .replace(/["'’`׳״().,\-\/|]/g, ' ')
    .replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ף/g, 'פ').replace(/ץ/g, 'צ') // סופיות
    .replace(/ט/g, 'ת').replace(/ק/g, 'כ')                                       // ט=ת · ק=כ
    .replace(/[אעה]/g, '')                                                       // א/ע/ה — גרוניות/שקטות מתחלפות
    .replace(/[וי]/g, '')                                                        // ו/י אימות קריאה שנשמטות
    .replace(/\s+/g, ' ').trim();
}
function _artistCoreWords(a) { return _normHe(a).split(' ').filter(w => w.length > 1).slice(0, 2); }
// אינדקס: לכל תאריך — רשימת "ליבות שם אמן" של אירועים מאושרים (מילים משמעותיות)
function confirmedArtistIndex(db, cid) {
  const idx = {};
  for (const e of (db.events || [])) {
    if (e.companyId !== cid || !e.confirmed) continue;
    const words = _artistCoreWords(e.artist);
    if (words.length) (idx[e.date] = idx[e.date] || []).push(words);
  }
  return idx;
}
// האם אירוע יומן ce כבר מיוצג ע״י אירוע מאושר (אותו תאריך + כל מילות ליבת-האמן מופיעות בכותרת/מיקום)
function calendarAlreadyCaptured(idx, ce) {
  const list = idx[ce.date]; if (!list) return false;
  const hay = _normHe(ce.title) + ' ' + _normHe(ce.location);
  return list.some(words => words.every(w => hay.includes(w)));
}

// ניקוי כפילויות אירועי יומן: אירועים שנקלטו יותר מפעם אחת עבור אותו אירוע גוגל (gcalId) — מאחדים לאחד.
// שומרים את ה"עשיר" ביותר (עם חשבונית/מסמכים/מחירים/עובדים), וממזגים אליו שדות ריקים מהכפילים לפני מחיקתם.
function dedupeCalendarEventsByGcal(db, cid) {
  const richness = (e) => {
    let s = 0;
    if (e.invoiceStatus && e.invoiceStatus !== 'pending') s += 100;
    if (Array.isArray(e.linkedDocs) && e.linkedDocs.length) s += 60;
    if (e.invoiceId || e.invoiceNumber) s += 40;
    if (Array.isArray(e.contractorDetails) && e.contractorDetails.length) s += 20;
    if (Array.isArray(e.employeeDetails) && e.employeeDetails.length) s += 20;
    for (const k of ['price', 'priceSound', 'priceLighting', 'priceBackline', 'priceExtras', 'ledMeters']) if (Number(e[k])) s += 5;
    if (e.clientId) s += 3; if (e.location) s += 1;
    return s;
  };
  const fillEmpty = (win, lose) => {
    for (const k of ['location', 'clientId', 'clientName', 'price', 'priceSound', 'priceLighting', 'priceBackline', 'priceExtras', 'ledMeters', 'ledPricePerMeter', 'employeeBonusRaw']) {
      if ((win[k] == null || win[k] === '' || win[k] === 0) && lose[k] != null && lose[k] !== '' && lose[k] !== 0) win[k] = lose[k];
    }
    for (const k of ['linkedDocs', 'contractorDetails', 'employeeDetails', 'employees', 'contractors']) {
      if ((!Array.isArray(win[k]) || !win[k].length) && Array.isArray(lose[k]) && lose[k].length) win[k] = lose[k];
    }
  };
  const seen = new Map(); const remove = new Set();
  for (const e of db.events) {
    if (!e.gcalId) continue;
    if (cid && e.companyId !== cid) continue;
    const key = (e.companyId || '') + '|' + e.gcalId;
    const cur = seen.get(key);
    if (!cur) { seen.set(key, e); continue; }
    const win = richness(e) > richness(cur) ? e : richness(e) < richness(cur) ? cur : (String(cur.createdAt || '') <= String(e.createdAt || '') ? cur : e);
    const lose = win === e ? cur : e;
    fillEmpty(win, lose); remove.add(lose.id); seen.set(key, win);
  }
  if (remove.size) db.events = db.events.filter(e => !remove.has(e.id));
  return remove.size;
}

// POST /api/calendar/dedupe { companyId } — ניקוי ידני של כפילויות אירועי יומן (אותו gcalId)
add('POST', /^\/api\/calendar\/dedupe$/, (req, res, _p, q, body) => {
  const db = load();
  const cid = (body && body.companyId) || q.companyId || null;
  const removed = dedupeCalendarEventsByGcal(db, cid);
  if (removed) save(db);
  json(res, { ok: true, removed });
});

// POST /api/calendar/auto-adopt { companyId } — הוספה אוטומטית של אירועי יומן גוגל לרשימת "אירועים לאישור".
// מוסיף אירועים עד היום (כולל) — כך שבבוקר כבר נקלטים אירועי אותו יום. לא קולט אירועים עתידיים (מעבר להיום).
// רץ פעם ביום לכל חברה (שעון ישראל). מוסיף רק אירועי יומן שאין להם התאמה לאירוע קיים (מונע כפילויות מול קליטת ווטסאפ).
add('POST', /^\/api\/calendar\/auto-adopt$/, async (req, res, _p, q, body) => {
  const db = load();
  const cid = (body && body.companyId) || q.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  // ניקוי כפילויות אירועי יומן (אותו gcalId) בכל ריצה — מתקן גם כפילויות ישנות שנוצרו ממרוץ אימוץ.
  const dedupRemoved = dedupeCalendarEventsByGcal(db, cid);
  if (dedupRemoved) save(db);
  const todayIL = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); // YYYY-MM-DD בשעון ישראל
  db.calendarAutoAdopt = db.calendarAutoAdopt || {};
  const force = q.force === '1' || (body && body.force); // רענון ידני יזום — מדלג על מנגנון "פעם ביום"
  if (!force && db.calendarAutoAdopt[cid] === todayIL) return json(res, { ok: true, adopted: 0, skipped: true, today: todayIL, dedupRemoved });
  if (!hasCalendar(cid)) { db.calendarAutoAdopt[cid] = todayIL; save(db); return json(res, { ok: true, adopted: 0, noCalendar: true }); }
  try {
    const ourEvents = (db.events || []).filter(e => e.companyId === cid && (e.date || '') >= MATCH_START);
    const adoptedGcal = new Set(ourEvents.map(e => e.gcalId).filter(Boolean));
    const confIdx = confirmedArtistIndex(db, cid); // אירועים מאושרים לפי תאריך+שם אמן — למניעת קליטה כפולה
    const dismissed = new Set(((db.calendarDismissed || {})[cid]) || []); // אירועי יומן שנמחקו ידנית — לא לקלוט שוב
    // עד היום (כולל) — קולט את אירועי היום כבר בבוקר; לא מעבר להיום (בלי אירועים עתידיים).
    const cal = (await fetchCalendarEvents({ companyId: cid }))
      .filter(e => e.id && (e.date || '') >= MATCH_START && (e.date || '') <= todayIL
        && !adoptedGcal.has(e.id) && !dismissed.has(e.id) && !calendarAlreadyCaptured(confIdx, e));
    // רק אירועי יומן שאין להם התאמה לאירוע קיים אצלנו (missingInWhatsapp)
    const { missingInWhatsapp } = matchEvents(ourEvents, cal);
    let adopted = 0;
    for (const ce of missingInWhatsapp) {
      if (!ce.id || adoptedGcal.has(ce.id) || dismissed.has(ce.id) || calendarAlreadyCaptured(confIdx, ce)) continue;
      let clientId = null, clientName = null;
      const mapped = mappedClientName(db, ce.title);
      if (mapped) { const r = await resolveClientByName(mapped); clientId = r.clientId; clientName = r.clientName; }
      const event = {
        id: id('ev'), companyId: cid,
        date: ce.date || null, dateRaw: ce.date || null,
        artist: ce.title || null, location: ce.location || null,
        sound: null, price: null, priceSound: null, priceLighting: null, priceBackline: null, priceExtras: null,
        ledPricePerMeter: null, ledMeters: null,
        employees: [], employeeBonusRaw: null, contractors: [], employeeDetails: [], contractorDetails: [],
        clientId, clientName,
        gcalId: ce.id, source: 'calendar', invoiceStatus: 'pending',
        autoAdopted: true, createdAt: new Date().toISOString(),
      };
      upsertEvent(db, event); adoptedGcal.add(ce.id); adopted++;
    }
    db.calendarAutoAdopt[cid] = todayIL;
    save(db);
    json(res, { ok: true, adopted, today: todayIL });
  } catch (e) {
    json(res, { ok: false, error: e.message });
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
  const dbEvents = (companyEvents(db, q.companyId || giCompanyId()));
  const adoptedGcal = new Set(dbEvents.map(e => e.gcalId).filter(Boolean));
  // מפענח את מזהה היומן מתוך gcalId בפורמט 'c<index>_...' — כך שאירוע שאומץ מיומן נצבע לפי היומן שלו.
  const calIdxOf = (gcalId) => { const m = String(gcalId || '').match(/^c(\d+)_/); return m ? +m[1] : null; };
  let cal = [];
  let calendarError = null;
  const calNames = new Map();   // index -> שם היומן (מכל היומנים המוגדרים, גם אם כל האירועים כבר אומצו)
  try {
    if (hasCalendar(q.companyId)) {
      const raw = await fetchCalendarEvents({ companyId: q.companyId });
      raw.forEach(e => calNames.set(e.calendarIndex ?? 0, e.calendarName || `יומן ${(e.calendarIndex ?? 0) + 1}`));
      cal = raw
        .filter(e => inRange(e.date))   // כל אירועי היומן — לוח השנה הוא שיקוף מלא של יומני גוגל (כולל אירועים שכבר אומצו)
        .map(e => ({ gcalId: e.id, date: e.date, title: e.title, location: e.location, source: 'calendar', calendarIndex: e.calendarIndex ?? 0, calendarName: e.calendarName || `יומן ${(e.calendarIndex ?? 0) + 1}` }));
    } else { calendarError = 'יומן גוגל לא מחובר'; }
  } catch (e) { calendarError = e.message; }
  // האירועים שלנו — נצבעים לפי היומן שממנו אומצו (calendarIndex מתוך gcalId). אירוע ללא שיוך ליומן = 'manual'.
  const wa = dbEvents
    .filter(e => inRange(e.date))
    .map(e => { const idx = calIdxOf(e.gcalId);
      return { eventId: e.id, date: e.date, title: e.artist || 'אירוע', location: e.location || '',
        clientName: e.clientName || null, price: e.price ?? null,
        calendarIndex: idx, calendarName: idx != null ? (calNames.get(idx) || `יומן ${idx + 1}`) : null,
        source: idx != null ? 'calendar' : 'manual' }; });
  const calendars = [...calNames.keys()].sort((a, b) => a - b).map(index => ({ index, name: calNames.get(index) }));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ from: q.from, to: q.to, whatsapp: wa, calendar: cal, calendars, calendarError }));
});

// GET /api/invoicing/clients?companyId= — כל האירועים מקובצים לפי לקוח (עם סימון מחויבים)
add('GET', /^\/api\/invoicing\/clients$/, (req, res, _p, q) =>
  json(res, eventsByClient(companyEvents(load(), q.companyId))));

// POST /api/invoicing/preview — { eventIds } → שורות ברירת מחדל + נושא + סכומים (בלי ליצור מסמך)
add('POST', /^\/api\/invoicing\/preview$/, async (req, res, _p, _q, body) => {
  const db = load();
  const _cid = reqCompany(_q, body);
  const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(e => ownedBy(e, _cid));
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
  // הצעת מחיר מקושרת לאחד האירועים — להצגה בצד ימין של חלון ההפקה
  let linkedQuote = null;
  try {
    for (const e of evs) {
      const qd = (e.linkedDocs || []).find(d => Number(d.type) === 10);
      if (!qd) continue;
      let url = qd.url || null;
      if (!url && qd.id && greenInvoice.haveCredentials()) {
        try { const doc = await greenInvoice.getDocument(qd.id); url = (doc.url && (doc.url.he || doc.url.origin || doc.url.pdf)) || null; } catch { }
      }
      linkedQuote = { id: qd.id, number: qd.number || null, url };
      break;
    }
  } catch { }
  json(res, { items, subtotal, vat: +(subtotal * 0.18).toFixed(2), total: +(subtotal * 1.18).toFixed(2), subject: subjectForEvents(evs), clientEmail, linkedQuote });
});

// POST /api/invoicing/preview-pdf — תצוגה מקדימה מעוצבת של המסמך (לפני הפקה), מחזיר PDF ב-base64
add('POST', /^\/api\/invoicing\/preview-pdf$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const db = load();
    const _cid = reqCompany(_q, body);
    const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(e => ownedBy(e, _cid));
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
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = { amount: Number(body.discount.amount), type: body.discount.type };
    if (body.skipDateValidation) opts.skipDateValidation = true; // אישור הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)
    // חשבונית ירוקה מאפשרת תאריך עבר, אך לא מוקדם מהמסמך האחרון מסוגו (רצף) — אם נדחה, מרנדרים עם התאריך המותר הקרוב.
    let pv, dateAdjusted = false; const requestedDate = opts.date || null; let usedDate = opts.date || null; let minDate = null;
    try { pv = await greenInvoice.previewDocument(opts); }
    catch (e) {
      if (!opts.skipDateValidation && /2405|עתידי|מוקדם|תאריך|\bdate\b/i.test(String(e.message || ''))) {
        const today = new Date().toISOString().slice(0, 10);
        try { minDate = await greenInvoice.latestDocumentDate(type); } catch { /* לא חוסם */ }
        const fallback = (minDate && (!requestedDate || minDate > requestedDate)) ? minDate : today;
        dateAdjusted = Boolean(requestedDate && requestedDate !== fallback);
        usedDate = fallback; opts.date = fallback;
        pv = await greenInvoice.previewDocument(opts);
      } else throw e;
    }
    let pdfBase64 = pv.pdfBase64 || null;
    if (!pdfBase64 && pv.url) {
      const fr = await fetch(pv.url, { redirect: 'follow' }).catch(() => null);
      if (fr && fr.ok) pdfBase64 = Buffer.from(await fr.arrayBuffer()).toString('base64');
    }
    if (!pdfBase64) return json(res, { error: 'לא התקבלה תצוגה מקדימה', debug: pv.raw || null });
    json(res, { ok: true, pdfBase64, dateAdjusted, requestedDate, usedDate, minDate });
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
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = { amount: Number(body.discount.amount), type: body.discount.type };
    if (body.skipDateValidation) opts.skipDateValidation = true; // אישור הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum); // צ'ק
        // פרטי חשבון המשלם (העברה בנקאית / צ'ק): בנק, סניף, חשבון — חשבונית ירוקה מחייבת זאת לתקבול צ'ק (שגיאה 2443)
        if ([2, 4].includes(Number(p.type))) {
          if (p.bankName) row.bankName = String(p.bankName).replace(/\s*\(\d+\)\s*$/, '').trim(); // מנקים "(קוד)" מהשם
          if (p.bankBranch) row.bankBranch = String(p.bankBranch);
          if (p.bankAccount) row.bankAccount = String(p.bankAccount);
        }
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    // התצוגה המקדימה היא ויזואלית בלבד. אם חשבונית ירוקה דוחה את התאריך (עתידי/מוקדם מדי לסוג המסמך — שגיאה 2405,
    // למשל מסמך המשך שתאריכו מוקדם מהמסמך האחרון) — מנסים שוב עם תאריך היום כדי שהתצוגה תרונדר. התאריך האמיתי נבחר בהפקה.
    // חשבונית ירוקה מאפשרת תאריך עבר, אך לא מוקדם מהמסמך האחרון *מאותו סוג* (רצף כרונולוגי — שגיאה 2405).
    // אם התאריך שנבחר מוקדם מדי, מרנדרים את התצוגה עם התאריך המוקדם ביותר המותר = תאריך המסמך האחרון מסוגו (לא "היום").
    let pv, dateAdjusted = false; const requestedDate = opts.date || null; let usedDate = opts.date || null; let minDate = null;
    try { pv = await greenInvoice.previewDocument(opts); }
    catch (e) {
      if (/2405|עתידי|מוקדם|תאריך|\bdate\b/i.test(String(e.message || ''))) {
        const today = new Date().toISOString().slice(0, 10);
        try { minDate = await greenInvoice.latestDocumentDate(type); } catch { /* לא חוסם */ }
        const fallback = (minDate && (!requestedDate || minDate > requestedDate)) ? minDate : today;
        dateAdjusted = Boolean(requestedDate && requestedDate !== fallback);
        usedDate = fallback; opts.date = fallback;
        if (Array.isArray(opts.payment)) opts.payment = opts.payment.map(p => ({ ...p, date: (!p.date || p.date < fallback) ? fallback : p.date }));
        pv = await greenInvoice.previewDocument(opts);
      } else throw e;
    }
    let pdfBase64 = pv.pdfBase64 || null;
    if (!pdfBase64 && pv.url) { const fr = await fetch(pv.url, { redirect: 'follow' }).catch(() => null); if (fr && fr.ok) pdfBase64 = Buffer.from(await fr.arrayBuffer()).toString('base64'); }
    if (!pdfBase64) return json(res, { error: 'לא התקבלה תצוגה מקדימה', debug: pv.raw || null });
    json(res, { ok: true, pdfBase64, dateAdjusted, requestedDate, usedDate, minDate });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/invoicing/generate — יוצר מסמך בחשבונית ירוקה ומסמן את האירועים כמחויבים
add('POST', /^\/api\/invoicing\/generate$/, async (req, res, _p, _q, body) => {
  const db = load();
  const _cid = reqCompany(_q, body);
  // בידוד: מפיקים ומסמנים אך ורק אירועים של החברה הפעילה (המסמך נוצר בחשבונית ירוקה שלה)
  const evs = (body.eventIds || []).map(id => db.events.find(e => e.id === id)).filter(e => ownedBy(e, _cid));
  const items = (body.items && body.items.length) ? body.items : invoiceItemsFromEvents(evs);
  const type = Number(body.type) || greenInvoice.DOC_TYPES.INVOICE;
  const subtotal = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  if (!items.length) return json(res, { error: 'אין שורות לחיוב' }, 400);
  if (!(subtotal > 0)) return json(res, { error: 'סכום החיוב חייב להיות גדול מ-0' }, 400);
  // מניעת חיוב כפול: אירועים שכבר חויבו לא יופקו שוב אלא באישור מפורש (allowReinvoice)
  const already = evs.filter(e => e.invoiceStatus === 'invoiced');
  if (already.length && !body.allowReinvoice) {
    const nums = already.map(e => e.invoiceNumber || '').filter(Boolean).join(', ') || '—';
    return json(res, { error: `חלק מהאירועים כבר חויבו (מסמך ${nums}). כדי להפיק חשבונית נוספת לאותם אירועים — אשר במפורש.`, alreadyInvoiced: already.map(e => ({ id: e.id, invoiceNumber: e.invoiceNumber })) }, 409);
  }
  if (!greenInvoice.haveCredentials()) {
    return json(res, { error: 'חסרים מפתחות חשבונית ירוקה — הוסף אותם כדי להפיק בפועל',
      preview: { type, items, subtotal, subject: subjectForEvents(evs) } }, 400);
  }
  try {
    const client = body.clientId ? { id: body.clientId } : { name: body.clientName || 'לקוח' };
    const doc = await createDocFwd({
      type, client, items,
      description: body.description || subjectForEvents(evs),
      remarks: body.remarks || null,
      date: body.date || undefined,   // תאריך המסמך שהמשתמש בחר (ברירת מחדל: היום)
      skipDateValidation: Boolean(body.skipDateValidation), // הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)
      sendEmail: Boolean(body.sendEmail), email: body.email || null,
      discount: (body.discount && Number(body.discount.amount) > 0) ? body.discount : undefined, // הנחה (סכום/אחוז) — כבר מומרת ל-net ע"י הצד לקוח
    });
    for (const ev of evs) {
      const e = db.events.find(x => x.id === ev.id);
      if (e) {
        e.invoiceStatus = 'invoiced'; e.invoiceId = doc.id; e.invoiceNumber = doc.number; e.invoiceType = type;
        // חשוב: להוסיף את המסמך שהופק ל-linkedDocs של האירוע — אחרת עמודת החיוב מציגה רק את המסמכים הקיימים (למשל הצעת המחיר)
        // ולא את חשבונית העסקה/המס שזה עתה הופקה. כך המסמך החדש מוצג ומאפשר צפייה/מסמך המשך ישירות מהאירוע.
        const ld = Array.isArray(e.linkedDocs) ? e.linkedDocs : [];
        if (!ld.some(d => String(d.id) === String(doc.id))) ld.push({ id: doc.id, number: doc.number, type, uploaded: false });
        e.linkedDocs = ld.slice(0, 12);
      }
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

// GET /api/invoicing/linkable-docs?clientId=&clientName=&excludeEventId=&companyId=
// מסמכים של הלקוח הנבחר בלבד (הצעת מחיר/עסקה/מס/מס-קבלה/זיכוי) שלא משוייכים לאף אירוע אחר — לשיוך לאירוע.
add('GET', /^\/api\/invoicing\/linkable-docs$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { docs: [], error: 'חשבונית ירוקה לא מחוברת' });
  try {
    let clientId = q.clientId || null;
    const name = (q.clientName || '').trim();
    if (!clientId && name) {
      const clients = await greenInvoice.listClients();
      // התאמה סלחנית: שם עסק לעיתים נשמר חתוך/עם בע"מ/מרכאות שונות. מנסים מדויק ואז מנורמל ואז תת-מחרוזת.
      const norm = (s) => String(s || '').replace(/בע["'׳״]?\s*מ\.?/g, '').replace(/[."'׳״,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const nn = norm(name);
      let c = clients.find(cl => (cl.name || '').trim() === name);            // מדויק
      if (!c) c = clients.find(cl => norm(cl.name) === nn);                    // מנורמל מדויק
      if (!c && nn.length >= 4) {                                             // תת-מחרוזת (שם חתוך)
        const cand = clients.filter(cl => { const cn = norm(cl.name); return cn && (cn.includes(nn) || nn.includes(cn)); });
        if (cand.length === 1) c = cand[0];
        else if (cand.length > 1) c = cand.sort((a, b) => Math.abs(norm(a.name).length - nn.length) - Math.abs(norm(b.name).length - nn.length))[0];
      }
      clientId = c?.id || null;
    }
    if (!clientId) return json(res, { docs: [] });
    const all = await greenInvoice.clientDocuments(clientId);   // כבר של הלקוח בלבד
    const types = [10, 300, 305, 320, 330]; // הצעת מחיר, עסקה, מס, מס-קבלה, זיכוי
    // מיפוי מסמך → שמות האירועים שכבר משוייך אליהם (מלבד האירוע הנוכחי)
    const db = load();
    const excludeId = q.excludeEventId || null;
    const evs = q.companyId ? companyEvents(db, q.companyId) : (db.events || []);
    const evLabel = (e) => e.artist || e.title || e.clientName || e.date || e.id;
    const linkedMap = new Map(); // docId → Set(labels)
    const addLink = (docId, lbl) => { const k = String(docId); if (!linkedMap.has(k)) linkedMap.set(k, new Set()); linkedMap.get(k).add(lbl); };
    for (const e of evs) {
      if (excludeId && e.id === excludeId) continue;
      const lbl = evLabel(e);
      for (const d of (e.linkedDocs || [])) if (d && d.id != null) addLink(d.id, lbl);
      if (e.invoiceId != null) addLink(e.invoiceId, lbl);
    }
    const includeClosed = q.includeClosed === '1' || q.includeClosed === 'true';
    const includeLinked = q.includeLinked === '1' || q.includeLinked === 'true';
    let pool = all.filter(d => types.includes(Number(d.type)));
    // כמה מסמכים משוייכים כבר לאירוע אחר (לשם הצגת/הסתרת האפשרות)
    const linkedCount0 = pool.filter(d => linkedMap.has(String(d.id))).length;
    if (!includeLinked) pool = pool.filter(d => !linkedMap.has(String(d.id)));
    // הוספת שמות האירועים שהמסמך כבר משויך אליהם (לתצוגה)
    pool = pool.map(d => { const s = linkedMap.get(String(d.id)); return s ? { ...d, linkedTo: [...s] } : d; });
    // ברירת מחדל: רק מסמכים בסטטוס פתוח (status 0). "הצג סגורים" → כולל גם סגורים.
    const openOnly = pool.filter(d => Number(d.status) === 0);
    let docs = (includeClosed ? pool : openOnly)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 60);
    const closedCount = pool.length - openOnly.length;
    // ── גם מסמכים ישנים שהועלו ידנית (אינם בחשבונית ירוקה) — ניתנים לשיוך, וגם לכמה אירועים ──
    const normU = (s) => String(s || '').replace(/בע["'׳״]?\s*מ\.?/g, '').replace(/[."'׳״,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const wantN = normU(name);
    const cliMatchU = (nm) => { const a = normU(nm); return !!a && (!wantN || a === wantN || a.includes(wantN) || wantN.includes(a)); };
    const upByKey = new Map();
    const addUp = (d, lbl) => {
      if (!d || !d.uploaded || ![10, 300, 305, 320, 330].includes(Number(d.type))) return;
      const key = (d.number || d.id) + '|' + Number(d.type);
      if (!upByKey.has(key)) upByKey.set(key, { doc: { id: d.id, number: d.number || null, type: Number(d.type), date: d.date || null, amount: d.amount != null ? Number(d.amount) : null, amountDue: d.amount != null ? Number(d.amount) : null, url: d.url || ('/api/files/' + d.id), status: 0, uploaded: true }, labels: new Set() });
      if (lbl) upByKey.get(key).labels.add(lbl);
    };
    for (const e of evs) {
      if (!cliMatchU(e.clientName || e.client || '')) continue;
      const lbl = evLabel(e);
      for (const d of (e.linkedDocs || [])) if (d && d.uploaded) addUp(d, (excludeId && e.id === excludeId) ? null : lbl);
    }
    for (const rec of (db.oldInvoices || [])) {
      if (!cliMatchU(rec.clientName || '')) continue;
      for (const d of (rec.linkedDocs || [])) if (d && d.uploaded) addUp(d, null);
    }
    let upList = [...upByKey.values()].map(v => ({ ...v.doc, linkedTo: [...v.labels] }));
    const upLinked = upList.filter(x => x.linkedTo.length).length;
    if (!includeLinked) upList = upList.filter(x => !x.linkedTo.length);
    docs = docs.concat(upList).slice(0, 80);
    json(res, { docs, clientId, closedCount, linkedCount: linkedCount0 + upLinked });
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
  const _cid = reqCompany(_q, body);
  docs = docs.slice(0, 4).map(d => {
    const o = { id: d.id, number: d.number || null, type: Number(d.type) || null };
    // מסמך ישן שהועלה ידנית (אינו בחשבונית ירוקה) — שומרים url/uploaded/date/amount כדי שיוצג ויורד וייחשב כחיוב פתוח
    if (d.uploaded) { o.uploaded = true; if (d.url) o.url = d.url; if (d.date) o.date = d.date; if (d.amount != null) o.amount = Number(d.amount); }
    return o;
  });
  let n = 0;
  for (const id of ids) {
    const e = db.events.find(x => x.id === id);
    if (!e || !ownedBy(e, _cid)) continue;   // בידוד
    // צירוף המסמכים החדשים לקיימים (בלי כפילויות) — מאפשר לשייך עוד מסמכים בהמשך
    const merged = Array.isArray(e.linkedDocs) ? e.linkedDocs.slice() : [];
    for (const d of docs) if (!merged.some(x => String(x.id) === String(d.id))) merged.push(d);
    e.linkedDocs = merged.slice(0, 6);
    // הצעת מחיר (10) אינה חיוב: קושרת מסמך אך אינה מסמנת "חויב"/"שולם".
    // רק חשבונית אמיתית (עסקה 300 / מס 305 / מס-קבלה 320 / קבלה 400) מחייבת את האירוע.
    const REAL = [300, 305, 320, 400];
    const realDocs = e.linkedDocs.filter(d => REAL.includes(Number(d.type)));
    if (realDocs.length) {
      e.invoiceStatus = 'invoiced';
      // מסמך ראשי לתצוגה מבין החשבוניות האמיתיות: מס > מס-קבלה > עסקה > קבלה
      let primary = realDocs[0];
      for (const t of [305, 320, 300, 400]) { const d = realDocs.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
      e.invoiceId = primary.id; e.invoiceNumber = primary.number; e.invoiceType = primary.type;
    }
    n++;
  }
  save(db);
  json(res, { ok: true, linked: n, docs: docs.length });
});

// POST /api/events/:id/attach-doc — צירוף קובץ מסמך חיצוני (חשבונית ישנה ממערכת קודמת) לאירוע קיים.
// { type, number, date, amount, filename, mime, data(base64) }. עסקה/מס → פתוח עד קבלה/מס-קבלה.
add('POST', /^\/api\/events\/([^/]+)\/attach-doc$/, async (req, res, params, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if (!ownedBy(ev, reqCompany(_q, body))) return wrongCompany(res, 'האירוע');
  if (!body || !body.data) return json(res, { error: 'חסר קובץ' }, 400);
  const type = Number(body.type) || null;
  const saved = await saveFile({ employeeId: 'evdoc:' + ev.id, kind: 'event-doc', filename: body.filename || 'document', mime: body.mime || 'application/octet-stream', data: body.data });
  const doc = { id: saved.id, number: (body.number != null && String(body.number).trim() !== '') ? String(body.number).trim() : null, type, date: body.date || null, amount: (body.amount != null && body.amount !== '') ? Number(body.amount) : null, url: '/api/files/' + saved.id, uploaded: true };
  const merged = Array.isArray(ev.linkedDocs) ? ev.linkedDocs.slice() : [];
  merged.push(doc);
  ev.linkedDocs = merged.slice(0, 8);
  // עדכון סטטוס לפי חשבוניות אמיתיות (זהה ללוגיקת /api/invoicing/link) — הצעת מחיר אינה חיוב
  const REAL = [300, 305, 320, 400];
  const realDocs = ev.linkedDocs.filter(d => REAL.includes(Number(d.type)));
  if (realDocs.length) {
    ev.invoiceStatus = 'invoiced';
    let primary = realDocs[0];
    for (const t of [305, 320, 300, 400]) { const d = realDocs.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
    ev.invoiceId = primary.id; ev.invoiceNumber = primary.number; ev.invoiceType = primary.type;
  }
  save(db);
  json(res, { ok: true, doc });
});

// מחשב מחדש את סטטוס החיוב של אירוע לפי המסמכים שנותרו עליו. הלוגיקה הזו שוכפלה
// בשלושה מקומות; מרוכזת כאן כדי שניתוק שיוך, מחיקת קובץ וזיכוי יתנהגו זהה.
function recomputeEventInvoiceStatus(ev) {
  const REAL = [300, 305, 320, 400];
  const active = (ev.linkedDocs || []).filter(d => REAL.includes(Number(d.type)) && !d.converted && !d.credited && !d.credit);
  if (active.length) {
    ev.invoiceStatus = 'invoiced';
    let primary = active[0];
    for (const t of [305, 320, 300, 400]) { const d = active.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
    ev.invoiceId = primary.id; ev.invoiceNumber = primary.number; ev.invoiceType = primary.type;
  } else {
    ev.invoiceStatus = 'pending'; ev.invoiceId = null; ev.invoiceNumber = null; ev.invoiceType = null;
    delete ev.clientPaid;   // אין חיוב פעיל — האירוע חוזר להיות פתוח להפקה
  }
}
// ניתוק מסמך מאירוע. לא נוגע במסמך עצמו בחשבונית ירוקה — רק מסיר את הקישור ומחזיר
// את האירוע ל"ממתין לחיוב" אם לא נשאר עליו חיוב פעיל.
function unlinkDocFromEvent(ev, docId) {
  const before = (ev.linkedDocs || []).length;
  ev.linkedDocs = (ev.linkedDocs || []).filter(d => String(d.id) !== String(docId));
  if (String(ev.invoiceId || '') === String(docId)) { ev.invoiceId = null; ev.invoiceNumber = null; ev.invoiceType = null; }
  recomputeEventInvoiceStatus(ev);
  return before !== ev.linkedDocs.length || true;
}

// DELETE /api/events/:id/unlink-doc/:docId — ניתוק שיוך של מסמך מאירוע (המסמך עצמו נשאר בחשבונית ירוקה)
add('DELETE', /^\/api\/events\/([^/]+)\/unlink-doc\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const ev = (db.events || []).find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if (!ownedBy(ev, reqCompany(q))) return wrongCompany(res, 'האירוע');
  unlinkDocFromEvent(ev, params[1]);
  save(db);
  json(res, { ok: true, invoiceStatus: ev.invoiceStatus, linkedDocs: ev.linkedDocs || [] });
});

// POST /api/documents/:id/unlink-events { eventIds? } — ניתוק המסמך מכמה אירועים בבת אחת.
// משמש בסגירת חשבון עסקה: המסמך נסגר, והאירועים שהיו מקושרים אליו חוזרים ל"ממתין לחיוב".
add('POST', /^\/api\/documents\/([^/]+)\/unlink-events$/, (req, res, params, q, body) => {
  const db = load();
  const cid = reqCompany(q, body);
  const only = Array.isArray(body && body.eventIds) && body.eventIds.length ? new Set(body.eventIds.map(String)) : null;
  const out = [];
  for (const ev of (db.events || [])) {
    if (!ownedBy(ev, cid)) continue;
    const refs = (ev.linkedDocs || []).some(d => String(d.id) === String(params[0])) || String(ev.invoiceId || '') === String(params[0]);
    if (!refs) continue;
    if (only && !only.has(String(ev.id))) continue;
    unlinkDocFromEvent(ev, params[0]);
    out.push({ id: ev.id, date: ev.date || null, artist: ev.artist || ev.title || '' });
  }
  if (out.length) save(db);
  json(res, { ok: true, unlinked: out });
});

// DELETE /api/events/:id/attach-doc/:docId — הסרת מסמך שהועלה מאירוע + עדכון סטטוס
add('DELETE', /^\/api\/events\/([^/]+)\/attach-doc\/([^/]+)$/, async (req, res, params, q) => {
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if (!ownedBy(ev, reqCompany(q))) return wrongCompany(res, 'האירוע');
  ev.linkedDocs = (ev.linkedDocs || []).filter(d => String(d.id) !== String(params[1]));
  try { await deleteFile(params[1]); } catch {}
  const REAL = [300, 305, 320, 400];
  const realDocs = (ev.linkedDocs || []).filter(d => REAL.includes(Number(d.type)));
  if (realDocs.length) {
    ev.invoiceStatus = 'invoiced';
    let primary = realDocs[0];
    for (const t of [305, 320, 300, 400]) { const d = realDocs.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
    ev.invoiceId = primary.id; ev.invoiceNumber = primary.number; ev.invoiceType = primary.type;
  } else { ev.invoiceStatus = 'pending'; ev.invoiceId = null; ev.invoiceNumber = null; ev.invoiceType = null; }
  save(db);
  json(res, { ok: true });
});

// POST /api/events/:id/create-followup — הפקת מסמך המשך בחשבונית ירוקה ממסמך ישן שהועלה, לפי אותם כללי המשך.
// { uploadedDocId, type, items, date, description, remarks, payment, skipDateValidation, clientName }
add('POST', /^\/api\/events\/([^/]+)\/create-followup$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const db = load();
  const ev = db.events.find(e => e.id === params[0]);
  if (!ev) return json(res, { error: 'אירוע לא נמצא' }, 404);
  if (!ownedBy(ev, reqCompany(_q, body))) return wrongCompany(res, 'האירוע');
  try {
    const type = Number(body.type);
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }))
      .filter(it => it.description);
    if (!type || !items.length) return json(res, { error: 'חסרים נתונים למסמך' }, 400);
    const client = ev.clientId ? { id: ev.clientId } : { name: String(body.clientName || ev.clientName || ev.client || 'לקוח').trim(), add: true };
    const opts = { type, client, items, description: body.description || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = body.discount; // הנחה (סכום/אחוז) — כבר מומרת ל-net
    if (body.skipDateValidation) opts.skipDateValidation = true;
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    const doc = await createDocFwd(opts);
    // קישור המסמך החדש (חשבונית ירוקה) לאירוע + סימון המסמך הישן שממנו נגזר כ"הומר" (יורד מחשבוניות פתוחות)
    const merged = Array.isArray(ev.linkedDocs) ? ev.linkedDocs.slice() : [];
    merged.push({ id: doc.id, number: doc.number, type, uploaded: false });
    if (body.uploadedDocId) { const s = merged.find(d => String(d.id) === String(body.uploadedDocId)); if (s) s.converted = true; }
    ev.linkedDocs = merged.slice(0, 10);
    const REAL = [300, 305, 320, 400];
    const realDocs = ev.linkedDocs.filter(d => REAL.includes(Number(d.type)) && !d.converted);
    if (realDocs.length) {
      ev.invoiceStatus = 'invoiced';
      let primary = realDocs[0];
      for (const t of [305, 320, 300, 400]) { const d = realDocs.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
      ev.invoiceId = primary.id; ev.invoiceNumber = primary.number; ev.invoiceType = primary.type;
    }
    save(db);
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// ===== חשבוניות ישנות שהועלו ידנית (אופק) — עומדות בפני עצמן (לא קשורות לאירוע), למעקב ב"חשבוניות פתוחות" =====
// POST /api/old-invoices — יצירה + צירוף קובץ. { type, number, date, amount, clientName, description, filename, mime, data }
add('POST', /^\/api\/old-invoices$/, async (req, res, _p, q, body) => {
  if (!body || !body.data) return json(res, { error: 'חסר קובץ' }, 400);
  const cid = q.companyId || body.companyId;
  const db = load(); db.oldInvoices = db.oldInvoices || [];
  const type = Number(body.type) || null;
  const numStr = (body.number != null && String(body.number).trim() !== '') ? String(body.number).trim() : null;
  // מניעת כפילות (אך ורק לחשבוניות ישנות של אופק): אותו קובץ, או אותו מספר+סוג מסמך, לא ייקלטו פעמיים
  const contentHash = crypto.createHash('sha256').update(String(body.data || '')).digest('hex');
  const dupMatch = (d) => (d.contentHash && d.contentHash === contentHash) ||
    (numStr && d.number && String(d.number) === numStr && Number(d.type || 0) === Number(type || 0));
  const dupe = (db.oldInvoices || []).find(r => r.companyId === cid && (r.linkedDocs || []).some(dupMatch));
  if (dupe) {
    // מחזירים גם את המסמך הקיים כדי שהצד לקוח יוכל לשייך אותו אוטומטית לתנועת הבנק
    const existingDoc = (dupe.linkedDocs || []).find(dupMatch) || null;
    return json(res, { error: 'המסמך הזה כבר קיים בחשבוניות פתוחות (אותו קובץ או אותו מספר מסמך) — לא נקלט שוב.', duplicate: true, existingDoc, clientName: dupe.clientName || '', oldInvoiceId: dupe.id }, 409);
  }
  const saved = await saveFile({ employeeId: 'oldinv', kind: 'old-invoice', filename: body.filename || 'document', mime: body.mime || 'application/octet-stream', data: body.data });
  const doc = { id: saved.id, number: numStr, type, date: body.date || null, amount: (body.amount != null && body.amount !== '') ? Number(body.amount) : null, url: '/api/files/' + saved.id, uploaded: true, contentHash };
  const rec = { id: id('oinv'), companyId: cid, clientName: String(body.clientName || '').trim() || '—', description: String(body.description || '').trim(), linkedDocs: [doc], createdAt: new Date().toISOString() };
  db.oldInvoices.push(rec);
  save(db);
  json(res, { ok: true, id: rec.id, doc });
});
// POST /api/old-invoices/:id/attach-doc — צירוף קבלה/מס-קבלה (או מסמך נוסף) לחשבונית ישנה
add('POST', /^\/api\/old-invoices\/([^/]+)\/attach-doc$/, async (req, res, params, _q, body) => {
  const db = load(); db.oldInvoices = db.oldInvoices || [];
  const rec = db.oldInvoices.find(r => r.id === params[0]);
  if (!rec) return json(res, { error: 'לא נמצא' }, 404);
  const _cid = (_q && _q.companyId) || (body && body.companyId) || giCompanyId();
  if (rec.companyId && rec.companyId !== _cid) return json(res, { error: 'המסמך שייך לחברה אחרת' }, 403); // בידוד
  if (!body || !body.data) return json(res, { error: 'חסר קובץ' }, 400);
  const type = Number(body.type) || null;
  const saved = await saveFile({ employeeId: 'oldinv', kind: 'old-invoice', filename: body.filename || 'document', mime: body.mime || 'application/octet-stream', data: body.data });
  rec.linkedDocs = (rec.linkedDocs || []).concat([{ id: saved.id, number: (body.number != null && String(body.number).trim() !== '') ? String(body.number).trim() : null, type, date: body.date || null, amount: (body.amount != null && body.amount !== '') ? Number(body.amount) : null, url: '/api/files/' + saved.id, uploaded: true }]).slice(0, 8);
  save(db);
  json(res, { ok: true });
});
// DELETE /api/old-invoices/:id — מחיקה + קבצים
add('DELETE', /^\/api\/old-invoices\/([^/]+)$/, async (req, res, params, q) => {
  const db = load(); db.oldInvoices = db.oldInvoices || [];
  const rec = db.oldInvoices.find(r => r.id === params[0]);
  if (rec && !ownedBy(rec, reqCompany(q))) return wrongCompany(res, 'החשבונית');
  if (rec) { for (const d of (rec.linkedDocs || [])) { try { await deleteFile(d.id); } catch {} } }
  db.oldInvoices = db.oldInvoices.filter(r => r.id !== params[0]);
  save(db);
  json(res, { ok: true });
});
// POST /api/old-invoices/:id/create-followup — הפקת מסמך המשך בחשבונית ירוקה מחשבונית ישנה
add('POST', /^\/api\/old-invoices\/([^/]+)\/create-followup$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const db = load(); db.oldInvoices = db.oldInvoices || [];
  const rec = db.oldInvoices.find(r => r.id === params[0]);
  if (!rec) return json(res, { error: 'לא נמצא' }, 404);
  try {
    const type = Number(body.type);
    const items = (Array.isArray(body.items) ? body.items : []).map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description);
    if (!type || !items.length) return json(res, { error: 'חסרים נתונים למסמך' }, 400);
    const client = rec.clientId ? { id: rec.clientId } : { name: String(body.clientName || rec.clientName || 'לקוח').trim(), add: true };
    const opts = { type, client, items, description: body.description || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = body.discount; // הנחה (סכום/אחוז) — כבר מומרת ל-net
    if (body.skipDateValidation) opts.skipDateValidation = true;
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => { const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' }; if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum); if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName); return row; }).filter(p => Math.abs(p.price) > 0);
    }
    const doc = await createDocFwd(opts);
    const merged = (rec.linkedDocs || []).slice();
    merged.push({ id: doc.id, number: doc.number, type, uploaded: false });
    if (body.uploadedDocId) { const s = merged.find(d => String(d.id) === String(body.uploadedDocId)); if (s) s.converted = true; }
    rec.linkedDocs = merged.slice(0, 10);
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

// POST /api/quotes/create { clientId?, clientName?, items, date?, subject?, remarks?, sendEmail?, email? } — הצעת מחיר חדשה
add('POST', /^\/api\/quotes\/create$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(it => ({ description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }))
      .filter(it => it.description);
    if (!items.length) return json(res, { error: 'אין שורות בהצעת המחיר' }, 400);
    const _qtotal = items.reduce((s, it) => s + it.price * it.quantity, 0);
    if (!(_qtotal > 0)) return json(res, { error: 'סכום הצעת המחיר חייב להיות גדול מ-0' }, 400);
    const client = body.clientId ? { id: body.clientId } : { name: String(body.clientName || 'לקוח').trim(), add: true };
    const opts = { type: 10, client, items, description: body.subject || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = body.discount; // הנחה (סכום/אחוז) — כבר מומרת ל-net
    if (body.skipDateValidation) opts.skipDateValidation = true; // הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)
    if (body.sendEmail && body.email) { opts.sendEmail = true; opts.email = String(body.email).trim(); }
    const doc = await createDocFwd(opts);
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
    const _dtotal = items.reduce((s, it) => s + it.price * it.quantity, 0);
    if (!isFinite(_dtotal) || _dtotal === 0) return json(res, { error: 'סכום המסמך אינו תקין (0)' }, 400);
    const client = body.clientId ? { id: body.clientId } : { name: String(body.clientName || 'לקוח').trim(), add: true };
    const opts = { type, client, items, description: body.subject || body.description || '', remarks: body.remarks || null };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = body.discount; // הנחה (סכום/אחוז) — כבר מומרת ל-net
    if (body.skipDateValidation) opts.skipDateValidation = true; // הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    const doc = await createDocFwd(opts);
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
    catch (e) { if (isAlreadyClosedErr(e)) results.push({ id, ok: true, alreadyClosed: true }); else results.push({ id, ok: false, error: e.message }); }
  }
  json(res, { ok: true, closed: results.filter(r => r.ok).length, results });
});

// POST /api/expenses/upload-file — העלאת קובץ הוצאה (חשבונית ספק) לחשבונית ירוקה כטיוטת OCR
// body: { fileBase64, fileName, mime }
add('POST', /^\/api\/expenses\/upload-file$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.fileBase64) return json(res, { error: 'חסר קובץ' }, 400);
  try { json(res, await greenInvoice.uploadExpenseFile(body.fileBase64, body.fileName, body.mime)); }
  catch (e) { console.error('upload-file failed:', body.fileName, e.message); json(res, { error: e.message }, 500); }
});

// GET /api/expense-drafts — טיוטות הוצאה שהעלינו (OCR) שממתינות לאישור, ללא כאלה שכבר אושרו/נדחו אצלנו
add('GET', /^\/api\/expense-drafts$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { drafts: [], error: 'חשבונית ירוקה לא מחוברת' });
  if (q.fresh) greenInvoice.clearDataCache();
  try {
    const db = load();
    const cid = q.companyId || giCompanyId();
    const approved = db.approvedDrafts || {};
    const dismissed = db.dismissedDrafts || [];
    const all = await greenInvoice.expenseDrafts();
    // מסנן החוצה טיוטות שכבר קיימות כהוצאה במערכת (הוצאה בחשבונית ירוקה / רשומת ספק) — כדי שלא תגיע לאשר מסמך שכבר נקלט
    const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/^0+/, '').toLowerCase();
    const amtEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1;
    const existing = [];
    try { const _to = new Date().toISOString().slice(0, 10); for (const e of (await greenInvoice.expensesInRange('2026-01-01', _to))) if (e.number) existing.push({ num: nrm(e.number), amt: Number(e.amount) || 0, sup: nrm(e.supplierName) }); } catch { }
    for (const p of (db.supplierPayables || []).filter(x => (x.companyId || giCompanyId()) === cid)) if (p.number) existing.push({ num: nrm(p.number), amt: Number(p.amount) || 0, sup: nrm(p.supplierName) });
    // כבר קיים כהוצאה = אותו מספר + אותו סכום, ואם לשתי הרשומות יש שם ספק — גם הוא חייב להתאים (כדי לא לפסול בטעות ספקים שונים עם אותו מספר)
    const alreadyExpense = (d) => {
      const num = nrm(d.number); if (!num) return false;
      const amt = d.amount != null ? Number(d.amount) : null;
      const sup = nrm(d.supplierName);
      // מספר מסמך לבדו אינו ראיה מספקת. טיוטה שה-AI עוד לא הספיק לקרוא מגיעה בלי
      // סכום ובלי שם ספק, ואז שני התנאים האחרים "עברו" מאליהם — די היה במספר
      // חשבונית מקרי שכבר קיים במערכת כדי שהטיוטה תיעלם מהרשימה מיד אחרי ההעלאה.
      if (amt == null && !sup) return false;
      return existing.some(x => x.num === num && (amt == null || amtEq(x.amt, amt)) && (!sup || !x.sup || sup === x.sup));
    };
    // סיבת ההסתרה נשמרת ומוחזרת — טיוטה שנעלמת בלי הסבר היא באג שקשה לאתר,
    // וכאן יש שלוש סיבות שונות שנראות למשתמש זהות לחלוטין.
    const hiddenReason = (d) => {
      if (approved[d.id]) return 'כבר אושרה ונקלטה כהוצאה';
      if (dismissed.includes(d.id)) return 'נדחתה ידנית';
      if (alreadyExpense(d)) return { text: `כבר קיימת כהוצאה (מספר ${d.number})`, dup: true };
      return null;
    };
    const drafts = [], hidden = [];
    for (const d of all) {
      const why = hiddenReason(d);
      if (why) {
        const w = typeof why === 'string' ? { text: why, dup: false } : why;
        hidden.push({ id: d.id, number: d.number || null, supplierName: d.supplierName || null, amount: d.amount != null ? d.amount : null, date: d.date || null, reason: w.text, duplicate: w.dup });
      } else drafts.push({ ...d, raw: undefined });
    }
    json(res, { drafts, hidden, hiddenCount: hidden.length, duplicateCount: hidden.filter(h => h.duplicate).length });
  } catch (e) { json(res, { drafts: [], error: e.message }, 500); }
});

// קישור חשבונית לאירועים ב"קבלנים לתשלום" — מסמן אותם כשולמו (יורדים מהרשימה) עם ייחוס לחשבונית
function applyLinkedEvents(db, linkedEvents, invoiceNumber, payableId) {
  if (!Array.isArray(linkedEvents) || !linkedEvents.length) return 0;
  let n = 0;
  for (const le of linkedEvents) {
    const ev = (db.events || []).find(e => String(e.id) === String(le.eventId));
    if (!ev || !Array.isArray(ev.contractorDetails) || !ev.contractorDetails[le.index]) continue;
    const cd = ev.contractorDetails[le.index];
    // שיוך = קישור לחשבונית בלבד (לא "שולם לספק"). התשלום בפועל מסומן בנפרד.
    cd.paidInvoice = invoiceNumber || cd.paidInvoice || null;
    cd.paidPayableId = payableId || null;
    if (le.amount != null && le.amount !== '' && !isNaN(Number(le.amount))) cd.amount = Number(le.amount);  // תיקון סכום הספק פר-אירוע ישירות ממסך אישור הטיוטה
    n++;
  }
  return n;
}

// POST /api/expense-drafts/purge-duplicates — מחיקת טיוטות שכבר נקלטו כהוצאה.
// { ids: [...] } — רק מזהים שהשרת עצמו סימן ככפילות ברשימה, כדי שלא תימחק טיוטה
// שרק נדחתה או שסומנה כמאושרת בטעות. הטיוטה היא הקובץ שהועלה; ההוצאה עצמה נשארת.
add('POST', /^\/api\/expense-drafts\/purge-duplicates$/, async (req, res, _p, q, body) => {
  const ids = [...new Set((Array.isArray(body && body.ids) ? body.ids : []).map(String).filter(Boolean))].slice(0, 100);
  if (!ids.length) return json(res, { ok: true, deleted: 0, failed: [] });
  let deleted = 0; const failed = [];
  for (const id of ids) {
    try { await greenInvoice.deleteExpenseDraft(id); deleted++; }
    catch (e) { failed.push({ id, error: e.message }); }
  }
  if (deleted) { greenInvoice.clearDataCache(); console.log(`[drafts] נמחקו ${deleted} טיוטות כפולות`); }
  json(res, { ok: true, deleted, failed });
});

// POST /api/expense-drafts/:id/restore — החזרת טיוטה שהוסתרה (נדחתה ידנית או סומנה כמאושרת)
add('POST', /^\/api\/expense-drafts\/([^/]+)\/restore$/, (req, res, params) => {
  const db = load();
  const id = params[0];
  let did = [];
  if (db.dismissedDrafts && db.dismissedDrafts.includes(id)) { db.dismissedDrafts = db.dismissedDrafts.filter(x => x !== id); did.push('בוטלה הדחייה'); }
  if (db.approvedDrafts && db.approvedDrafts[id]) { delete db.approvedDrafts[id]; did.push('בוטל סימון האישור'); }
  if (did.length) save(db);
  json(res, { ok: true, done: did });
});

// POST /api/expense-drafts/:id/approve — אישור טיוטה → יצירת הוצאה אמיתית מנתוני ה-OCR (עם תיקונים)
// body: { supplierId, number, date, documentType, amount, vatIncluded, description, accountingClassificationId? }
add('POST', /^\/api\/expense-drafts\/([^/]+)\/approve$/, async (req, res, params, q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const draftId = params[0];
  const _biz = bizProfile(load(), q.companyId || giCompanyId());
  const _acctEmail = _biz.accountantEmail || '';   // רו"ח של החברה הפעילה בלבד
  const _senderEmail = _biz.senderEmail || '';     // כתובת "מאת" של החברה (ריק = ברירת מחדל SMTP)
  try {
    const draft = await greenInvoice.getExpenseDraft(draftId);
    if (!draft) return json(res, { error: 'הטיוטה לא נמצאה (ייתכן שכבר טופלה)' }, 404);
    let supplierId = body.supplierId || draft.supplierId;
    // חשבון עסקה (20) = רישום פנימי. אופק = רשומה מקומית בלבד + מייל (ה-GI של אופק אינו מסיים הוצאות דרך ה-API — POST /expenses מחזיר 404).
    const isBusiness = Number(body.documentType) === 20;
    const isCredit = Number(body.documentType || draft.documentType) === 330;   // חשבונית זיכוי מספק
    const _activeCid = q.companyId || giCompanyId();
    const localOnly = isBusiness || _activeCid === 'co_ofek';
    if (!localOnly && !supplierId) return json(res, { error: 'יש לבחור ספק עבור ההוצאה' }, 400);
    // רשומה מקומית אינה מחייבת בחירת ספק, אבל בלי מזהה היא לא מופיעה תחת אף ספק —
    // לא בכרטיס הספק ולא במודל שיוך הבנק. אם השם מזוהה, מצמידים את המזהה כאן.
    if (localOnly && !supplierId) {
      const nm = String(body.supplierName || draft.supplierName || '').trim().toLowerCase();
      if (nm) {
        try {
          const found = (await greenInvoice.listSuppliers() || []).find(x => String(x.name || '').trim().toLowerCase() === nm);
          if (found) { supplierId = found.id; console.log(`[approve] רשומה מקומית קיבלה מזהה ספק לפי שם: ${found.name}`); }
        } catch { /* לא חוסם — המיזוג לפי שם עדיין יתפוס */ }
      }
    }
    const paidFlag = body.paid !== false; // ברירת מחדל שולם (הפרונט שולח במפורש)
    const linkedEvents = Array.isArray(body.linkedEvents) ? body.linkedEvents : [];

    // סיווג חשבונאי — נדרש רק למסמך מס אמיתי שנוצר ב-GI (לא לרישום מקומי)
    let classId = body.accountingClassificationId || draft.accountingClassificationId || null;
    if (!localOnly) {
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
      companyId: q.companyId || giCompanyId(),   // שיוך ההוצאה לחברה הפעילה (מונע ערבוב עם BPM)
      supplierId, supplierName: body.supplierName || draft.supplierName || '',
      taxId: (body.taxId || '').trim() || null,
      documentType: Number(body.documentType || draft.documentType) || 305,
      // זיכוי מספק (330) מקטין את החוב אליו — נשמר בסכום שלילי כדי שכל הסכימות
      // הקיימות ("סה\"כ לתשלום", מוכן לתשלום, הדוח היומי) יתקזזו נכון מאליהן.
      number, date,
      amount: isCredit ? -Math.abs(amount) : amount,
      amountExcludeVat: isCredit ? -Math.abs(net) : net,
      vat: isCredit ? -Math.abs(vat) : vat,
      description: baseDesc, allocationNumber: alloc || null,
      paid: paidFlag, paidAt: paidFlag ? new Date().toISOString() : null,
      linkedEvents, createdAt: new Date().toISOString(),
      ...extra,
    });

    // ===== רישום מקומי בלבד (חשבון עסקה, או חברת אופק) — לא נוצר בחשבונית ירוקה. הקובץ נשמר באתר לצפייה בכל שלב, ומועבר במייל ההוצאות (פייפרלס/רו"ח) =====
    if (localOnly) {
      // מורידים עותק מקומי של קובץ החשבונית (לצפייה/הורדה אצלנו גם אחרי מחיקת הטיוטה), ושומרים את ה-buffer להעברה במייל
      let localFileId = null, fileBuf = null, fileCt = 'application/pdf', fileExt = 'pdf';
      try {
        if (draft.url) {
          const fr = await fetch(draft.url, { redirect: 'follow' });
          if (fr.ok) {
            fileBuf = Buffer.from(await fr.arrayBuffer());
            fileCt = fr.headers.get('content-type') || 'application/pdf';
            fileExt = /pdf/i.test(fileCt) ? 'pdf' : (/png/i.test(fileCt) ? 'png' : (/jpe?g/i.test(fileCt) ? 'jpg' : 'pdf'));
            const saved = await saveFile({ employeeId: 'payable', kind: 'expense', filename: `expense-${String(number).replace(/[^\w.-]/g, '_')}.${fileExt}`, mime: fileCt, data: fileBuf.toString('base64') });
            localFileId = saved.id;
          }
        }
      } catch { }
      // העברת קובץ ההוצאה למייל ההוצאות של החברה (פייפרלס/רו"ח) — רק לאופק (חשבון עסקה פנימי של BPM נשאר בלי מייל, כמו קודם)
      let forwarded = false, forwardError = null;
      if (_activeCid === 'co_ofek') try {
        const _mcreds = companyMailCreds(load(), _activeCid);
        if (!_acctEmail) forwardError = 'לא הוגדר מייל להעברת הוצאות בפרטי העסק';
        else if (!fileBuf) forwardError = 'הורדת קובץ ההוצאה נכשלה';
        else if (!mailer.companyMailConfigured(_mcreds) && !mailer.mailerConfigured()) forwardError = 'לא הוגדר חשבון מייל לחברה';
        else {
          const safeNum = String(number).replace(/[^\w.-]/g, '_');
          await mailer.sendMailFrom(_mcreds, {
            to: _acctEmail,
            subject: `הוצאה #${number}${alloc ? ` · מס' הקצאה ${alloc}` : ''}`,
            text: `מצורפת חשבונית הוצאה שנקלטה במערכת.\nספק: ${body.supplierName || draft.supplierName || ''}\nמספר מסמך: ${number}\nתאריך: ${date}\nסכום כולל מע"מ: ${amount}\nתיאור: ${baseDesc}`,
            attachments: [{ filename: `expense-${safeNum}.${fileExt}`, content: fileBuf, contentType: fileCt }],
          });
          forwarded = true;
        }
      } catch (e) { forwardError = e.message; }
      // מחיקת הטיוטה מחשבונית ירוקה — הטיפול הושלם אצלנו (רישום מקומי). אם המחיקה נכשלת — מסמנים כמטופלת אצלנו כדי שלא תופיע שוב.
      let draftDeleted = false;
      try { await greenInvoice.deleteExpenseDraft(draftId); draftDeleted = true; } catch { }
      const db = load();
      db.supplierPayables = db.supplierPayables || [];
      const payable = newPayable({ isBusinessDoc: isBusiness || undefined, localOnly: true, giExpenseId: null, draftId: draftDeleted ? null : draftId, localFileId });
      db.supplierPayables.push(payable);
      const linked = applyLinkedEvents(db, linkedEvents, number, payable.id);
      db.approvedDrafts = db.approvedDrafts || {};
      db.approvedDrafts[draftId] = { businessPayableId: payable.id, at: new Date().toISOString(), draftDeleted, localOnly: true, forwarded };
      save(db);
      return json(res, { ok: true, localOnly: true, businessDoc: isBusiness, payableId: payable.id, linkedCount: linked, draftDeleted, forwarded, forwardError });
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
      const fwd = _acctEmail;   // כתובת רו"ח של החברה הפעילה (ריק = לא מעבירים)
      const _mcreds = companyMailCreds(load(), q.companyId || giCompanyId());   // חשבון המייל של החברה (אם הוגדר) — כדי שיישלח מהתיבה שלה
      if ((mailer.companyMailConfigured(_mcreds) || mailer.mailerConfigured()) && fwd && fileBuf) {
        await mailer.sendMailFrom(_mcreds, {
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

    json(res, { ok: true, expense: created, draftRemoved, forwarded, forwardError, forwardTo: _acctEmail || null, payableId, linkedCount });
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
  const evs = companyEvents(db, q.companyId || giCompanyId());
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

// ── תשלום לספק לפי צבירת התאמות בנק ──────────────────────────────────────────
// כלל: "שולם לספק" אוטומטי מגיע *רק* מהתאמות בנק (תנועות חובה) שמשויכות לחשבונית הספק,
// באופן מצטבר על פני כל השורות. כל עוד הסכום המצטבר קטן מסכום החשבונית → "שולם חלקית".
// רק כשהסכום המצטבר מכסה את מלוא החשבונית → "שולם לספק" סופי, וכל האירועים של אותה חשבונית מסומנים.
// בנוסף: מנרמל את שורות הקבלן באירועים — מאפס סימוני "שולם" ישנים שנוצרו מקישור בלבד (לא מבנק ולא ידני),
// ומסמן כשולם את אלה שמכוסים במלואם בבנק. סימון ידני (paidSource='manual') או "סמן כשולם" על ההוצאה (p.paid) נשמרים.
const _nrmExpKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/^0+/, '');
function supplierBankDebitByKey(db, want) {
  const byKey = {}; // 'id:'+expenseId / 'num:'+number → סכום מצטבר ששולם בבנק (חובה)
  for (const t of (db.bankTx || [])) {
    if (want && t.companyId !== want) continue;
    if (t.direction !== 'debit' || !['auto', 'manual', 'approved'].includes(t.matchStatus)) continue;
    const rowAmt = Number(t.absAmount != null ? t.absAmount : Math.abs(Number(t.amount) || 0)) || 0;
    const exps = (t.matchedInvoices || []).filter(inv => inv && inv.kind !== 'income');
    for (const inv of exps) {
      // תרומת השורה: הקצאה מפורשת אם קיימת, אחרת סכום השורה (כשההוצאה היחידה בשורה), אחרת סכום ההוצאה
      const contrib = Number(inv.allocated != null ? inv.allocated : (exps.length === 1 ? rowAmt : (inv.amount != null ? inv.amount : 0))) || 0;
      if (inv.id != null) { const k = 'id:' + String(inv.id); byKey[k] = (byKey[k] || 0) + contrib; }
      if (inv.number != null) { const k = 'num:' + _nrmExpKey(inv.number); byKey[k] = (byKey[k] || 0) + contrib; }
    }
  }
  return byKey;
}
// מחשב סטטוס תשלום לכל הוצאת ספק ומנרמל את שורות הקבלן. מחזיר Map: payable → {paid,total,status}
function applyBankSupplierPayments(db, want) {
  const debitByKey = supplierBankDebitByKey(db, want);
  const payables = (db.supplierPayables || []).filter(p => (p.companyId || giCompanyId()) === want);
  const statusByKey = {}; // 'pid:'/'eid:'/'num:' → {kind,source}
  const payMeta = new Map();
  for (const p of payables) {
    const total = Number(p.amount) || 0;
    let paid = 0;
    if (p.giExpenseId != null) paid = Math.max(paid, debitByKey['id:' + String(p.giExpenseId)] || 0);
    if (p.number != null) paid = Math.max(paid, debitByKey['num:' + _nrmExpKey(p.number)] || 0);
    let status = null, source = null, kind = null;
    if (p.paid) { status = 'paid'; kind = 'full'; source = 'manual'; }
    else if (total > 0 && paid >= total - 1) { status = 'paid'; kind = 'full'; source = 'bank'; }
    else if (paid > 0) { status = 'partial'; kind = 'partial'; }
    payMeta.set(p, { paid, total, status });
    const v = { kind, source };
    if (p.id != null) statusByKey['pid:' + String(p.id)] = v;
    if (p.giExpenseId != null) statusByKey['eid:' + String(p.giExpenseId)] = v;
    if (p.number != null) statusByKey['num:' + _nrmExpKey(p.number)] = v;
  }
  // חשבונית שקיימת בחשבונית ירוקה ומותאמת בבנק, אך מעולם לא נקלטה דרך האתר, אין
  // לה רשומה מקומית — ולכן היא לא נכללה בלולאה למעלה, והשיוך אליה לא זוהה כתשלום.
  // כאן נגזר הסטטוס ישירות מהתאמת הבנק: אם הבנק מכסה את סכום החשבונית, שולם.
  const bankOnlyStatus = (c) => {
    let paidAmt = 0;
    if (c.paidExpenseId != null) paidAmt = Math.max(paidAmt, debitByKey['id:' + String(c.paidExpenseId)] || 0);
    if (c.paidInvoice != null) paidAmt = Math.max(paidAmt, debitByKey['num:' + _nrmExpKey(c.paidInvoice)] || 0);
    if (paidAmt <= 0) return null;
    // אין רשומה מקומית ולכן אין "סכום חשבונית" להשוות אליו. תנועת חובה מותאמת
    // לחשבונית הזו היא עדות מספקת שהיא שולמה.
    return { kind: 'full', source: 'bank' };
  };

  let dirty = false;
  for (const ev of (db.events || [])) {
    if (want && (ev.companyId || giCompanyId()) !== want) continue;
    for (const c of (ev.contractorDetails || [])) {
      if (!c) continue;
      const v = (c.paidPayableId != null && statusByKey['pid:' + String(c.paidPayableId)])
        || (c.paidExpenseId != null && statusByKey['eid:' + String(c.paidExpenseId)])
        || (c.paidInvoice != null && statusByKey['num:' + _nrmExpKey(c.paidInvoice)])
        || bankOnlyStatus(c) || null;
      const hasLink = !!(c.paidInvoice || c.paidPayableId || c.paidExpenseId);
      if (v && v.kind === 'full') {
        if (!c.paid || c.paidSource !== v.source) { c.paid = true; c.paidSource = v.source; dirty = true; }
      } else if (c.paid && c.paidSource !== 'manual' && hasLink) {
        // סימון ישן שנוצר מקישור בלבד (לא ידני, לא מכוסה במלואו בבנק) → מאופס
        c.paid = false; c.paidSource = null; dirty = true;
      }
    }
  }
  if (dirty) save(db);
  return payMeta;
}

// GET /api/supplier-payables?all= — הוצאות ספקים לתשלום (ברירת מחדל: רק שלא שולמו)
add('GET', /^\/api\/supplier-payables$/, async (req, res, _p, q) => {
  const db = load();
  // סינון לפי חברה — רשומות ישנות ללא companyId משויכות לחברת ה-GI (BPM); אופק/משה יקבלו רק את שלהם
  const want = q.companyId || giCompanyId();
  const list = (db.supplierPayables || []).filter(p => (p.companyId || giCompanyId()) === want);
  const evs = (db.events || []).filter(e => (e.companyId || giCompanyId()) === want);
  // מפת "הלקוח שילם" — כדי לקבוע לכל הוצאה אם היא מוכנה לתשלום (הכסף מהלקוח כבר נכנס על האירועים שההוצאה מכסה)
  const bankPaid = buildBankPaidMap(db, want);
  // תשלום לספק לפי צבירת התאמות בנק + נרמול שורות הקבלן (מאפס סימוני "שולם" ישנים שמקורם בקישור בלבד)
  const payMeta = applyBankSupplierPayments(db, want);
  let openNums = null;
  try { if (greenInvoice.haveCredentials()) { const open = await greenInvoice.openDocuments(); openNums = new Set((open || []).map(d => String(d.number))); } } catch { openNums = null; }
  // פירוט: האירועים שההוצאה מכסה — שורות קבלן באירועים ששויכו להוצאה זו (לפי מזהה רישום / מזהה מסמך ירוק / מספר חשבונית)
  // בוחר את חשבונית הלקוח שתוצג לצד האירוע. סדר: חשבונית מס → מס-קבלה → חשבון עסקה.
  // קבלה (400) לעולם לא — היא אישור תשלום ולא המסמך החשבונאי.
  // מסמך שזוכה במלואו (credited) מדולג ויורדים לבא בתור; מסמך מס שזוכה חלקית מוצג
  // כרגיל עם ציון הזיכוי — הוא עדיין בתוקף על היתרה.
  const INVOICE_PRIORITY = [305, 320, 300];
  const pickEventInvoice = (ev) => {
    const links = Array.isArray(ev && ev.linkedDocs) ? ev.linkedDocs : [];
    const active = links.filter(d => d && !d.credited && !d.credit && !d.converted);
    for (const t of INVOICE_PRIORITY) {
      const d = active.find(x => Number(x.type) === t);
      if (!d) continue;
      // הזיכוי מוצג רק על מסמך מס — נפילה ל"חשבון עסקה" אחרי זיכוי מלא אינה נושאת הערה
      const creditDoc = (t === 305 || t === 320) ? links.find(x => x && Number(x.type) === 330) : null;
      return { id: d.id, number: d.number || null, type: t, uploaded: !!d.uploaded,
        creditId: creditDoc ? creditDoc.id : null, creditNumber: creditDoc ? (creditDoc.number || null) : null,
        creditAmount: creditDoc && creditDoc.amount != null ? Number(creditDoc.amount) : null };
    }
    return null;
  };

  const coveredFor = (p) => {
    const out = [];
    for (const ev of evs) {
      const details = ev.contractorDetails || [];
      for (const c of details) {
        if (!c) continue;
        const byId = p.id && c.paidPayableId && String(c.paidPayableId) === String(p.id);
        const byExp = p.giExpenseId && c.paidExpenseId && String(c.paidExpenseId) === String(p.giExpenseId);
        const byNum = p.number && c.paidInvoice && String(c.paidInvoice) === String(p.number) && (c.name || '').trim() === (p.supplierName || '').trim();
        if (byId || byExp || byNum) out.push({ eventId: ev.id, index: (ev.contractorDetails || []).indexOf(c), date: ev.date || ev.dateRaw || null, artist: ev.artist || '', location: ev.location || '', amount: Number(c.amount) || 0, supplierPaid: !!c.paid, invoice: pickEventInvoice(ev), clientPaid: eventClientPaid(ev, bankPaid, openNums) });
      }
    }
    return out.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  };
  // מוכנות לתשלום לספק: ready = הלקוח שילם על כל האירועים · waiting = טרם · partial = חלק · nolink = לא משויך לאירוע
  const readinessOf = (events) => {
    if (!events.length) return 'nolink';
    const paid = events.filter(e => e.clientPaid && e.clientPaid.status === 'paid').length;
    return paid === events.length ? 'ready' : paid === 0 ? 'waiting' : 'partial';
  };
  const meta = (p) => payMeta.get(p) || { paid: 0, total: Number(p.amount) || 0, status: null };
  // ברירת מחדל: מסתירים ששולמו במלואם (ידני p.paid או כיסוי בנק מלא) ומוחלפים; "שולם חלקית" *נשאר* ברשימה עם היתרה
  const out = (q.all ? list.filter(p => !p.superseded) : list.filter(p => !p.superseded && meta(p).status !== 'paid')).slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(p => {
      const cov = coveredFor(p); const m = meta(p);
      return { ...p, hasFile: !!(p.giExpenseId || p.draftId || p.localFileId), coveredEvents: cov, readiness: readinessOf(cov),
        bankPaidAmount: m.paid, remaining: Math.max(0, (m.total || 0) - (m.paid || 0)), supplierPayStatus: m.status };
    });
  // השלמת סכומי זיכוי שלא נשמרו בעבר. משיכה אחת פר-מסמך עם מטמון ותקרה, כדי שמסך
  // עם עשרות הוצאות לא יתורגם לעשרות קריאות ל-API. כישלון לא חוסם — תוצג הערה בלי סכום.
  if (giEnabled(reqCompany(q))) {
    const seen = new Map();
    let budget = 15;
    for (const p of out) {
      for (const r of (p.coveredEvents || [])) {
        const inv = r && r.invoice;
        if (!inv || !inv.creditId || inv.creditAmount != null) continue;
        if (seen.has(inv.creditId)) { inv.creditAmount = seen.get(inv.creditId); continue; }
        if (budget-- <= 0) continue;
        try {
          const doc = await greenInvoice.getDocument(inv.creditId);
          const amt = Number(doc && (doc.amount != null ? doc.amount : doc.total)) || null;
          seen.set(inv.creditId, amt); inv.creditAmount = amt;
        } catch { seen.set(inv.creditId, null); }
      }
    }
  }
  json(res, { ok: true, payables: out });
});

// GET /api/supplier-payables/compare — שלב 1 של איחוד מקור האמת: משווה את הרשימה
// המקומית מול ההוצאות שבחשבונית ירוקה, בלי לשנות דבר. נועד להראות את גודל הפער
// לפני שנוגעים בנתונים.
//
// שתי משפחות, ובכוונה:
//   א׳ מסמכי הוצאה מוכרים (מס / מס-קבלה / קבלה / זיכוי) — מקור האמת הוא חשבונית
//      ירוקה. העתק מקומי שלהם הוא הכפילות שצריכה למות.
//   ב׳ חשבון עסקה / דרישת תשלום (20) — רישום פנימי בלבד. לא נוצר בחשבונית ירוקה,
//      לא נשלח לרו"ח. מקור האמת הוא אנחנו, והרשומה המקומית היא תפקידו האמיתי.
add('GET', /^\/api\/supplier-payables\/compare$/, async (req, res, _p, q) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  const db = load();
  const cid = reqCompany(q);
  const nrm = (x) => String(x || '').trim().toLowerCase().replace(/^0+/, '');
  const locals = (db.supplierPayables || []).filter(p => ownedBy(p, cid));

  const internal = locals.filter(p => Number(p.documentType) === 20 || p.isBusinessDoc);
  const ofek = locals.filter(p => cid === 'co_ofek' && !(Number(p.documentType) === 20 || p.isBusinessDoc));
  const mirrored = locals.filter(p => !internal.includes(p) && !ofek.includes(p));

  let gi = [], giError = null;
  if (giEnabled(cid)) {
    const from = String(q.from || '2026-01-01').slice(0, 10);
    const to = String(q.to || new Date().toISOString().slice(0, 10)).slice(0, 10);
    try { gi = await greenInvoice.expensesInRange(from, to) || []; }
    catch (e) { giError = e.message; }
  } else giError = 'חשבונית ירוקה לא מחוברת לחברה זו';

  const localByKey = new Map();
  for (const p of mirrored) {
    if (p.giExpenseId) localByKey.set('id:' + String(p.giExpenseId), p);
    if (p.number) localByKey.set('num:' + nrm(p.number), p);
  }
  const seen = new Set();
  const onlyInGi = [];
  for (const e of gi) {
    const hit = (e.id && localByKey.get('id:' + String(e.id))) || (e.number && localByKey.get('num:' + nrm(e.number)));
    if (hit) { seen.add(hit.id); continue; }
    onlyInGi.push({ id: e.id, number: e.number || null, supplierName: e.supplierName || '', date: e.date || null, amount: e.amount != null ? Number(e.amount) : null });
  }
  const onlyLocal = mirrored.filter(p => !seen.has(p.id))
    .map(p => ({ id: p.id, number: p.number || null, supplierName: p.supplierName || '', date: p.date || null,
      amount: p.amount != null ? Number(p.amount) : null, giExpenseId: p.giExpenseId || null }));

  // כמה מהן קשורות לאירועים — אלה שהגירה שגויה תשבור
  const linkedCount = (pid, num, name) => (db.events || []).filter(ev => ownedBy(ev, cid)
    && (ev.contractorDetails || []).some(c => c && (String(c.paidPayableId || '') === String(pid)
      || (num && c.paidInvoice && nrm(c.paidInvoice) === nrm(num) && String(c.name || '').trim() === String(name || '').trim())))).length;

  // כמה מההוצאות שבחשבונית ירוקה מכוסות בפועל ע"י תנועת חובה בבנק. זה מה שיקבע
  // אם סינון "רק שטרם שולמו" מצמצם באמת או מציג כמעט הכל.
  const debitByKey = supplierBankDebitByKey(db, cid);
  let covered = 0, uncovered = 0, uncoveredSum = 0;
  const uncoveredBig = [];
  for (const e of gi) {
    const amt = Number(e.amount) || 0;
    let paidAmt = 0;
    if (e.id != null) paidAmt = Math.max(paidAmt, debitByKey['id:' + String(e.id)] || 0);
    if (e.number != null) paidAmt = Math.max(paidAmt, debitByKey['num:' + _nrmExpKey(e.number)] || 0);
    if (amt > 0 && paidAmt >= amt - 1) covered++;
    else {
      uncovered++; uncoveredSum += amt;
      uncoveredBig.push({ number: e.number || null, supplierName: e.supplierName || '', date: e.date || null, amount: amt });
    }
  }
  uncoveredBig.sort((a, b) => b.amount - a.amount);

  json(res, {
    ok: true, companyId: cid, giError,
    bank: { covered, uncovered, uncoveredSum: +uncoveredSum.toFixed(2) },
    uncoveredTop: uncoveredBig.slice(0, 8),
    counts: {
      localTotal: locals.length,
      internal: internal.length,          // משפחה ב׳ — נשארת כפי שהיא
      ofekLocal: ofek.length,             // אופק — נשארת מקומית
      mirrored: mirrored.length,          // משפחה א׳ — ההעתקים שאמורים להצטמצם לשכבת-על
      giTotal: gi.length,
      matched: seen.size,
      onlyInGi: onlyInGi.length,          // ← הפער: קיים בחשבונית ירוקה ולא אצלנו
      onlyLocal: onlyLocal.length,        // ← העתק בלי מקור בחשבונית ירוקה
      mirroredWithGiId: mirrored.filter(p => p.giExpenseId).length,
      mirroredWithManualPaid: mirrored.filter(p => p.paid).length,
      mirroredLinkedToEvents: mirrored.filter(p => linkedCount(p.id, p.number, p.supplierName) > 0).length,
    },
    onlyInGi: onlyInGi.slice(0, 40),
    onlyLocal: onlyLocal.slice(0, 40),
  });
});

// POST /api/supplier-payables/:id/link-events { items:[{eventId,index}] } — שיוך אירועים להוצאת ספק קיימת (מסמן "שולם לספק")
add('POST', /^\/api\/supplier-payables\/([^/]+)\/link-events$/, (req, res, params, _q, body) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  const _cid = (_q && _q.companyId) || (body && body.companyId) || giCompanyId();
  if ((p.companyId || giCompanyId()) !== _cid) return json(res, { error: 'ההוצאה שייכת לחברה אחרת' }, 403); // בידוד
  const items = Array.isArray(body?.items) ? body.items : [];
  let n = 0;
  for (const it of items) {
    const ev = (db.events || []).find(e => String(e.id) === String(it.eventId));
    if (ev && Array.isArray(ev.contractorDetails) && ev.contractorDetails[it.index]) {
      const cd = ev.contractorDetails[it.index];
      // שיוך = קישור לחשבונית בלבד (לא "שולם לספק"). התשלום בפועל מסומן בנפרד.
      cd.paidPayableId = p.id;
      cd.paidInvoice = p.number || cd.paidInvoice || null;
      cd.paidExpenseId = p.giExpenseId || cd.paidExpenseId || null;
      n++;
    }
  }
  save(db); json(res, { ok: true, linked: n });
});

// GET /api/supplier-payables/:id/linked-events — האירועים המשויכים כרגע להוצאה זו (לתצוגה + ביטול שיוך)
add('GET', /^\/api\/supplier-payables\/([^/]+)\/linked-events$/, async (req, res, params, _q) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  const _cid = (_q && _q.companyId) || giCompanyId();
  if ((p.companyId || giCompanyId()) !== _cid) return json(res, { error: 'ההוצאה שייכת לחברה אחרת' }, 403);
  // נרמול תשלום-לספק לפי צבירת בנק (מאפס סימוני "שולם" ישנים שמקורם בקישור בלבד)
  const payMetaLE = applyBankSupplierPayments(db, _cid);
  const meP = payMetaLE.get(p) || { paid: 0, total: Number(p.amount) || 0, status: null };
  // סטטוס תשלום מהלקוח לכל אירוע — לפי בנק (זיכוי מאושר) או חשבונית ירוקה
  const bankPaid = buildBankPaidMap(db, _cid);
  let openNums = null;
  try { if (greenInvoice.haveCredentials()) { const open = await greenInvoice.openDocuments(); openNums = new Set((open || []).map(d => String(d.number))); } } catch { openNums = null; }
  const out = [];
  for (const ev of (db.events || [])) {
    const details = ev.contractorDetails || [];
    for (let i = 0; i < details.length; i++) {
      const c = details[i]; if (!c) continue;
      const byId = c.paidPayableId && String(c.paidPayableId) === String(p.id);
      const byExp = p.giExpenseId && c.paidExpenseId && String(c.paidExpenseId) === String(p.giExpenseId);
      const byNum = p.number && c.paidInvoice && String(c.paidInvoice) === String(p.number) && (c.name || '').trim() === (p.supplierName || '').trim();
      if (byId || byExp || byNum) out.push({ eventId: ev.id, index: i, date: ev.date || ev.dateRaw || null, artist: ev.artist || '', location: ev.location || '', amount: Number(c.amount) || 0, contractor: (c.name || '').trim(), supplierPaid: !!c.paid, clientPaid: eventClientPaid(ev, bankPaid, openNums) });
    }
  }
  out.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  json(res, { ok: true, events: out, supplierPayStatus: meP.status, bankPaidAmount: meP.paid, remaining: Math.max(0, (meP.total || 0) - (meP.paid || 0)) });
});

// POST /api/supplier-payables/:id/unlink-events { items:[{eventId,index}] } — ביטול שיוך אירועים מהוצאה (מחזיר אותם לרשימת הפתוחים)
add('POST', /^\/api\/supplier-payables\/([^/]+)\/unlink-events$/, (req, res, params, _q, body) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  const _cid = (_q && _q.companyId) || (body && body.companyId) || giCompanyId();
  if ((p.companyId || giCompanyId()) !== _cid) return json(res, { error: 'ההוצאה שייכת לחברה אחרת' }, 403); // בידוד
  const items = Array.isArray(body?.items) ? body.items : [];
  let n = 0;
  for (const it of items) {
    const ev = (db.events || []).find(e => String(e.id) === String(it.eventId));
    if (ev && Array.isArray(ev.contractorDetails) && ev.contractorDetails[it.index]) {
      const cd = ev.contractorDetails[it.index];
      const here = (cd.paidPayableId && String(cd.paidPayableId) === String(p.id))
        || (p.giExpenseId && cd.paidExpenseId && String(cd.paidExpenseId) === String(p.giExpenseId))
        || (p.number && cd.paidInvoice && String(cd.paidInvoice) === String(p.number) && (cd.name || '').trim() === (p.supplierName || '').trim());
      if (here) { cd.paid = false; cd.paidPayableId = null; cd.paidInvoice = null; cd.paidExpenseId = null; cd.paidExpenseUrl = null; n++; }
    }
  }
  if (Array.isArray(p.linkedEvents)) p.linkedEvents = p.linkedEvents.filter(le => !items.some(it => String(it.eventId) === String(le.eventId) && Number(it.index) === Number(le.index)));
  save(db); json(res, { ok: true, unlinked: n });
});

// POST /api/supplier-payables/:id/supersede { newPayableId, addEvents?:[{eventId,index}] }
// חשבונית מס (newPayableId) מחליפה את חשבון העסקה (:id): מעביר את אירועי העסקה למס, מוסיף אירועים נבחרים,
// ומסמן את העסקה כ"מוחלפת" — מוסתרת מהרשימה ומקושרת למס לתיעוד (audit). לא מוחקת נתונים.
add('POST', /^\/api\/supplier-payables\/([^/]+)\/supersede$/, (req, res, params, _q, body) => {
  const db = load();
  const oldP = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!oldP) return json(res, { error: 'חשבון העסקה לא נמצא' }, 404);
  const newP = (db.supplierPayables || []).find(x => x.id === (body && body.newPayableId));
  if (!newP) return json(res, { error: 'חשבונית המס לא נמצאה' }, 404);
  const _cid = (_q && _q.companyId) || (body && body.companyId) || giCompanyId();
  if ((oldP.companyId || giCompanyId()) !== _cid || (newP.companyId || giCompanyId()) !== _cid) return json(res, { error: 'שייך לחברה אחרת' }, 403); // בידוד
  if (String(oldP.id) === String(newP.id)) return json(res, { error: 'לא ניתן להחליף מסמך בעצמו' }, 400);
  const matchesOld = (cd) => (cd.paidPayableId && String(cd.paidPayableId) === String(oldP.id))
    || (oldP.giExpenseId && cd.paidExpenseId && String(cd.paidExpenseId) === String(oldP.giExpenseId))
    || (oldP.number && cd.paidInvoice && String(cd.paidInvoice) === String(oldP.number) && (cd.name || '').trim() === (oldP.supplierName || '').trim());
  const linkTo = (cd) => { cd.paidPayableId = newP.id; cd.paidInvoice = newP.number || cd.paidInvoice || null; cd.paidExpenseId = newP.giExpenseId || cd.paidExpenseId || null; }; // שיוך בלבד — לא מסמן שולם
  const moved = [];
  // 1) העברת אירועי חשבון העסקה לחשבונית המס
  for (const ev of (db.events || [])) {
    const dts = ev.contractorDetails || [];
    for (let i = 0; i < dts.length; i++) { const cd = dts[i]; if (cd && matchesOld(cd)) { linkTo(cd); moved.push({ eventId: ev.id, index: i }); } }
  }
  // 2) הוספת אירועים נבחרים נוספים לחשבונית המס
  let added = 0;
  for (const it of (Array.isArray(body?.addEvents) ? body.addEvents : [])) {
    const ev = (db.events || []).find(e => String(e.id) === String(it.eventId));
    if (ev && Array.isArray(ev.contractorDetails) && ev.contractorDetails[it.index]) { linkTo(ev.contractorDetails[it.index]); added++; }
  }
  // 3) איחוד linkedEvents של חשבונית המס
  const allItems = [...moved, ...(Array.isArray(body?.addEvents) ? body.addEvents : [])];
  const key = (x) => String(x.eventId) + '|' + Number(x.index);
  newP.linkedEvents = [...(newP.linkedEvents || [])];
  const seen = new Set(newP.linkedEvents.map(key));
  for (const it of allItems) if (!seen.has(key(it))) { newP.linkedEvents.push({ eventId: it.eventId, index: Number(it.index) }); seen.add(key(it)); }
  // 4) סימון חשבון העסקה כמוחלף — מוסתר מהרשימה + מקושר למס לתיעוד
  oldP.superseded = true; oldP.supersededByPayableId = newP.id; oldP.supersededByNumber = newP.number || null; oldP.supersededAt = new Date().toISOString();
  newP.supersedesPayableId = oldP.id; newP.supersedesNumber = oldP.number || null;
  save(db); json(res, { ok: true, moved: moved.length, added });
});

// GET /api/supplier-payables/:id/detail — פירוט ההוצאה מחשבונית ירוקה (מה כתוב על החשבונית: תיאור + שורות פריטים)
add('GET', /^\/api\/supplier-payables\/([^/]+)\/detail$/, async (req, res, params) => {
  const db = load();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  const pick = (e) => {
    const rowsRaw = e.expense || e.income || e.rows || e.items || e.expenses || e.lines || [];
    const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).map(it => ({
      description: it.description || it.name || it.catalogNum || it.itemDescription || '',
      quantity: it.quantity != null ? Number(it.quantity) : null,
      price: it.price != null ? Number(it.price) : (it.unitPrice != null ? Number(it.unitPrice) : null),
      total: it.total != null ? Number(it.total) : (it.sum != null ? Number(it.sum) : null),
    })).filter(x => x.description || x.total != null);
    const ocrTexts = Array.isArray(e.data?.texts) ? e.data.texts.map(t => (typeof t === 'string' ? t : (t && (t.text || t.value)) || '')).filter(Boolean) : [];
    return {
      description: e.description || e.data?.description || '', remarks: e.remarks || e.remark || '',
      classification: e.accountingClassification?.title || '', rows, ocrTexts, hasFile: !!(e.url || e.thumbnail),
    };
  };
  if (greenInvoice.haveCredentials() && p.giExpenseId) {
    try { const e = await greenInvoice.getExpense(p.giExpenseId); return json(res, { ok: true, ...pick(e) }); }
    catch (err) { return json(res, { ok: false, error: err.message, description: p.description || '', remarks: '', classification: '', rows: [], ocrTexts: [], hasFile: !!p.giExpenseId }); }
  }
  json(res, { ok: true, description: p.description || '', remarks: '', classification: '', rows: [], ocrTexts: [], hasFile: !!(p.giExpenseId || p.draftId || p.localFileId) });
});

// GET /api/supplier-payables/:id/file — צפייה/הורדה של קובץ החשבונית (מההוצאה בחשבונית ירוקה או מהטיוטה)
add('GET', /^\/api\/supplier-payables\/([^/]+)\/file$/, async (req, res, params) => {
  try {
    const db = load();
    // המזהה יכול להיות payable מקומי, או ישירות מזהה הוצאה בחשבונית ירוקה (התאמות בנק ישנות שמרו את מזהה ההוצאה)
    const p = (db.supplierPayables || []).find(x => x.id === params[0]);
    // עותק מקומי (הוצאת אופק / חשבון עסקה פנימי) — מוגש ישירות, גם ללא חיבור לחשבונית ירוקה
    if (p && p.localFileId) {
      try {
        const f = await getFile(p.localFileId);
        if (f && f.data) {
          let ct = f.mime || 'application/pdf';
          if (/image\/jpg/i.test(ct)) ct = 'image/jpeg';
          res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300' });
          return res.end(Buffer.from(f.data, 'base64'));
        }
      } catch { }
    }
    // עבור קובץ מחשבונית ירוקה (הוצאה/טיוטה) — נדרש חיבור פעיל
    if (!greenInvoice.haveCredentials()) return json(res, { error: 'אין קובץ מקומי למסמך זה, וחשבונית ירוקה אינה מחוברת' }, 400);
    let fileUrl = null;
    // מזהה ההוצאה ב-GI: מה-payable אם קיים, אחרת המזהה עצמו (fallback להתאמות בנק ישנות)
    const giExpId = (p && p.giExpenseId) || (!p ? params[0] : null);
    if (giExpId) { try { const e = await greenInvoice.getExpense(giExpId); fileUrl = (e?.url && (e.url.he || e.url.origin || e.url.pdf)) || (typeof e?.url === 'string' ? e.url : null); } catch { } }
    if (!fileUrl && p && p.draftId) { try { const d = await greenInvoice.getExpenseDraft(p.draftId); fileUrl = d?.url || null; } catch { } }
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
  const _cid = (_q && _q.companyId) || (body && body.companyId) || giCompanyId();
  if ((p.companyId || giCompanyId()) !== _cid) return json(res, { error: 'ההוצאה שייכת לחברה אחרת' }, 403); // בידוד
  const b = body || {};
  // לפני שמשנים מספר או שם ספק — מקבעים את הקישור של שורות הקבלן למזהה ההוצאה.
  // שורות שמקושרות רק בהתאמת "מספר + שם" היו מתנתקות בשקט מכל עריכה של השדות האלה,
  // והאירוע היה נעלם מפירוט ההוצאה בלי שום חיווי.
  const willRename = (b.number != null && String(b.number).trim() !== String(p.number || ''))
    || (b.supplierName != null && String(b.supplierName).trim() !== String(p.supplierName || ''));
  if (willRename) {
    let pinned = 0;
    for (const ev of (db.events || [])) {
      if (!ownedBy(ev, _cid)) continue;
      for (const cd of (ev.contractorDetails || [])) {
        if (!cd || cd.paidPayableId) continue;
        const byNum = p.number && cd.paidInvoice && String(cd.paidInvoice) === String(p.number)
          && (cd.name || '').trim() === (p.supplierName || '').trim();
        const byExp = p.giExpenseId && cd.paidExpenseId && String(cd.paidExpenseId) === String(p.giExpenseId);
        if (byNum || byExp) { cd.paidPayableId = p.id; pinned++; }
      }
    }
    if (pinned) console.log(`[payable] ${p.id}: קובעו ${pinned} קישורי שורות קבלן לפני שינוי מספר/שם`);
  }
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
  // עריכה מלאה — עדכון מקומי בלבד (לא נשלח לחשבונית ירוקה)
  if (b.supplierName != null) p.supplierName = String(b.supplierName).trim();
  if (b.taxId !== undefined) p.taxId = String(b.taxId || '').trim() || null;
  if (b.classificationTitle !== undefined) p.classificationTitle = String(b.classificationTitle || '').trim() || null;
  if (b.note !== undefined) p.note = String(b.note || '').trim();
  if (typeof b.isBusinessDoc === 'boolean') p.isBusinessDoc = b.isBusinessDoc;
  if (typeof b.paid === 'boolean') { p.paid = b.paid; p.paidAt = b.paid ? (p.paidAt || new Date().toISOString()) : null; }
  if (b.amount != null && b.amount !== '') {
    p.amount = Number(b.amount) || 0;
    p.amountExcludeVat = (b.amountExcludeVat != null && b.amountExcludeVat !== '') ? Number(b.amountExcludeVat) : +(p.amount / (1 + 0.18)).toFixed(2);
    p.vat = +(p.amount - p.amountExcludeVat).toFixed(2);
  } else if (b.amountExcludeVat != null && b.amountExcludeVat !== '') {
    p.amountExcludeVat = Number(b.amountExcludeVat) || 0;
  }
  p.updatedAt = new Date().toISOString();
  const stillLinked = (db.events || []).filter(e => ownedBy(e, _cid))
    .flatMap(e => (e.contractorDetails || []).map((c, i) => ({ ev: e.id, i, c })))
    .filter(x => x.c && (String(x.c.paidPayableId || '') === String(p.id)
      || (p.number && x.c.paidInvoice && String(x.c.paidInvoice) === String(p.number) && (x.c.name || '').trim() === (p.supplierName || '').trim())))
    .map(x => `${x.ev}#${x.i}`);
  console.log(`[payable-update] ${p.id} (${p.supplierName || ''} #${p.number || ''}) · שורות קבלן מקושרות אחרי העדכון: ${stillLinked.length ? stillLinked.join(', ') : 'אין ⚠'}`);
  save(db); json(res, { ok: true, payable: p, linkedRows: stillLinked });
});

// POST /api/supplier-payables/:id/delete — הסרת רשומת הוצאת ספק פנימית
add('POST', /^\/api\/supplier-payables\/([^/]+)\/delete$/, async (req, res, params, q, body) => {
  const db = load();
  const _cid = (q && q.companyId) || (body && body.companyId) || giCompanyId();
  const p = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!p) return json(res, { error: 'לא נמצא' }, 404);
  if ((p.companyId || giCompanyId()) !== _cid) return json(res, { error: 'ההוצאה שייכת לחברה אחרת' }, 403); // בידוד
  // שחרור אירועים משויכים — מחיקת ההוצאה מחזירה את שורות הקבלן שלה למצב פתוח (מונע שיוך "יתום")
  let released = 0;
  for (const ev of (db.events || [])) {
    for (const cd of (ev.contractorDetails || [])) {
      if (!cd || !cd.paid) continue;
      const here = (cd.paidPayableId && String(cd.paidPayableId) === String(p.id))
        || (p.giExpenseId && cd.paidExpenseId && String(cd.paidExpenseId) === String(p.giExpenseId))
        || (p.number && cd.paidInvoice && String(cd.paidInvoice) === String(p.number) && (cd.name || '').trim() === (p.supplierName || '').trim());
      if (here) { cd.paid = false; cd.paidPayableId = null; cd.paidInvoice = null; cd.paidExpenseId = null; cd.paidExpenseUrl = null; released++; }
    }
  }
  db.supplierPayables = (db.supplierPayables || []).filter(x => x.id !== params[0]);
  save(db);
  // מחיקה מלאה — כולל המסמך בחשבונית ירוקה. רק בבקשה מפורשת: זה מסמך חשבונאי,
  // והמחיקה אינה ניתנת לביטול. בלי הדגל נמחק רק הרישום המקומי, והמסמך נשאר.
  let giDeleted = false, giError = null;
  if (body && body.alsoGi === true && p.giExpenseId) {
    if (!greenInvoice.haveCredentials()) giError = 'חשבונית ירוקה לא מחוברת';
    else {
      try {
        await greenInvoice.deleteExpense(p.giExpenseId);
        giDeleted = true;
        const db2 = load();
        if (db2.expenseNotes) delete db2.expenseNotes[p.giExpenseId];
        // ניקוי שיוכים בתנועות בנק — אחרת נשאר שיוך למסמך שאינו קיים
        dropDocFromBank(db2, p.giExpenseId, _cid);
        save(db2);
        console.log(`[payable-delete] ${_cid}: נמחקה גם מחשבונית ירוקה · ${p.supplierName || ''} #${p.number || ''}`);
      } catch (e) { giError = e.message; }
    }
  }
  json(res, { ok: true, removed: 1, released, giDeleted, giError, hadGi: Boolean(p.giExpenseId) });
});

// GET /api/mail/status — האם שליחת מייל מוגדרת ולאן מועברות הוצאות
add('GET', /^\/api\/mail\/status$/, (req, res, _p, q) => {
  const acct = bizProfile(load(), q.companyId || giCompanyId()).accountantEmail || null;
  json(res, { configured: mailer.mailerConfigured(), forwardTo: acct });
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

// POST /api/ai/extract-income-doc { data(base64), mime } — חילוץ שדות ממסמך הכנסה ישן (אופק) למילוי אוטומטי
add('POST', /^\/api\/ai\/extract-income-doc$/, async (req, res, _p, q, body) => {
  if (!chatConfigured()) return json(res, { error: 'AI לא מוגדר. הוסף ANTHROPIC_API_KEY (או GEMINI_API_KEY) בהגדרות Render.' }, 400);
  const data = body && body.data ? String(body.data) : '';
  if (!data) return json(res, { error: 'חסר קובץ' }, 400);
  const mime = (body && body.mime) || 'application/pdf';
  try {
    let clients = [];
    try { if (greenInvoice.haveCredentials()) clients = await greenInvoice.listClients(); } catch { }
    const fields = await extractIncomeDocFields(data, mime, clients);
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
  // מסמך שכבר אינו פתוח (הומר/נסגר) — נחשב כסגירה מוצלחת כדי שיירד מהרשימה בלי שגיאה
  catch (e) { if (isAlreadyClosedErr(e)) return json(res, { ok: true, alreadyClosed: true }); json(res, { error: e.message }, 500); }
});

// פרטי חשבון להעברה בנקאית + שורת התייחסות למקור — נכנסים להערות של כל מסמך המשך
const DOC_NAMES_HE = { 10: 'הצעת מחיר', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 330: 'חשבונית זיכוי' };
// שורת מקור למסמך המשך (תמיד מופיעה). פרטי הבנק מגיעים מההערה הקבועה של העסק (documentBody מזריק אותה).
function followupRemarks(srcType, srcNumber) {
  const nm = DOC_NAMES_HE[Number(srcType)] || 'מסמך';
  return `מסמך המשך ל${nm}${srcNumber ? ` מס' ${srcNumber}` : ''}`;
}

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
    const doc = await createDocFwd({
      type, client: src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' },
      items, description: src.description || '', remarks: followupRemarks(src.type, src.number),
      linkedDocumentIds: [params[0]],
    });
    json(res, { ok: true, doc });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/lines — שורות + פרטי מסמך מקור, לעריכה לפני הפקת מסמך המשך
add('GET', /^\/api\/documents\/([^/]+)\/lines$/, async (req, res, params) => {
  // מסמך שהועלה ידנית (חשבונית ישנה) — אין מקור בחשבונית ירוקה, בונים שורות מהאירוע המשויך
  try {
    const f = await getFile(params[0]);
    if (f) {
      const db = load();
      let ev = null, srcDoc = null;
      for (const e of (db.events || [])) {
        const d = (e.linkedDocs || []).find(x => String(x.id) === String(params[0]) && x.uploaded);
        if (d) { ev = e; srcDoc = d; break; }
      }
      if (ev) {
        let items = invoiceItemsFromEvents([ev]).map(it => ({ description: it.description, quantity: it.quantity ?? 1, price: it.price ?? 0 })).filter(it => it.description);
        if (!items.length) items = [{ description: [(ev.artist || ''), (ev.location || '')].filter(Boolean).join(' · ') || 'שירות', quantity: 1, price: srcDoc.amount != null ? +(Number(srcDoc.amount) / 1.18).toFixed(2) : 0 }];
        let lastDocDate = null;
        try { if (greenInvoice.haveCredentials()) lastDocDate = await greenInvoice.latestDocumentDate(); } catch { /* לא חוסם */ }
        return json(res, { ok: true, items, client: { id: ev.clientId || null, name: ev.clientName || ev.client || '' }, description: '', remarks: '', srcType: Number(srcDoc.type), srcNumber: srcDoc.number, uploaded: true, eventId: ev.id, lastDocDate });
      }
      // חשבונית ישנה עצמאית (לא אירוע)
      let rec = null, rDoc = null;
      for (const r of (db.oldInvoices || [])) {
        const d = (r.linkedDocs || []).find(x => String(x.id) === String(params[0]) && x.uploaded);
        if (d) { rec = r; rDoc = d; break; }
      }
      if (rec) {
        const amt = rDoc.amount != null ? +(Number(rDoc.amount) / 1.18).toFixed(2) : 0;
        const items = [{ description: rec.description || rec.clientName || 'שירות', quantity: 1, price: amt }];
        let lastDocDate = null;
        try { if (greenInvoice.haveCredentials()) lastDocDate = await greenInvoice.latestDocumentDate(); } catch { /* לא חוסם */ }
        return json(res, { ok: true, items, client: { id: rec.clientId || null, name: rec.clientName || '' }, description: rec.description || '', remarks: '', srcType: Number(rDoc.type), srcNumber: rDoc.number, uploaded: true, oldInvoiceId: rec.id, lastDocDate });
      }
    }
  } catch { /* לא חוסם — ננסה כמסמך חשבונית ירוקה */ }
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
  catch (e) { if (isAlreadyClosedErr(e)) return json(res, { ok: true, alreadyClosed: true }); json(res, { error: e.message }, 500); }
});

// POST /api/documents/:id/open — פתיחה מחדש של מסמך סגור
add('POST', /^\/api\/documents\/([^/]+)\/open$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try { json(res, { ok: true, result: await greenInvoice.openDocument(params[0]) }); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// זיכוי מלא — מחזיר את כל האירועים שחויבו ע"י המסמך הזה חזרה ל"ממתין" (לא מחויב), כדי שיופיעו שוב להפקת חשבונית חדשה.
// מסמן את מסמך המקור כ-credited (לא נספר יותר כחיוב), מצרף רשומת מסמך הזיכוי לתיעוד, ומאפס "הלקוח שילם" אם לא נותר חיוב פעיל.
// onlyEventIds (אופציונלי): כשמסופק — מזכה/מחזיר רק את האירועים שנבחרו (זיכוי חלקי לפי אירוע),
// והמסמך המקורי נשאר פתוח ליתר האירועים. ללא הפרמטר — מחזיר את כל האירועים המקושרים (זיכוי מלא).
function revertEventsForCreditedInvoice(db, srcId, credit, onlyEventIds) {
  const REAL = [300, 305, 320, 400];
  const onlySet = Array.isArray(onlyEventIds) && onlyEventIds.length ? new Set(onlyEventIds.map(String)) : null;
  const out = [];
  for (const e of (db.events || [])) {
    const links = Array.isArray(e.linkedDocs) ? e.linkedDocs : [];
    const references = links.some(d => String(d.id) === String(srcId)) || String(e.invoiceId || '') === String(srcId);
    if (!references) continue;
    if (onlySet && !onlySet.has(String(e.id))) continue; // זיכוי חלקי לפי אירוע — מדלגים על אירועים שלא נבחרו
    links.forEach(d => { if (String(d.id) === String(srcId)) d.credited = true; });
    if (credit && credit.id && !links.some(d => String(d.id) === String(credit.id))) {
      // שומרים גם את הסכום: בלעדיו כל הצגה של "ישנו זיכוי על סך X" דורשת
      // משיכה מחשבונית ירוקה, פר-מסמך, בכל טעינת מסך.
      links.push({ id: credit.id, number: credit.number || null, type: 330, credit: true,
        amount: Number(credit.amount != null ? credit.amount : (credit.total != null ? credit.total : 0)) || null });
    }
    e.linkedDocs = links.slice(0, 12);
    const activeReal = e.linkedDocs.filter(d => REAL.includes(Number(d.type)) && !d.converted && !d.credited && !d.credit);
    if (activeReal.length) {
      e.invoiceStatus = 'invoiced';
      let primary = activeReal[0];
      for (const t of [305, 320, 300, 400]) { const d = activeReal.find(x => Number(x.type) === t); if (d) { primary = d; break; } }
      e.invoiceId = primary.id; e.invoiceNumber = primary.number; e.invoiceType = primary.type;
    } else {
      e.invoiceStatus = 'pending'; e.invoiceId = null; e.invoiceNumber = null; e.invoiceType = null;
      delete e.clientPaid; // הזיכוי ביטל את החיוב/תקבול — האירוע חוזר להיות פתוח להפקה
    }
    out.push({ id: e.id, date: e.date || null, artist: e.artist || e.title || '' });
  }
  return out;
}

// האירועים המקושרים למסמך כחיוב פעיל (לא זוכו/הומרו כבר דרכו). משמש גם לבחירת זיכוי חלקי
// וגם לבניית שורות הזיכוי — כדי ששניהם לא ייפרדו זה מזה.
function linkedEventsForDoc(db, srcId) {
  const out = [];
  for (const e of (db.events || [])) {
    const links = Array.isArray(e.linkedDocs) ? e.linkedDocs : [];
    const link = links.find(d => String(d.id) === String(srcId));
    const isActive = String(e.invoiceId || '') === String(srcId) || (link && !link.credited && !link.credit && !link.converted);
    if (!isActive) continue;
    out.push({ id: e.id, date: e.date || e.dateRaw || null, artist: e.artist || e.title || '', location: e.location || '', net: +Number(eventTotal(e)).toFixed(2) });
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}
const _ddmy = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ''); };
// "28/07/26 · בן צור · קריית ים"
const evLabel = (ev) => [_ddmy(ev.date), ev.artist, ev.location].map(x => String(x || '').trim()).filter(Boolean).join(' · ');
const _numHe = (n) => Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 });

// בונה את שורות מסמך הזיכוי ואת תיאור המסמך לפי האירועים המקושרים/שנבחרו.
// reqNet=null → זיכוי מלא. selIds → האירועים שסומנו (זיכוי חלקי לפי אירוע).
// כלל ברזל: הסכום שהתבקש הוא הקובע — לעולם לא מחלקים סכום בין אירועים לבד.
function buildCreditDoc(db, srcId, src, srcType, originalItems, reqNet, selIdsRaw) {
  const kind = srcType === 320 ? 'חשבונית מס-קבלה' : 'חשבונית מס';
  const baseDesc = `זיכוי עבור ${kind} #${src.number}`;
  const fullNet = originalItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  const evs = linkedEventsForDoc(db, srcId);
  const selIds = new Set((Array.isArray(selIdsRaw) ? selIdsRaw : []).map(String).filter(Boolean));
  const line = (desc, price) => ({ description: String(desc).slice(0, 250), quantity: 1, price: +Number(price).toFixed(2) });

  if (reqNet == null) {
    // זיכוי מלא — שורה לכל אירוע, אבל רק אם סכום האירועים מכסה בדיוק את המסמך.
    // אחרת מעתיקים את שורות המקור: ביטול מלא חייב לבטל בדיוק את הסכום המקורי.
    const sum = evs.reduce((t, e) => t + (Number(e.net) || 0), 0);
    // תיאור המסמך המקורי נשאר רק כאן — בזיכוי מלא הוא מדויק, כי כל האירועים מזוכים.
    // בזיכוי חלקי הוא מטעה (מונה אירועים שלא זוכו) ולכן יורד.
    const fullDesc = src.description ? `${baseDesc} — ${src.description}` : baseDesc;
    if (evs.length && Math.abs(sum - fullNet) <= 0.5) {
      return { items: evs.map(e => line(`זיכוי עבור אירוע ${evLabel(e)}`, e.net)), description: fullDesc };
    }
    return { items: originalItems, description: fullDesc };
  }

  const sel = evs.filter(e => selIds.has(String(e.id)));
  // לא סומן אירוע — אין דרך לדעת על מה הזיכוי; נשארים בניסוח הכללי
  if (!sel.length) return { items: [line(`זיכוי חלקי — ${kind} #${src.number}`, reqNet)], description: `זיכוי חלקי — ${baseDesc}` };

  if (sel.length === 1) {
    const e = sel[0];
    const full = Math.abs(reqNet - (Number(e.net) || 0)) <= 0.5;
    return {
      items: [line(full ? `זיכוי עבור אירוע ${evLabel(e)}` : `זיכוי חלקי — אירוע ${evLabel(e)} (מתוך ${_numHe(e.net)} ₪)`, reqNet)],
      description: `זיכוי חלקי — ${baseDesc} — ${evLabel(e)}`,
    };
  }

  const sum = sel.reduce((t, e) => t + (Number(e.net) || 0), 0);
  // הסכום תואם את סך האירועים → שורה נפרדת לכל אירוע
  if (Math.abs(reqNet - sum) <= 0.5) {
    return { items: sel.map(e => line(`זיכוי עבור אירוע ${evLabel(e)}`, e.net)), description: `זיכוי חלקי — ${baseDesc}` };
  }
  // סכום ידני שאינו סך האירועים — שורה אחת שמזכירה את כולם, בסכום שנכתב
  return { items: [line(`זיכוי חלקי — ${sel.map(evLabel).join(' + ')}`, reqNet)], description: `זיכוי חלקי — ${baseDesc}` };
}

// GET /api/documents/:id/events — האירועים המקושרים למסמך (לבחירת זיכוי חלקי לפי אירוע)
add('GET', /^\/api\/documents\/([^/]+)\/events$/, async (req, res, params) => {
  json(res, { ok: true, events: linkedEventsForDoc(load(), params[0]) });
});

// POST /api/documents/:id/credit-preview { date?, amount?, skipDateValidation? } — תצוגה מקדימה מעוצבת (PDF) של חשבונית הזיכוי, ללא יצירה
add('POST', /^\/api\/documents\/([^/]+)\/credit-preview$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const src = await greenInvoice.getDocument(params[0]);
    const srcType = Number(src.type);
    if (![305, 320].includes(srcType)) return json(res, { error: 'זיכוי אפשרי רק מחשבונית מס או חשבונית מס-קבלה' }, 400);
    const client = src.client?.id ? { id: src.client.id } : { name: src.client?.name || 'לקוח' };
    const items = (src.income || []).map(it => ({ description: it.description, quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 })).filter(it => it.description && String(it.description).trim());
    if (!items.length) return json(res, { error: 'אין שורות במסמך המקור' }, 400);
    const date = body && body.date ? String(body.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const skipDateValidation = Boolean(body && body.skipDateValidation);
    // אותה לוגיקת שורות בדיוק כמו בהפקה האמיתית — כדי שהתצוגה תשקף את המסמך שייווצר
    const fullNet = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
    const reqNet = (body && body.amount != null && Number(body.amount) > 0) ? +Number(body.amount).toFixed(2) : null;
    const isPartial = reqNet != null && reqNet < fullNet - 0.5;
    // אותן שורות ותיאור בדיוק כמו בהפקה האמיתית — התצוגה חייבת לשקף את המסמך שייווצר
    const built = buildCreditDoc(load(), params[0], src, srcType, items, isPartial ? reqNet : null, (body && (body.eventIds || body.revertEventIds)) || []);
    const opts = { type: 330, client, items: built.items, date, skipDateValidation, description: built.description };
    let pv;
    try { pv = await greenInvoice.previewDocument(opts); }
    catch (e) {
      if (/2405|עתידי|מוקדם|תאריך|\bdate\b/i.test(String(e.message || ''))) { opts.date = new Date().toISOString().slice(0, 10); pv = await greenInvoice.previewDocument(opts); }
      else throw e;
    }
    let pdfBase64 = pv.pdfBase64 || null;
    if (!pdfBase64 && pv.url) { const fr = await fetch(pv.url, { redirect: 'follow' }).catch(() => null); if (fr && fr.ok) pdfBase64 = Buffer.from(await fr.arrayBuffer()).toString('base64'); }
    if (!pdfBase64) return json(res, { error: 'לא התקבלה תצוגה מקדימה', debug: pv.raw || null });
    json(res, { ok: true, pdfBase64, partial: isPartial, creditedNet: isPartial ? reqNet : fullNet });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/documents/:id/credit { date?, revertEvents?, revertEventIds? } — הפקת זיכוי
//   חשבונית מס (305) → חשבונית זיכוי אחת (330, linkType cancel)
//   חשבונית מס-קבלה (320) → זיכוי דו-שלבי: חשבונית זיכוי (330) + קבלה שלילית (400 עם תקבול שלילי)
//   זיכוי מלא (ברירת מחדל) מחזיר את האירועים ל"ממתין". revertEvents:false = זיכוי חלקי (לא משנה סטטוס אירועים).
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
    const skipDateValidation = Boolean(body && body.skipDateValidation); // הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון)

    // זיכוי חלקי: אם התבקש סכום (לפני מע"מ) קטן מסך המסמך — מזכים רק אותו, בשורה אחת, בלי לבטל את המקור ובלי להחזיר אירועים.
    const fullNet = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
    const reqNet = (body && body.amount != null && Number(body.amount) > 0) ? +Number(body.amount).toFixed(2) : null;
    const isPartial = reqNet != null && reqNet < fullNet - 0.5;
    const built = buildCreditDoc(load(), params[0], src, srcType, items, isPartial ? reqNet : null, (body && (body.revertEventIds || body.eventIds)) || []);

    // שלב 1 — חשבונית זיכוי (330). זיכוי מלא מקושר כ"ביטול"; זיכוי חלקי מקושר כקישור רגיל (לא מבטל את המקור).
    const credit = await createDocFwd({
      type: 330, client, items: built.items, date, skipDateValidation,
      description: built.description,
      linkedDocumentIds: [params[0]], ...(isPartial ? {} : { linkType: 'cancel' }),
    });

    // החזרת אירועים ל"ממתין":
    //  • revertEventIds (זיכוי חלקי לפי אירוע) — מחזיר רק את האירועים שנבחרו, גם כשהמסמך נשאר פתוח ליתר.
    //  • אחרת: זיכוי מלא מחזיר את כל האירועים; זיכוי חלקי-לפי-סכום אינו משנה סטטוס אירועים.
    let revertedEvents = [];
    const revertIds = Array.isArray(body && body.revertEventIds) ? body.revertEventIds.map(String).filter(Boolean) : null;
    if (revertIds && revertIds.length) {
      const _db = load();
      revertedEvents = revertEventsForCreditedInvoice(_db, params[0], credit, revertIds);
      if (revertedEvents.length) save(_db);
    } else if (!isPartial && !(body && body.revertEvents === false)) {
      const _db = load();
      revertedEvents = revertEventsForCreditedInvoice(_db, params[0], credit);
      if (revertedEvents.length) save(_db);
    }

    if (srcType === 305) return json(res, { ok: true, mode: 'single', credit, revertedEvents, partial: isPartial, creditedNet: isPartial ? reqNet : fullNet });

    // שלב 2 (רק ל-320) — קבלה שלילית לביטול חלק התקבול
    const srcPay = Array.isArray(src.payment) ? src.payment : [];
    const negPayment = isPartial
      ? [{ type: 4, price: -Math.abs(+(reqNet * 1.18).toFixed(2)), date, currency: 'ILS' }]  // ביטול חלקי של התקבול לפי הסכום שנבחר + מע"מ
      : (srcPay.length ? srcPay : [{ type: 4, price: Number(src.amount) || 0 }]).map(p => {
        const row = { type: Number(p.type) || 4, price: -Math.abs(Number(p.price) || 0), date, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if (Number(p.type) === 4 && p.bankName) row.bankName = String(p.bankName);
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    const negativeReceipt = await createDocFwd({
      type: 400, client, items: [], payment: negPayment, date, skipDateValidation,
      description: `${isPartial ? 'ביטול חלקי של קבלה' : 'ביטול קבלה'} — חשבונית מס-קבלה #${src.number}`,
    });
    json(res, { ok: true, mode: 'two-stage', credit, negativeReceipt, revertedEvents, partial: isPartial, creditedNet: isPartial ? reqNet : fullNet });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/url — קישור לקובץ המסמך (PDF) בחשבונית ירוקה, לפתיחה/הורדה
// GET /api/documents/:id/download — הורדה אמיתית של המסמך כקובץ (Content-Disposition: attachment).
// קיים בנפרד מ-/url כי הקישור של חשבונית ירוקה הוא חיצוני: הדפדפן רק *פותח* אותו בטאב במקום להוריד,
// ואי אפשר למשוך אותו מהצד של הדפדפן בגלל CORS. כאן השרת מושך ומגיש כהורדה מאותו דומיין.
add('GET', /^\/api\/documents\/([^/]+)\/download$/, async (req, res, params, q) => {
  const id = params[0];
  const asName = (base, ext) => encodeURIComponent(String(base || 'מסמך').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) + '.' + ext);
  const label = String((q && q.name) || DOC_NAMES_HE[Number(q && q.type)] || 'מסמך') + ((q && q.number) ? '-' + String(q.number) : '');
  // מסמך שהועלה ידנית — מהאחסון המקומי, בכפוף לאותה בדיקת הרשאה של /api/files/:id
  try {
    const f = await getFile(id);
    if (f) {
      if (!mayReadFile(req, f, id)) return json(res, { error: 'אין הרשאה לקובץ זה' }, 403);
      const buf = Buffer.from(f.data, 'base64');
      const ext = /pdf/i.test(f.mime || '') ? 'pdf' : (/png/i.test(f.mime || '') ? 'png' : (/jpe?g/i.test(f.mime || '') ? 'jpg' : 'pdf'));
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/pdf',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${asName(f.filename ? f.filename.replace(/\.[^.]+$/, '') : label, ext)}`,
      });
      return res.end(buf);
    }
  } catch { /* לא קובץ מקומי — ננסה חשבונית ירוקה */ }
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const pdf = await greenInvoice.getDocumentPdf(id);
    const buf = Buffer.from(pdf.base64, 'base64');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${asName(label, 'pdf')}`,
    });
    res.end(buf);
  } catch (e) { json(res, { error: e.message }, 500); }
});

add('GET', /^\/api\/documents\/([^/]+)\/url$/, async (req, res, params) => {
  // מסמך שהועלה ידנית (חשבונית ישנה) — מוגש מהאחסון המקומי, ולא מחשבונית ירוקה
  try { const f = await getFile(params[0]); if (f) return json(res, { ok: true, url: '/api/files/' + params[0], status: 1, type: null, uploaded: true }); } catch {}
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const raw = await greenInvoice.getDocument(params[0]);
    const url = (raw.url && (raw.url.he || raw.url.origin || raw.url.pdf)) || (typeof raw.url === 'string' ? raw.url : null);
    if (!url) return json(res, { error: 'לא נמצא קובץ למסמך זה' }, 404);
    // status: 0=פתוח, 1=סגור/הומר, ... — משמש להצגת אופציית "מסמך המשך" רק כשהמסמך פתוח
    json(res, { ok: true, url, status: Number(raw.status), type: Number(raw.type), number: raw.number });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/related — כל המסמכים המקושרים לאותו מסמך (שרשרת: הצעת מחיר→עסקה→מס→קבלה + זיכויים)
// לוגיקה: BFS על linkedDocumentIds של חשבונית ירוקה (לאב־קדמונים ולצאצאים אם דו־כיווני) + "אחאים" מאותו אירוע/חשבונית-ישנה (linkedDocs).
add('GET', /^\/api\/documents\/([^/]+)\/related$/, async (req, res, params) => {
  const startId = String(params[0]);
  const db = load();
  const meta = new Map();     // id -> { id, type, number, date, amount, status, url, uploaded, linkedIds }
  const giCache = new Map();
  const getGi = async (id) => {
    if (giCache.has(id)) return giCache.get(id);
    let d = null;
    if (greenInvoice.haveCredentials()) { try { d = await greenInvoice.getDocument(id); } catch { d = null; } }
    giCache.set(id, d);
    return d;
  };
  // מטא־דאטה למסמך שהועלה ידנית (אינו בחשבונית ירוקה) מתוך linkedDocs באירוע/חשבונית ישנה
  const uploadedMeta = (id) => {
    for (const ev of (db.events || [])) {
      const d = (ev.linkedDocs || []).find(x => String(x.id) === String(id) && x.uploaded);
      if (d) return { id: String(id), type: d.type != null ? Number(d.type) : null, number: d.number || null, date: d.date || ev.date || ev.dateRaw || null, amount: d.amount != null ? Number(d.amount) : null, status: null, url: d.url || ('/api/files/' + id), uploaded: true };
    }
    for (const rec of (db.oldInvoices || [])) {
      const d = (rec.linkedDocs || []).find(x => String(x.id) === String(id) && x.uploaded);
      if (d) return { id: String(id), type: d.type != null ? Number(d.type) : null, number: d.number || null, date: d.date || rec.createdAt || null, amount: d.amount != null ? Number(d.amount) : null, status: null, url: d.url || ('/api/files/' + id), uploaded: true };
    }
    return null;
  };
  const addMeta = async (id) => {
    id = String(id);
    if (meta.has(id)) return meta.get(id);
    let f = null; try { f = await getFile(id); } catch { }
    if (f) { const um = uploadedMeta(id) || { id, type: null, number: null, date: null, amount: null, status: null, url: '/api/files/' + id, uploaded: true }; meta.set(id, um); return um; }
    const d = await getGi(id);
    if (!d) { const um = uploadedMeta(id); if (um) { meta.set(id, um); return um; } const m = { id, missing: true, linkedIds: [] }; meta.set(id, m); return m; }
    const url = (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null);
    const amt = d.amount != null ? Number(d.amount) : (d.total != null ? Number(d.total) : (d.sum != null ? Number(d.sum) : null));
    const m = { id, type: Number(d.type), number: d.number, date: d.documentDate || null, amount: amt, status: Number(d.status), url, uploaded: false, linkedIds: (Array.isArray(d.linkedDocumentIds) ? d.linkedDocumentIds.map(String) : []) };
    meta.set(id, m); return m;
  };
  const visited = new Set();
  const runBfs = async () => {
    let guard = 0;
    while (queue.length && guard < 60) {
      guard++;
      const cur = String(queue.shift());
      if (visited.has(cur)) continue;
      visited.add(cur);
      const m = await addMeta(cur);
      for (const l of ((m && m.linkedIds) || [])) if (!visited.has(String(l))) queue.push(String(l));
    }
  };
  const queue = [startId];
  await runBfs();
  // "אחאים" — כל אירוע/חשבונית־ישנה שמכיל מסמך מהשרשרת: כל שאר המסמכים שלו שייכים לאותה שרשרת
  const collectSiblings = (arr) => {
    for (const rec of (arr || [])) {
      const lds = Array.isArray(rec.linkedDocs) ? rec.linkedDocs : [];
      if (lds.some(x => x && x.id && visited.has(String(x.id)))) {
        for (const x of lds) if (x && x.id && !visited.has(String(x.id))) queue.push(String(x.id));
      }
    }
  };
  collectSiblings(db.events);
  collectSiblings(db.oldInvoices);
  await runBfs();
  const rank = { 10: 1, 100: 2, 200: 3, 300: 4, 305: 5, 320: 6, 400: 7, 330: 8, 405: 9 };
  const docs = [...meta.values()].filter(m => !m.missing).map(m => ({ id: m.id, type: m.type, number: m.number, date: m.date, amount: m.amount, status: m.status, url: m.url, uploaded: !!m.uploaded, self: String(m.id) === startId }));
  docs.sort((a, b) => (rank[a.type] || 99) - (rank[b.type] || 99) || String(a.date || '').localeCompare(String(b.date || '')));
  json(res, { ok: true, id: startId, docs });
});

// POST /api/documents/:id/send { email? } — שליחת מסמך קיים במייל דרך חשבונית ירוקה
add('POST', /^\/api\/documents\/([^/]+)\/send$/, async (req, res, params, q, body) => {
  // תמיכה במספר כתובות (email/email2/emails[]) — נשלח מייל אחד לכולן
  const _rawEmails = [];
  if (body) {
    if (Array.isArray(body.emails)) body.emails.forEach(e => _rawEmails.push(String(e || '').trim()));
    if (body.email) _rawEmails.push(String(body.email).trim());
    if (body.email2) _rawEmails.push(String(body.email2).trim());
  }
  const _isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const emailsIn = [...new Set(_rawEmails.filter(_isEmail))];
  const email0 = emailsIn[0] || '';
  const _cid = (q && q.companyId) || (body && body.companyId) || undefined;
  // מסמך שהועלה ידנית (אינו בחשבונית ירוקה) — שולחים את הקובץ עצמו במייל דרך SMTP
  try {
    const f = await getFile(params[0]);
    if (f) {
      const _db = load();
      const creds = companyMailCreds(_db, _cid || giCompanyId());
      if (!emailsIn.length) return json(res, { error: 'אין כתובת מייל ללקוח — יש להזין כתובת' }, 400);
      if (!mailer.companyMailConfigured(creds) && !mailer.mailerConfigured()) return json(res, { error: 'לחברה זו אין חשבון מייל מוגדר — הגדר חשבון מייל בפרטי העסק.' }, 400);
      const content = Buffer.from(String(f.data || ''), 'base64');
      const _ucid = _cid || giCompanyId();
      const body = mailBodyFor(_db, _ucid, { clientName: '', num: '', docType: 'מסמך' });
      const subj = mailSubjectFor(_db, _ucid, { clientName: '', num: '', docType: 'מסמך' });
      await mailer.sendMailFrom(creds, { to: emailsIn, subject: subj, text: body, html: htmlBodyWithSig(_db, _ucid, body), attachments: [{ filename: f.filename || 'document.pdf', content }] });
      return json(res, { ok: true, sentTo: emailsIn, uploaded: true });
    }
  } catch {}
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    let emails = emailsIn.slice();   // כתובות שהוזנו ידנית (עד 2) — נשלח מייל אחד לכולן
    let docMeta = null;
    // ברירת מחדל — כתובות המייל השמורות ללקוח במסמך (וגם משמש לשם הקובץ/כותרת ב-fallback)
    try { docMeta = await greenInvoice.getDocument(params[0]); } catch { }
    if (!emails.length) {
      const ce = (docMeta && docMeta.client && docMeta.client.emails) || [];
      emails = [...new Set((Array.isArray(ce) ? ce : []).map(e => String(e || '').trim()).filter(e => _isEmail(e)))];
    }
    if (!emails.length) return json(res, { error: 'אין כתובת מייל ללקוח — יש להזין כתובת' }, 400);
    const num = (docMeta && (docMeta.number != null ? docMeta.number : docMeta.docNumber)) || '';
    const _db = load();
    const _mcid = _cid || giCompanyId();
    const creds = companyMailCreds(_db, _mcid);
    const clientName = (docMeta && docMeta.client && (docMeta.client.name || docMeta.client.fullName)) || '';
    const docTypeHe = DOC_NAMES_HE[Number(docMeta && docMeta.type)] || 'מסמך';
    const subject = mailSubjectFor(_db, _mcid, { clientName, num, docType: docTypeHe });
    const text = mailBodyFor(_db, _mcid, { clientName, num, docType: docTypeHe });
    const htmlBody = htmlBodyWithSig(_db, _mcid, text);   // גוף RTL + חתימת החברה
    const pdfAttach = async () => { const pdf = await greenInvoice.getDocumentPdf(params[0]); return [{ filename: `document-${String(num || params[0]).replace(/[^\w.-]/g, '_')}.pdf`, content: Buffer.from(pdf.base64, 'base64') }]; };
    // אם לחברה יש חשבון מייל משלה (Gmail) — שולחים ממנו ישירות (המייל יוצא מהתיבה של החברה), עם ה-PDF מצורף
    if (mailer.companyMailConfigured(creds)) {
      await mailer.sendMailFrom(creds, { to: emails, subject, text, html: htmlBody, attachments: await pdfAttach() });
      return json(res, { ok: true, sentTo: emails, viaCompanyMail: true });
    }
    // אחרת: ניסיון שליחה ישירה דרך חשבונית ירוקה; אם נכשל — חשבון SMTP כללי (עם שם החברה)
    try {
      const r = await greenInvoice.sendDocument(params[0], emails);
      return json(res, { ok: true, sentTo: emails, result: r });
    } catch (giErr) {
      if (!mailer.mailerConfigured()) return json(res, { error: `שליחה דרך חשבונית ירוקה נכשלה (${giErr.message}) — ולחברה זו אין חשבון מייל מוגדר. הגדר חשבון מייל בפרטי העסק.` }, 502);
      await mailer.sendMailFrom(creds, { to: emails, subject, text, html: htmlBody, attachments: await pdfAttach() });
      return json(res, { ok: true, sentTo: emails, viaSmtp: true });
    }
  } catch (e) { json(res, { error: e.message }, 500); }
});

// ============ בדיקת סטטוס תשלום מול הלקוח ============
// בונה את נוסח המייל לפי מספר החשבוניות. הניסוח נקבע ע"י המנהל — אין לשנות מבנה או סגנון.
function paymentStatusMail(companyName, count) {
  const one = count === 1;
  return {
    subject: `חשבוניות פתוחות – בירור מועד תשלום | ${companyName}`,
    text: [
      'היי, מה נשמע?',
      '',
      one ? 'מצורפת למייל זה החשבונית הפתוחה מולכם.' : 'מצורפות למייל זה החשבוניות הפתוחות מולכם.',
      '',
      one ? 'נשמח לעדכון לגבי מועד התשלום הצפוי עבור החשבונית המצורפת.'
          : 'נשמח לעדכון לגבי מועד התשלום הצפוי עבור החשבוניות המצורפות.',
      '',
      'במידה ונדרש מאיתנו מסמך, אישור או פרט נוסף לצורך ביצוע התשלום, נשמח להעביר בהקדם.',
      '',
      'תודה רבה,',
      companyName,
    ].join('\n'),
  };
}
// POST /api/payment-status/send — שולח בירור מועד תשלום ללקוח עם החשבוניות הפתוחות מצורפות
// { docs:[{id, number, type, uploaded}], emails:[...], companyName }
add('POST', /^\/api\/payment-status\/send$/, async (req, res, _p, q, body) => {
  const b = body || {};
  const cid = reqCompany(q, b);
  const docs = Array.isArray(b.docs) ? b.docs.slice(0, 20) : [];
  const _isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map(e => String(e || '').trim()).filter(_isEmail))];
  if (!docs.length) return json(res, { error: 'לא נבחרו חשבוניות' }, 400);
  if (!emails.length) return json(res, { error: 'אין כתובת מייל ללקוח — יש להזין כתובת' }, 400);
  const db = load();
  const creds = companyMailCreds(db, cid);
  if (!mailer.companyMailConfigured(creds) && !mailer.mailerConfigured()) {
    return json(res, { error: 'לחברה זו אין חשבון מייל מוגדר — הגדר חשבון מייל בפרטי העסק.' }, 400);
  }
  const comp = (db.companies || []).find(c => c.id === cid);
  const companyName = String(b.companyName || bizProfile(db, cid).name || (comp && comp.name) || '').trim();
  // איסוף הקבצים: מסמך מחשבונית ירוקה → PDF דרך ה-API; מסמך שהועלה ידנית → מהאחסון המקומי
  const attachments = [];
  const failed = [];
  for (const d of docs) {
    const label = `${DOC_NAMES_HE[Number(d.type)] || 'מסמך'}-${String(d.number || d.id).replace(/[^\w.-]/g, '_')}`;
    try {
      if (d.uploaded) {
        const f = await getFile(d.id);
        if (!f || !f.data) { failed.push(d.number || d.id); continue; }
        attachments.push({ filename: f.filename || `${label}.pdf`, content: Buffer.from(f.data, 'base64'), contentType: f.mime || 'application/pdf' });
      } else {
        const pdf = await greenInvoice.getDocumentPdf(d.id);
        attachments.push({ filename: `${label}.pdf`, content: Buffer.from(pdf.base64, 'base64'), contentType: 'application/pdf' });
      }
    } catch (e) { failed.push(d.number || d.id); }
  }
  if (!attachments.length) return json(res, { error: 'לא ניתן היה לצרף אף חשבונית' + (failed.length ? ` (${failed.join(', ')})` : '') }, 502);
  const { subject, text } = paymentStatusMail(companyName, attachments.length);
  // אותו עוטף HTML כמו בכל שאר המיילים היוצאים — RTL + חתימת החברה מפרטי העסק
  const html = htmlBodyWithSig(db, cid, text);
  try {
    await mailer.sendMailFrom(creds, { to: emails, subject, text, html, attachments });
    json(res, { ok: true, sentTo: emails, attached: attachments.length, failed });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// תווית חודש בעברית מ-YYYY-MM → "יולי 2026"
const _MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
function monthLabelHe(month) {
  const m = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(month || '');
  const idx = Number(m[2]) - 1;
  return `${_MONTHS_HE[idx] || m[2]} ${m[1]}`;
}

// POST /api/payroll/send-report?companyId= { month, attachments:[{filename, base64}] }
// שולח לרו"ח (payrollEmail של החברה) מייל עם PDF נפרד לכל עובד — פירוט עבודות חודשי.
add('POST', /^\/api\/payroll\/send-report$/, async (req, res, _p, q, body) => {
  const b = body || {};
  const cid = (q && q.companyId) || b.companyId || giCompanyId();
  const month = String(b.month || '').trim();
  const db = load();
  const p = bizProfile(db, cid);
  const to = String(p.payrollEmail || '').trim();
  const _isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  if (!_isEmail(to)) return json(res, { error: 'לא הוגדר מייל לשליחת פירוט עבודות — הגדר אותו בפרטי העסק.' }, 400);
  const atts = Array.isArray(b.attachments) ? b.attachments : [];
  if (!atts.length) return json(res, { error: 'אין קבצים לשליחה — אין עובדים עם עבודות בחודש זה.' }, 400);
  const creds = companyMailCreds(db, cid);
  if (!mailer.companyMailConfigured(creds) && !mailer.mailerConfigured()) {
    return json(res, { error: 'לחברה זו אין חשבון מייל מוגדר — הגדר חשבון מייל (Gmail App Password) בפרטי העסק.' }, 400);
  }
  const comp = (db.companies || []).find(c => c.id === cid);
  const companyName = (p.name || (comp && comp.name) || '').trim();
  const label = monthLabelHe(month);
  const subject = `${companyName} - פירוט עבודות ${label} - תלושי משכורת`;
  const text = `היי מה נשמע?\nמצרף לכאן את פירוט העבודות לחודש ${label}`;
  // גוף HTML מיושר לימין (עברית) + חתימת המייל (חותמת) בתחתית אם הוגדרה
  const sig = String(p.emailSignature || '').trim();
  const html = `<div dir="rtl" style="text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1c2333">`
    + `<div>היי מה נשמע?</div><div>מצרף לכאן את פירוט העבודות לחודש ${label}</div>`
    + (sig ? `<br><div dir="rtl" style="text-align:right">${sig}</div>` : '')
    + `</div>`;
  const attachments = atts.map((a, i) => ({
    filename: String(a.filename || `פירוט עבודות ${i + 1}.pdf`),
    content: Buffer.from(String(a.base64 || ''), 'base64'),
    contentType: 'application/pdf',
  })).filter(a => a.content && a.content.length);
  if (!attachments.length) return json(res, { error: 'הקבצים ריקים.' }, 400);
  const totalBytes = attachments.reduce((s, a) => s + a.content.length, 0);
  if (totalBytes > 23 * 1024 * 1024) return json(res, { error: `הקבצים כבדים מדי לשליחה במייל (${Math.round(totalBytes / 1048576)}MB, המגבלה ~25MB). נסה לשלוח פחות עובדים בבת אחת או פנה אליי.` }, 413);
  try {
    await mailer.sendMailFrom(creds, { to, subject, text, html, attachments });
    json(res, { ok: true, to, count: attachments.length, subject });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/email/test-signature?companyId= { to } — מייל דוגמה (גוף RTL + חתימת החברה), לבדיקה
add('POST', /^\/api\/email\/test-signature$/, async (req, res, _p, q, body) => {
  const b = body || {};
  const cid = (q && q.companyId) || b.companyId || giCompanyId();
  const to = String(b.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(res, { error: 'כתובת מייל לא תקינה' }, 400);
  const db = load();
  const p = bizProfile(db, cid);
  const comp = (db.companies || []).find(c => c.id === cid);
  const companyName = (p.name || (comp && comp.name) || '').trim();
  const creds = companyMailCreds(db, cid);
  if (!mailer.companyMailConfigured(creds) && !mailer.mailerConfigured()) return json(res, { error: 'לחברה זו אין חשבון מייל מוגדר' }, 400);
  const subject = `דוגמת מייל — ${companyName}`;
  const text = `היי מה נשמע?\nזהו מייל דוגמה לבדיקת החתימה והיישור לימין (RTL).`;
  const html = htmlBodyWithSig(db, cid, text);
  try {
    await mailer.sendMailFrom(creds, { to, subject, text, html });
    json(res, { ok: true, to, company: companyName, from: creds.user || '(default)', hasSignature: !!emailSigHtml(db, cid) });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/documents/:id/client-email — כתובות המייל השמורות ללקוח על המסמך (למילוי אוטומטי בחלונית השליחה)
add('GET', /^\/api\/documents\/([^/]+)\/client-email$/, async (req, res, params) => {
  // מסמך שהועלה ידנית — אין לקוח בחשבונית ירוקה
  try { const f = await getFile(params[0]); if (f) return json(res, { ok: true, emails: [], clientName: '' }); } catch {}
  if (!greenInvoice.haveCredentials()) return json(res, { ok: false, emails: [] });
  try {
    const doc = await greenInvoice.getDocument(params[0]);
    const ce = (doc && doc.client && doc.client.emails) || [];
    let emails = (Array.isArray(ce) ? ce : []).map(String).map(s => s.trim()).filter(Boolean);
    // אם אין מיילים על המסמך עצמו — נופלים לכתובות השמורות בכרטיס הלקוח (getClient), כדי שהמילוי האוטומטי יעבוד גם בזיכוי
    if (!emails.length && doc && doc.client && doc.client.id) {
      try {
        const cl = await greenInvoice.getClient(doc.client.id);
        const ce2 = (cl && cl.emails) || [];
        emails = (Array.isArray(ce2) ? ce2 : []).map(String).map(s => s.trim()).filter(Boolean);
      } catch { /* לא חוסם */ }
    }
    json(res, { ok: true, emails, clientName: (doc && doc.client && doc.client.name) || '' });
  } catch (e) { json(res, { ok: false, emails: [], error: e.message }); }
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
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = { amount: Number(body.discount.amount), type: body.discount.type };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.skipDateValidation) opts.skipDateValidation = true; // אישור הפקה מחוץ לרצף (תאריך מוקדם מהמסמך האחרון מסוגו)
    // תקבולים ערוכים (למסמכי מס-קבלה/קבלה) — סוג + סכום + תאריך + פרטים
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum); // צ'ק
        // פרטי חשבון המשלם (העברה בנקאית / צ'ק): בנק, סניף, חשבון — כמו בחשבונית ירוקה
        if ([2, 4].includes(Number(p.type))) {
          if (p.bankName) row.bankName = String(p.bankName).replace(/\s*\(\d+\)\s*$/, '').trim(); // מנקים "(קוד)" מהשם
          if (p.bankBranch) row.bankBranch = String(p.bankBranch);
          if (p.bankAccount) row.bankAccount = String(p.bankAccount);
        }
        return row;
      }).filter(p => Math.abs(p.price) > 0); // מתעלמים משורות תקבול ריקות
    }
    if (body.linked) {
      opts.linkedDocumentIds = [params[0]]; // מסמך המשך — קישור למקור
      // שורת "מסמך המשך ל..." תמיד מופיעה. פרטי הבנק/ההערה הקבועה נוספים ע"י documentBody.
      const ref = followupRemarks(src.type, src.number);
      const cur = (body.remarks != null) ? String(body.remarks).trim() : '';
      opts.remarks = cur.includes(ref) ? cur : (cur ? `${ref}\n\n${cur}` : ref);
    }
    const doc = await createDocFwd(opts);
    json(res, { ok: true, doc });
  } catch (e) {
    const msg = String(e.message || '');
    if (/2405|עתידי|מוקדם/i.test(msg)) {
      let minDate = null; try { minDate = await greenInvoice.latestDocumentDate(Number(body.type)); } catch { /* לא חוסם */ }
      const dmy = minDate ? minDate.split('-').reverse().join('/') : '';
      return json(res, { error: `חשבונית ירוקה חוסמת תאריך מוקדם מהמסמך האחרון מסוג זה${minDate ? ` (${dmy})` : ''}. בחר תאריך זה או מאוחר יותר, או סמן "אפשר תאריך מוקדם מזה (הפקה מחוץ לרצף)" כדי להפיק בכל זאת.`, minDate }, 400);
    }
    json(res, { error: msg }, 500);
  }
});

// טלפון ישראלי → ספרות בפורמט בינלאומי (972...) עבור קישור wa.me
function ilPhoneDigits(p) {
  if (!p) return null;
  let d = String(p).replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  if (d.length === 9 || d.length === 10) return '972' + d.replace(/^0/, '');
  return d;
}
// GET /api/documents/:id/whatsapp[?phone=] — בונה קישור wa.me מוכן לשליחת המסמך ללקוח בוואטסאפ (לחיצה אחת, מהמספר של המשתמש)
add('GET', /^\/api\/documents\/([^/]+)\/whatsapp$/, async (req, res, params, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { ok: false, error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const doc = await greenInvoice.getDocument(params[0]);
    const clientId = doc.client?.id || null;
    const clientName = doc.client?.name || '';
    let phone = q.phone || doc.client?.phone || null;
    if (!phone && clientId) { try { const cls = await greenInvoice.listClients(); const c = cls.find(x => x.id === clientId); phone = c?.phone || null; } catch { } }
    const typeName = ({ 10: 'הצעת מחיר', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 330: 'חשבונית זיכוי' })[Number(doc.type)] || 'מסמך';
    const number = doc.number || '';
    const amount = Number(doc.amount ?? doc.total ?? doc.sum ?? 0);
    const url = (doc.url && (doc.url.he || doc.url.origin || doc.url.pdf)) || (typeof doc.url === 'string' ? doc.url : '');
    let bizName = ''; try { bizName = ((load().businessProfiles || {})[q.companyId] || {}).name || ''; } catch { }
    const amt = amount ? `${amount.toLocaleString('he-IL')} ₪` : '';
    const text = `שלום${clientName ? ' ' + clientName : ''}, מצורפת ${typeName}${number ? ` מס' ${number}` : ''}${amt ? ` על סך ${amt}` : ''}.`
      + (url ? `\nלצפייה והורדה: ${url}` : '') + (bizName ? `\nתודה, ${bizName}` : '');
    const digits = ilPhoneDigits(phone);
    // שני קישורים: wa.me פותח את האפליקציה (טלפון), web.whatsapp.com נכנס ישירות
    // לווטסאפ ווב המחובר בדפדפן בלי מסך ביניים. הפרונט בוחר לפי המכשיר.
    const enc = encodeURIComponent(text);
    const waUrl = digits ? `https://wa.me/${digits}?text=${enc}` : null;
    const waWebUrl = digits ? `https://web.whatsapp.com/send?phone=${digits}&text=${enc}` : null;
    json(res, { ok: true, phone: phone || null, waUrl, waWebUrl, text, clientName,
      docType: Number(doc.type) || null, docNumber: number || null });
  } catch (e) { json(res, { ok: false, error: e.message }, 500); }
});

// POST /api/documents/consolidate — מסמך מרוכז: כמה חשבוניות עסקה (300) של אותו לקוח → מסמך מס (305) או מס-קבלה (320) מסכם אחד
// { sourceIds:[...], type:305|320, date?, items?(ערוכות), discount?, payment?(ל-320), remarks?, sendEmail?, email?, skipDateValidation? }
// המסמך המסכם מקושר לכל מקורות ה-300 (linkedDocumentIds) → כל העסקאות נסגרות בחשבונית ירוקה; אירועים מקושרים מסומנים.
add('POST', /^\/api\/documents\/consolidate$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(String).filter(Boolean) : [];
  // מקורות שהועלו ידנית (אופק) — אינם קיימים בחשבונית ירוקה, לכן ייסגרו אצלנו (converted) במקום דרך linkedDocumentIds
  const uploadedSources = Array.isArray(body.uploadedSources) ? body.uploadedSources.filter(u => u && (u.eventId || u.oldInvoiceId) && u.docId != null) : [];
  if (sourceIds.length + uploadedSources.length < 1) return json(res, { error: 'לא נבחרו חשבוניות עסקה למיזוג' }, 400);
  const type = Number(body.type);
  if (![305, 320].includes(type)) return json(res, { error: 'סוג מסמך מסכם חייב להיות חשבונית מס (305) או מס-קבלה (320)' }, 400);
  try {
    // שליפת מסמכי המקור — לאימות לקוח אחיד ולאיסוף שורות
    const srcDocs = [];
    for (const sid of sourceIds) { srcDocs.push(await greenInvoice.getDocument(sid)); }
    // כל המקורות חייבים להיות חשבון עסקה (300) פתוח, ושל אותו לקוח
    const badType = srcDocs.find(d => Number(d.type) !== 300);
    if (badType) return json(res, { error: `ניתן למזג רק חשבוניות עסקה (300). מסמך #${badType.number || ''} אינו עסקה.` }, 400);
    const clientIds = [...new Set(srcDocs.map(d => d.client?.id).filter(Boolean))];
    const clientNames = [...new Set(srcDocs.map(d => (d.client?.name || '').trim()).filter(Boolean))];
    if (clientIds.length > 1 || (!clientIds.length && clientNames.length > 1)) {
      return json(res, { error: 'כל חשבוניות העסקה שנבחרו חייבות להיות של אותו לקוח.' }, 400);
    }
    // לקוח: קודם מזהה מחשבונית ירוקה; אחרת clientId/clientName שנשלחו (למקרה של מקורות שהועלו ידנית בלבד)
    const client = clientIds[0] ? { id: clientIds[0] }
      : (body.clientId ? { id: body.clientId }
        : { name: (clientNames[0] || String(body.clientName || '').trim() || 'לקוח'), add: true });
    // שורות: ערוכות מהלקוח אם נשלחו, אחרת איחוד שורות כל מסמכי המקור
    let items;
    if (Array.isArray(body.items) && body.items.length) {
      items = body.items.map(it => ({ catalogNum: it.catalogNum || undefined, description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }));
    } else {
      items = [];
      for (const d of srcDocs) { for (const it of (d.income || [])) { items.push({ catalogNum: it.catalogNum || undefined, description: String(it.description || '').trim(), quantity: Number(it.quantity) || 1, price: Number(it.price) || 0 }); } }
    }
    items = items.filter(it => it.description);
    if (!items.length) return json(res, { error: 'אין שורות למסמך המסכם' }, 400);
    // הערת קישור מרוכזת — מפרטת את מספרי מסמכי המקור
    const nums = srcDocs.map(d => '#' + (d.number || d.id))
      .concat(uploadedSources.map(u => '#' + (u.number || u.docId))).join(', ');
    const ref = `מסמך מרוכז לחשבוניות עסקה: ${nums}`;
    const cur = (body.remarks != null) ? String(body.remarks).trim() : '';
    const opts = {
      type, client, items,
      description: body.description != null ? body.description : '',
      remarks: cur.includes(ref) ? cur : (cur ? `${ref}\n\n${cur}` : ref),
      // קישור רק למקורות שקיימים בחשבונית ירוקה (300) → נסגרות. מקורות שהועלו ידנית נסגרים אצלנו בהמשך.
      linkedDocumentIds: sourceIds.length ? sourceIds : undefined,
    };
    if (body.discount && Number(body.discount.amount) > 0) opts.discount = { amount: Number(body.discount.amount), type: body.discount.type };
    if (body.date) opts.date = String(body.date).slice(0, 10);
    if (body.skipDateValidation) opts.skipDateValidation = true;
    // תקבולים — חובה למס-קבלה (320)
    if (Array.isArray(body.payment) && body.payment.length) {
      opts.payment = body.payment.map(p => {
        const row = { date: (p.date || opts.date || '').slice(0, 10) || undefined, type: Number(p.type), price: Number(p.price) || 0, currency: 'ILS' };
        if (Number(p.type) === 2 && p.chequeNum) row.chequeNum = String(p.chequeNum);
        if ([2, 4].includes(Number(p.type))) { if (p.bankName) row.bankName = String(p.bankName).replace(/\s*\(\d+\)\s*$/, '').trim(); if (p.bankBranch) row.bankBranch = String(p.bankBranch); if (p.bankAccount) row.bankAccount = String(p.bankAccount); }
        return row;
      }).filter(p => Math.abs(p.price) > 0);
    }
    if (type === 320 && !(opts.payment && opts.payment.length)) return json(res, { error: 'חשבונית מס-קבלה מחייבת פירוט תקבול (סכום ואמצעי תשלום).' }, 400);
    if (body.sendEmail && body.email) { opts.sendEmail = true; opts.email = String(body.email).trim(); }
    const doc = await createDocFwd(opts);
    // סימון אירועים מקושרים למקורות שנסגרו — עדכון למסמך המסכם החדש
    try {
      const db = load();
      const srcKeys = new Set(sourceIds.map(String).concat(srcDocs.map(d => String(d.number)).filter(Boolean)));
      let touched = false;
      for (const ev of (db.events || [])) {
        const ld = Array.isArray(ev.linkedDocs) ? ev.linkedDocs : [];
        if (!ld.some(d => srcKeys.has(String(d.id)) || srcKeys.has(String(d.number)))) continue;
        for (const d of ld) { if (srcKeys.has(String(d.id)) || srcKeys.has(String(d.number))) d.converted = true; }
        ld.push({ id: doc.id, number: doc.number, type, uploaded: false });
        ev.linkedDocs = ld.slice(0, 12);
        ev.invoiceStatus = 'invoiced'; ev.invoiceId = doc.id; ev.invoiceNumber = doc.number; ev.invoiceType = type;
        if (type === 320) ev.clientPaid = true; // מס-קבלה = שולם → האירוע סגור
        touched = true;
      }
      // מקורות שהועלו ידנית (אופק) — סימון כ"הומר" (converted) כך שיורדים מ"חשבוניות פתוחות", + סגירת האירוע/הרשומה
      for (const us of uploadedSources) {
        if (us.eventId) {
          const ev = (db.events || []).find(e => e.id === us.eventId);
          if (!ev) continue;
          const ld = Array.isArray(ev.linkedDocs) ? ev.linkedDocs : [];
          const s = ld.find(d => String(d.id) === String(us.docId)); if (s) s.converted = true;
          if (!ld.some(d => String(d.id) === String(doc.id))) ld.push({ id: doc.id, number: doc.number, type, uploaded: false });
          ev.linkedDocs = ld.slice(0, 12);
          ev.invoiceStatus = 'invoiced'; ev.invoiceId = doc.id; ev.invoiceNumber = doc.number; ev.invoiceType = type;
          if (type === 320) ev.clientPaid = true;
          touched = true;
        } else if (us.oldInvoiceId) {
          const rec = (db.oldInvoices || []).find(r => r.id === us.oldInvoiceId);
          if (!rec) continue;
          const ld = Array.isArray(rec.linkedDocs) ? rec.linkedDocs : [];
          const s = ld.find(d => String(d.id) === String(us.docId)); if (s) s.converted = true;
          if (!ld.some(d => String(d.id) === String(doc.id))) ld.push({ id: doc.id, number: doc.number, type, uploaded: false });
          rec.linkedDocs = ld.slice(0, 12);
          touched = true;
        }
      }
      if (touched) save(db);
    } catch { /* לא חוסם את הצלחת ההפקה */ }
    json(res, { ok: true, doc });
  } catch (e) {
    const msg = String(e.message || '');
    if (/2405|עתידי|מוקדם/i.test(msg)) {
      let minDate = null; try { minDate = await greenInvoice.latestDocumentDate(type); } catch { }
      const dmy = minDate ? minDate.split('-').reverse().join('/') : '';
      return json(res, { error: `חשבונית ירוקה חוסמת תאריך מוקדם מהמסמך האחרון מסוג זה${minDate ? ` (${dmy})` : ''}. בחר תאריך זה או מאוחר יותר, או סמן "הפקה מחוץ לרצף".`, minDate }, 400);
    }
    json(res, { error: msg }, 500);
  }
});

// GET /api/open-invoices — חשבון עסקה + חשבונית מס פתוחים מחשבונית ירוקה,
// בתוספת חשבוניות ישנות שהועלו ידנית לאירועים (עסקה/מס) שטרם נסגרו בקבלה/מס-קבלה.
add('GET', /^\/api\/open-invoices$/, async (req, res, _p, q) => {
  const cid = q.companyId;
  let docs = [], giErr = null;
  if (greenInvoice.haveCredentials()) {
    // חשוב: openDocuments מחזירה מערך מהמטמון (אותה הפניה) — חובה לשכפל לפני push, אחרת המסמכים שהועלו נדחפים למטמון ומצטברים בכל קריאה (כפילויות)
    try { docs = (await greenInvoice.openDocuments() || []).slice(); } catch (e) { giErr = e.message; }
  }
  // חשבוניות ישנות שהועלו ידנית לאירוע (עסקה/מס) — פתוחות עד שמצורפת קבלה/מס-קבלה לאותו אירוע
  try {
    const db = load();
    const seenUp = new Set(); // דדופ: חשבונית שהועלתה וקושרה לכמה אירועים תופיע פעם אחת בלבד (לפי מספר+סוג)
    for (const ev of (db.events || [])) {
      if (cid && ev.companyId && ev.companyId !== cid) continue;
      const linked = Array.isArray(ev.linkedDocs) ? ev.linkedDocs : [];
      if (linked.some(d => [320, 400].includes(Number(d.type)) && !d.converted)) continue; // נסגר בקבלה/מס-קבלה
      for (const d of linked) {
        if (!d.uploaded || d.converted || ![300, 305].includes(Number(d.type))) continue;
        const upKey = (d.number || d.id) + '|' + Number(d.type);
        if (seenUp.has(upKey)) continue; seenUp.add(upKey);
        docs.push({
          id: d.id, number: d.number, type: Number(d.type),
          date: d.date || ev.date || ev.dateRaw || null,
          clientName: (ev.clientName || ev.client || '—'),
          amount: d.amount != null ? Number(d.amount) : null,
          amountDue: d.amount != null ? Number(d.amount) : null,
          description: [(ev.artist || ''), (ev.location || '')].filter(Boolean).join(' · '),
          url: d.url, uploaded: true, eventId: ev.id,
        });
      }
    }
    // חשבוניות ישנות עצמאיות שהועלו ידנית (אופק) — פתוחות עד קבלה/מס-קבלה או המרה למסמך המשך
    for (const rec of (db.oldInvoices || [])) {
      if (cid && rec.companyId && rec.companyId !== cid) continue;
      const linked = Array.isArray(rec.linkedDocs) ? rec.linkedDocs : [];
      if (linked.some(d => [320, 400].includes(Number(d.type)) && !d.converted)) continue;
      for (const d of linked) {
        if (!d.uploaded || d.converted || ![300, 305].includes(Number(d.type))) continue;
        const upKey = (d.number || d.id) + '|' + Number(d.type);
        if (seenUp.has(upKey)) continue; seenUp.add(upKey);
        docs.push({
          id: d.id, number: d.number, type: Number(d.type),
          date: d.date || rec.createdAt || null,
          clientName: rec.clientName || '—',
          amount: d.amount != null ? Number(d.amount) : null,
          amountDue: d.amount != null ? Number(d.amount) : null,
          description: rec.description || '',
          url: d.url, uploaded: true, oldInvoiceId: rec.id,
        });
      }
    }
    // סימון חשבוניות מס (305) ששולמו בבנק אך חסרה להן קבלה — התראה + כפתור הפקת קבלה (בתאריך כניסת הכסף)
    const _nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/^0+/, '');
    const _toIso = (s) => { s = String(s || '').trim(); if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); const m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/); if (m) { let [, dd, mm, yy] = m; if (yy.length === 2) yy = '20' + yy; return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`; } return null; };
    const _paidNoRcpt = new Map(); // key -> { date, txId, amount }
    const bankSettled = new Set(); // חשבוניות שנסגרו בהתאמת בנק (זיכוי מאושר + קבלה מצורפת) → יורדות מ"פתוחות"
    for (const t of (db.bankTx || [])) {
      if (cid && t.companyId !== cid) continue;
      if (t.direction !== 'credit' || !['auto', 'manual', 'approved'].includes(t.matchStatus)) continue;
      const invs = (t.matchedInvoices || []).filter(inv => inv.kind !== 'expense');
      const hasReceiptDoc = invs.some(inv => [320, 400].includes(Number(inv.type))); // קבלה/מס-קבלה מותאמת באותה שורת בנק
      for (const inv of invs) {
        // נסגרה אם: צורפה קבלה ישירות (inv.receipt), או שיש מסמך קבלה (320/400) מותאם באותה שורת בנק
        const settled = !!inv.receipt || (hasReceiptDoc && [300, 305].includes(Number(inv.type)));
        if (settled) {
          if (inv.number != null) bankSettled.add('num:' + _nrm(inv.number));
          if (inv.id != null) bankSettled.add('id:' + String(inv.id));
        } else if (Number(inv.type) === 305) {
          const info = { date: _toIso(t.date), txId: t.id, amount: inv.amount != null ? Number(inv.amount) : (t.absAmount != null ? Number(t.absAmount) : null) };
          if (inv.number != null && !_paidNoRcpt.has('num:' + _nrm(inv.number))) _paidNoRcpt.set('num:' + _nrm(inv.number), info);
          if (inv.id != null && !_paidNoRcpt.has('id:' + inv.id)) _paidNoRcpt.set('id:' + inv.id, info);
        }
      }
    }
    docs.forEach(d => {
      if (Number(d.type) !== 305) return;
      const info = _paidNoRcpt.get('num:' + _nrm(d.number)) || _paidNoRcpt.get('id:' + d.id);
      if (info) { d.paidNoReceipt = true; d.paidDate = info.date || null; d.paidTxId = info.txId || null; d.paidAmount = info.amount != null ? info.amount : null; }
    });
    // חשבוניות שנסגרו בהתאמת בנק (התקבל תשלום + צורפה קבלה) — יורדות מ"פתוחות"
    if (bankSettled.size) docs = docs.filter(d => !(bankSettled.has('num:' + _nrm(d.number)) || bankSettled.has('id:' + String(d.id))));
  } catch {}
  json(res, { docs, error: (docs.length ? null : giErr) });
});

// GET /api/contractors/payables?companyId=
// מוסיף לכל אירוע חיווי "האם הלקוח שילם" — לפי התאמת בנק (זיכוי מאושר) או סטטוס חשבונית ירוקה (מס-קבלה/סגורה/פתוחה).
add('GET', /^\/api\/contractors\/payables$/, async (req, res, _p, q) => {
  const db = load();
  const payables = contractorPayables(companyEvents(db, q.companyId));
  // 1) חשבוניות ששולמו לפי הבנק — זיכוי (credit) שהותאם לחשבונית ואושר/הותאם ידני/אוטומטי
  const bankPaid = buildBankPaidMap(db, q.companyId); // 'num:'/'id:' -> תאריך התנועה
  // 2) חשבוניות פתוחות (טרם שולמו) לפי חשבונית ירוקה — לפי מספר מסמך
  let openNums = null;
  try { if (greenInvoice.haveCredentials()) { const open = await greenInvoice.openDocuments(); openNums = new Set((open || []).map(d => String(d.number))); } } catch { openNums = null; }
  const evMap = new Map((db.events || []).map(e => [e.id, e]));
  for (const g of payables) for (const ev of g.events) ev.clientPaid = eventClientPaid(evMap.get(ev.eventId), bankPaid, openNums);
  json(res, payables);
});

// מפת "החשבונית שולמה לפי הבנק": 'num:<מספר>' / 'id:<מזהה>' → תאריך התנועה.
// סורקת גם את חשבונית המקור המקוננת (inv.sourceInvoice): כשתנועה מותאמת לקבלה (400),
// attachSourceInvoices מקנן תחתיה את חשבונית המס שממנה נגזרה ומסיר אותה מהרשימה הראשית
// כדי לא לספור את הכסף פעמיים. על האירוע רשומה חשבונית המס — לא הקבלה — ולכן בלי
// הסריקה הזו אירוע ששולם דרך קבלה נראה כאילו לא שולם.
// השוואת שם לקוח סלחנית — זהה ללוגיקה שמזווגת חשבונית לקבלה במסך הבנק
function sameClientName(a, b) {
  const norm = (x) => String(x || '').replace(/בע["'׳״]?\s*מ\.?/g, '').replace(/[."'׳״,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const na = norm(a), nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

// חשבון עסקה שהומר לחשבונית מס — איתור חשבונית המס שנגזרה ממנו.
// כשההמרה נעשית דרך המערכת, המסמך החדש נרשם על האירוע והמקור מסומן converted.
// כשהיא נעשית ישירות בחשבונית ירוקה, הקישור קיים רק שם — ב-linkedDocumentIds.
// זה המקרה היחיד שבו המידע באמת לא אצלנו, ולכן נדרשת שליפה. התוצאה אינה משתנה
// (המרה היא חד־פעמית), ולכן נשמרת לצמיתות — כולל תוצאה שלילית, אחרת עסקה שלא
// הומרה הייתה נבדקת שוב בכל טעינה.
const CHAIN_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
function chainCached(db, cid, docId) {
  const hit = (db.docChain || {})[`${cid}|${docId}`];
  if (!hit) return null;
  if (hit.doc) return hit;
  return (Date.now() - new Date(hit.at || 0).getTime()) < CHAIN_RETRY_MS ? hit : null;
}
async function resolveConvertedInvoice(db, cid, proforma, income) {
  db.docChain = db.docChain || {};
  const key = `${cid}|${proforma.id}`;
  const pid = String(proforma.id);
  const pack = (d) => d && ({ id: String(d.id), number: d.number != null ? String(d.number) : null,
    type: Number(d.type), date: d.date || d.documentDate || null,
    amount: d.amount != null ? Number(d.amount) : null,
    url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null) });
  const remember = (doc) => { db.docChain[key] = { doc: doc || null, at: new Date().toISOString() }; return doc || null; };
  const list = Array.isArray(income) ? income : [];
  const pointsAtSource = (ids) => (ids || []).some(x => String(x) === pid);
  try {
    // 1) מהרשימה שכבר נטענה — בלי אף קריאה נוספת
    const direct = list.find(d => [305, 320].includes(Number(d.type)) && pointsAtSource(d.linkedDocumentIds));
    if (direct) return remember(pack(direct));
    // 2) ה-API לא תמיד מחזיר את הקישור ברשימה. מצמצמים לפי לקוח וסכום, ומאמתים
    //    מול הקישור עצמו — צמצום הוא ניחוש, האימות הוא ודאות.
    const amt = Number(proforma.amount) || 0;
    const cands = list.filter(d => [305, 320].includes(Number(d.type))
      && sameClientName(d.clientName, proforma.clientName)
      && (!amt || Math.abs((Number(d.amount) || 0) - amt) <= Math.max(3, amt * 0.004)));
    for (const c of cands.slice(0, 4)) {
      const raw = await greenInvoice.getDocument(c.id).catch(() => null);
      if (raw && pointsAtSource(raw.linkedDocumentIds)) return remember(pack({ ...c, ...raw, url: c.url }));
    }
    // 3) גיבוי: ייתכן שהקישור דו־כיווני ומופיע דווקא על חשבון העסקה
    const src = await greenInvoice.getDocument(pid).catch(() => null);
    for (const id of ((src && src.linkedDocumentIds) || [])) {
      if (String(id) === pid) continue;
      const d = list.find(x => String(x.id) === String(id)) || await greenInvoice.getDocument(id).catch(() => null);
      if (d && [305, 320].includes(Number(d.type))) return remember(pack(d));
    }
  } catch { return null; }   // תקלת רשת — לא מרעילים את המטמון
  return remember(null);
}

// זיווג חשבונית ↔ קבלה בתוך שורת בנק אחת.
// העברה אחת מכסה לא פעם כמה חשבוניות של כמה אירועים — למשל שלוש חשבוניות של
// אותו לקוח עם שלוש קבלות. כולן מאותו שם, ולכן שם הלקוח לא מבחין ביניהן; הסכום כן.
// כל קבלה משויכת לכל היותר לחשבונית אחת, והזיווג נעשה מהקרוב ביותר בסכום ובתאריך.
// זיווג מעורפל שלא ניתן להכריע — נשאר ריק. קבלה שגויה על אירוע גרועה מהיעדר קבלה.
function pairInvoiceReceipts(entries) {
  const out = new Map();
  const list = (entries || []).filter(x => x && x.kind !== 'expense');
  const rcpts = list.filter(x => [400, 320].includes(Number(x.type)));
  const invs = list.filter(x => [300, 305].includes(Number(x.type)));
  // מסמך שהוא עצמו קבלה, או שהקבלה כבר מוצמדת לו בשמירה — נקבע מיד
  const taken = new Set();
  for (const e of list) {
    if (e.receipt) { out.set(e, { ...e.receipt, type: Number(e.receipt.type) || 400 }); continue; }
    if ([400, 320].includes(Number(e.type))) out.set(e, e);
  }
  const free = () => rcpts.filter(r => !taken.has(r));
  const amt = (x) => Math.abs(Number(x && (x.amount ?? x.amountIncVat)) || 0);
  const days = (a, b) => {
    const pa = Date.parse(String(a || '')), pb = Date.parse(String(b || ''));
    return (isNaN(pa) || isNaN(pb)) ? 9e9 : Math.abs(pa - pb) / 86400000;
  };
  for (const inv of invs) {
    if (out.has(inv)) continue;
    const avail = free();
    if (!avail.length) continue;
    if (avail.length === 1 && invs.length === 1) { out.set(inv, avail[0]); taken.add(avail[0]); continue; }
    const target = amt(inv);
    const tol = Math.max(3, target * 0.004);
    const byAmt = target > 0 ? avail.filter(r => Math.abs(amt(r) - target) <= tol) : [];
    if (!byAmt.length) continue;                       // אין התאמת סכום — לא מנחשים
    byAmt.sort((a, b) => days(inv.date, a.date) - days(inv.date, b.date));
    // שתי קבלות זהות בסכום ובמרחק זמן — לא ניתן להכריע
    if (byAmt.length > 1 && days(inv.date, byAmt[0].date) === days(inv.date, byAmt[1].date)
        && String(byAmt[0].date || '') !== String(byAmt[1].date || '')) continue;
    out.set(inv, byAmt[0]); taken.add(byAmt[0]);
  }
  return out;
}

function buildBankPaidMap(db, companyId) {
  const m = new Map();
  // הערך הוא { date, doc }: תאריך התנועה, ו-doc = המסמך שהתנועה שויכה אליו בפועל.
  // כשהשיוך נעשה לקבלה, doc הוא הקבלה — וכך אפשר להציג אותה לצד חשבונית המס
  // של האירוע, ולראות מתי שולם ולא רק שהתשלום התקבל.
  const put = (inv, date, doc) => {
    if (!inv) return;
    const val = { date: date || null, doc: doc || null };
    if (inv.number != null && !m.has('num:' + inv.number)) m.set('num:' + inv.number, val);
    if (inv.id != null && !m.has('id:' + inv.id)) m.set('id:' + inv.id, val);
  };
  for (const t of (db.bankTx || [])) {
    if (companyId && !ownedBy(t, companyId)) continue;
    if (t.direction !== 'credit' || !['auto', 'manual', 'approved'].includes(t.matchStatus)) continue;
    // מסמך התשלום של השורה. שלושה מצבים, כי הקבלה מגיעה בשלוש דרכים:
    //   1. מוצמדת לחשבונית בשמירה (attachReceipts) → inv.receipt
    //   2. רשומה נפרדת באותה שורת בנק — כך זה כשמשייכים ידנית גם חשבונית וגם קבלה.
    //      מסך הבנק מזווג ביניהן רק בזמן התצוגה, ולכן אין שום סימן שמור על החשבונית.
    //   3. השיוך עצמו נעשה לקבלה → הרשומה היא הקבלה.
    const entries = t.matchedInvoices || [];
    const pairs = pairInvoiceReceipts(entries);
    for (const inv of entries) {
      const payer = pairs.get(inv) || inv;
      put(inv, t.date, payer);
      put(inv && inv.sourceInvoice, t.date, payer);
    }
  }
  return m;
}

// מסמך התשלום כפי שהפרונט צריך אותו לתג "צפייה" — בלי לגרור את כל שורת הבנק.
function payDocOf(d) {
  if (!d) return null;
  return { id: d.id != null ? String(d.id) : null, number: d.number != null ? String(d.number) : null,
    type: Number(d.type) || null, date: d.date || null, url: d.url || null,
    amount: d.amount != null ? Number(d.amount) : null };
}

// חלון הסריקה של openDocuments (24 חודשים). מסמך מחוץ לחלון אינו מופיע ברשימת
// המסמכים הפתוחים גם כשלא שולם — ולכן אסור להסיק מהיעדרו שהוא שולם.
const OPEN_DOCS_MONTHS = 24;
function withinOpenDocsWindow(dateLike, now = new Date()) {
  const raw = String(dateLike || '');
  const iso = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : ddmmyyyyToISO(raw);
  if (!iso) return false;   // בלי תאריך ודאי לא מסיקים כלום
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const from = new Date(now); from.setMonth(from.getMonth() - OPEN_DOCS_MONTHS);
  return d >= from && d.getTime() <= now.getTime() + 86400000;
}

// קובע האם הלקוח שילם על אירוע (עבור חיווי "קבלנים לתשלום"): בנק או חשבונית ירוקה
function eventClientPaid(e, bankPaid, openNums) {
  if (!e) return { status: 'unknown' };
  if (e.noInvoice) return { status: 'noinvoice' };
  const REAL = [300, 305, 320, 400]; // הצעת מחיר (10) אינה חיוב ואינה נחשבת
  // אסוף את החשבוניות האמיתיות המקושרות לאירוע (מ-linkedDocs, ובתאימות לאחור גם מ-invoiceType)
  let docs = Array.isArray(e.linkedDocs) ? e.linkedDocs.filter(d => d && REAL.includes(Number(d.type))) : [];
  if (!docs.length && e.invoiceStatus === 'invoiced' && REAL.includes(Number(e.invoiceType))) {
    docs = [{ type: Number(e.invoiceType), number: e.invoiceNumber, id: e.invoiceId }];
  }
  // אין חשבונית אמיתית (רק הצעת מחיר / כלום) → טרם חויב (אדום)
  if (!docs.length) return { status: 'uninvoiced' };
  // בנק — הכסף נכנס בפועל → שולם (האות החזק ביותר, גובר על סוג המסמך)
  for (const d of docs) {
    const num = d.number != null ? String(d.number) : null;
    const id = d.id != null ? String(d.id) : null;
    const key = (num && bankPaid.has('num:' + num)) ? 'num:' + num : (id && bankPaid.has('id:' + id)) ? 'id:' + id : null;
    if (!key) continue;
    const hit = bankPaid.get(key) || {};
    // מסמך התשלום מוצג רק כשהוא באמת מסמך אחר — קבלה/מס-קבלה שאינה כבר על האירוע.
    // אם הבנק שויך לחשבונית המס עצמה, אין קבלה נפרדת להציג; התאריך לבדו מספיק.
    const pd = hit.doc;
    const isRcpt = pd && [320, 400].includes(Number(pd.type)) && !docs.some(x => String(x.id) === String(pd.id));
    return { status: 'paid', via: 'bank', date: hit.date || null, payDoc: isRcpt ? payDocOf(pd) : null };
  }
  // מס-קבלה (320) / קבלה (400) → שולם (ירוק). תאריך המסמך הוא תאריך התשלום.
  const rcpt = docs.find(d => [320, 400].includes(Number(d.type)));
  if (rcpt) return { status: 'paid', via: 'greeninvoice', date: rcpt.date || null };
  // עסקה (300) / מס (305) שכבר אינה ברשימת המסמכים הפתוחים של חשבונית ירוקה — נסגרה, כלומר שולמה.
  // זה האות היחיד כשהקבלה הופקה ישירות בחשבונית ירוקה: היא לא נכנסת ל-linkedDocs של האירוע,
  // ואם גם אין התאמת בנק — האירוע נתקע על "ממתין לתשלום מהלקוח" לנצח.
  // שלוש הגנות מפני ירוק שגוי:
  //   1. openNums הוא Set — כלומר נטען בהצלחה. אם חשבונית ירוקה לא זמינה הוא null, ואז
  //      "לא ברשימה" לא אומר כלום וכל האירועים היו נצבעים ירוק.
  //   2. רק 300/305 — אלה הסוגים היחידים ש-openDocuments סורק בכלל.
  //   3. רק בתוך חלון 24 החודשים שהוא סורק, ורק מסמך פעיל: מסמך שזוכה או שהומר
  //      נסגר בחשבונית ירוקה בלי ששולם, ואסור להסיק ממנו תשלום.
  // רק חשבונית מס (305). חשבון עסקה (300) נסגר בחשבונית ירוקה כשהוא מומר לחשבונית
  // מס — לא כשמשלמים עליו. להסיק ממנו תשלום זה לסמן "שולם" על אירוע שרק חויב,
  // ובלי שום מסמך תשלום להראות. אירוע שנשאר על חשבון עסקה צריך לקבל את חשבונית
  // המס שנגזרה ממנו, ועד אז נכון שיוצג כממתין.
  if (openNums instanceof Set) {
    const closed = docs.some(d => Number(d.type) === 305
      && !d.credited && !d.credit && !d.converted
      && d.number != null && String(d.number).trim() !== ''
      && withinOpenDocsWindow(d.date || e.date || e.dateRaw)
      && !openNums.has(String(d.number).trim()));
    if (closed) return { status: 'paid', via: 'closed' };
  }
  // עסקה (300) / מס (305) בלבד → הלקוח חויב אך טרם שילם (צהוב)
  return { status: 'charged' };
}

// POST /api/contractors/toggle-paid — סימון תשלום לקבלן על אירוע מסוים
add('POST', /^\/api\/contractors\/toggle-paid$/, (req, res, _p, _q, body) => {
  const db = load();
  const ev = db.events.find(e => e.id === body.eventId);
  if (!ev || !ev.contractorDetails || !ev.contractorDetails[body.index]) return json(res, { error: 'לא נמצא' }, 404);
  if (!ownedBy(ev, reqCompany(_q, body))) return wrongCompany(res, 'האירוע');
  const cd = ev.contractorDetails[body.index];
  cd.paid = Boolean(body.paid);
  if (body.paid) { cd.paidSource = 'manual'; } // סימון ידני מפורש — נשמר גם בנרמול הבנק
  else { cd.paidSource = null; cd.paidInvoice = null; cd.paidExpenseUrl = null; cd.paidExpenseId = null; cd.paidPayableId = null; } // ביטול תשלום — מנקה את כל סימוני התשלום ומחזיר לרשימת הפתוחים
  save(db); json(res, { ok: true });
});

// POST /api/contractors/mark-paid-bulk — סימון תשלום למספר אירועים עם מספר חשבונית
add('POST', /^\/api\/contractors\/mark-paid-bulk$/, (req, res, _p, _q, body) => {
  const db = load();
  const items = Array.isArray(body.items) ? body.items : [];
  const paid = body.paid !== false;
  const linkOnly = body.link === true && !paid; // קישור בלבד — שומר את השיוך לחשבונית בלי לסמן "שולם"
  const cid = reqCompany(_q, body);
  // מזהה רישום ההוצאה המתאים, אם קיים — כדי שהקישור ייקבע למזהה ולא יסתמך על
  // התאמת "מספר + שם", שנשברת בכל עריכה של אחד מהשדות האלה.
  const nrm = (x) => String(x || '').trim().toLowerCase();
  const findPayable = (cd) => createdPayable || (db.supplierPayables || []).find(p => ownedBy(p, cid) && (
    (body.expenseId && p.giExpenseId && String(p.giExpenseId) === String(body.expenseId))
    || (body.expenseId && String(p.id) === String(body.expenseId))
    || (body.invoiceNumber && p.number && String(p.number) === String(body.invoiceNumber)
        && nrm(cd.name) === nrm(p.supplierName))));
  // חשבונית שנבחרה מחשבונית ירוקה ואין לה רשומה מקומית — יוצרים אותה כאן.
  // בלי זה הקישור נשמר על האירועים אך אין שורה במסך שתחתיה יוצגו, והפעולה נראית
  // כאילו לא עשתה כלום. לא ממזגים את *כל* ההוצאות מחשבונית ירוקה — רק את מה
  // שבחרת לשייך אליו אירועים, כלומר מה שאתה באמת עוקב אחריו.
  let createdPayable = null;
  const doc = body && body.doc;
  if ((paid || linkOnly) && doc && doc.id && !doc.localOnly) {
    const exists = (db.supplierPayables || []).some(p => ownedBy(p, cid)
      && (String(p.giExpenseId || '') === String(doc.id) || String(p.id) === String(doc.id)));
    if (!exists) {
      const amt = Number(doc.amount) || 0;
      const net = doc.amountExVat != null ? Number(doc.amountExVat) : +(amt / 1.18).toFixed(2);
      createdPayable = {
        id: 'pay_' + Math.random().toString(36).slice(2, 10),
        companyId: cid,
        supplierId: doc.supplierId || body.supplierId || null,
        supplierName: doc.supplierName || body.supplierName || '',
        documentType: Number(doc.type) || 305,
        number: doc.number != null ? String(doc.number) : (body.invoiceNumber || null),
        date: doc.date ? String(doc.date).slice(0, 10) : null,
        amount: amt, amountExcludeVat: net, vat: +(amt - net).toFixed(2),
        description: doc.description || '',
        giExpenseId: String(doc.id),
        paid: false, paidAt: null, linkedEvents: [],
        createdAt: new Date().toISOString(), fromLink: true,
      };
      db.supplierPayables = db.supplierPayables || [];
      db.supplierPayables.push(createdPayable);
      console.log(`[link-events] ${cid}: נוצרה רשומת הוצאה מחשבונית ירוקה · ${createdPayable.supplierName} #${createdPayable.number} · ${amt}`);
    }
  }

  let n = 0; const skipped = [];
  for (const it of items) {
    const ev = db.events.find(e => e.id === it.eventId);
    if (!ev) { skipped.push({ eventId: it.eventId, why: 'אירוע לא נמצא' }); continue; }
    if (!ownedBy(ev, cid)) { skipped.push({ eventId: it.eventId, why: 'שייך לחברה אחרת' }); continue; }
    const cd = (ev.contractorDetails || [])[it.index];
    if (!cd) { skipped.push({ eventId: it.eventId, why: `שורת קבלן ${it.index} לא נמצאה` }); continue; }
    cd.paid = paid;
    if (paid) cd.paidSource = 'manual'; else if (!linkOnly) cd.paidSource = null;
    if (paid || linkOnly) {
      cd.paidInvoice = body.invoiceNumber || null;
      cd.paidExpenseId = body.expenseId || null;
      cd.paidExpenseUrl = body.expenseUrl || null;
      const pay = findPayable(cd);
      if (pay) cd.paidPayableId = pay.id;
    } else { cd.paidInvoice = null; cd.paidExpenseId = null; cd.paidExpenseUrl = null; cd.paidPayableId = null; }
    n++;
  }
  save(db);
  const matchedPayable = items.length ? Boolean((db.supplierPayables || []).some(p => ownedBy(p, cid)
    && ((body.expenseId && ((p.giExpenseId && String(p.giExpenseId) === String(body.expenseId)) || String(p.id) === String(body.expenseId)))
      || (body.invoiceNumber && p.number && String(p.number) === String(body.invoiceNumber))))) : false;
  console.log(`[link-events] ${cid}: קושרו ${n}/${items.length} שורות לחשבונית ${body.invoiceNumber || body.expenseId || '?'}${matchedPayable ? '' : ' · אין רישום הוצאה תואם'}${skipped.length ? ' · דולגו: ' + skipped.map(x => x.why).join(', ') : ''}`);
  json(res, { ok: true, updated: n, total: items.length, skipped, matchedPayable: matchedPayable || Boolean(createdPayable), createdPayable: createdPayable ? { id: createdPayable.id, number: createdPayable.number, supplierName: createdPayable.supplierName } : null });
});

// POST /api/contractors/dismiss-supplier { name } — סימון כל האירועים שנותרו (לא שולמו) של הספק כ"טופל"
add('POST', /^\/api\/contractors\/dismiss-supplier$/, (req, res, _p, _q, body) => {
  const db = load();
  const name = String(body?.name || '').trim();
  if (!name) return json(res, { error: 'חסר שם ספק' }, 400);
  const cid = reqCompany(_q, body);
  const undo = body?.undo === true;
  let n = 0;
  for (const ev of db.events) {
    if (!ownedBy(ev, cid)) continue;   // בידוד: ספק עם אותו שם בחברה אחרת לא ייסגר בטעות
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
  const evs = companyEvents(db, q.companyId || giCompanyId());
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
  const cid = reqCompany(_q, body);
  let changed = 0; const applied = {};
  for (const ev of db.events) {
    if (!ownedBy(ev, cid)) continue;   // בידוד: שינוי שם קבלן חל רק על אירועי החברה הפעילה
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
add('POST', /^\/api\/contractors\/auto-sync-names$/, async (req, res, _p, q, body) => {
  const db = load();
  // בידוד: רשימת הספקים נשלפת מחשבונית ירוקה של החברה הפעילה, ולכן גם השינוי חייב לחול
  // אך ורק על אירועי אותה חברה. בלי זה פתיחת הלשונית בחברה אחת שינתה שמות קבלנים בכל השאר.
  const cid = reqCompany(q, body);
  const companyEvs = (db.events || []).filter(ev => ownedBy(ev, cid));
  let suppliers = [];
  try { suppliers = (await greenInvoice.listSuppliers()).map(s => (s.name || '').trim()).filter(Boolean); }
  catch (e) { return json(res, { ok: false, changed: 0, error: e.message }); }
  const supSet = new Set(suppliers);
  // שמות קבלנים ייחודיים מהאירועים
  const names = new Set();
  for (const ev of companyEvs) for (const c of (ev.contractorDetails || [])) { const n = (c.name || '').trim(); if (n) names.add(n); }
  const renameMap = new Map();
  for (const name of names) {
    if (supSet.has(name)) continue; // כבר תואם במדויק
    const cand = suppliers.filter(s => s !== name && (s.includes(name) || name.includes(s)));
    if (cand.length === 1) renameMap.set(name, cand[0]); // רק כשיש התאמה יחידה וודאית
  }
  let changed = 0; const applied = {};
  if (renameMap.size) {
    for (const ev of companyEvs) {
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

// POST /api/sync-names?companyId= — יישור אוטומטי של שמות לקוחות/ספקים באירועים לפי חשבונית ירוקה,
// כולל תיקון מזהה שגוי (clientId/supplierId) כשיש התאמת שם ודאית יחידה. מונע תקלות משמות חתוכים/וריאציות.
// פר-חברה: רץ בהקשר החברה (withCompany מהראוטר) ומעדכן רק את אירועי אותה חברה.
add('POST', /^\/api\/sync-names$/, async (req, res, _p, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { ok: false, error: 'חשבונית ירוקה לא מחוברת' });
  let clients = [], suppliers = [];
  try { clients = await greenInvoice.listClients(); } catch (e) { return json(res, { ok: false, error: e.message }); }
  try { suppliers = await greenInvoice.listSuppliers(); } catch { suppliers = []; }
  const norm = (s) => String(s || '').replace(/בע["'׳״]?\s*מ\.?/g, '').replace(/[."'׳״,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const clById = new Map(clients.map(c => [String(c.id), c]));
  // התאמת שם ודאית: מדויק > מנורמל-מדויק > תת-מחרוזת יחידה. מחזיר ישות אחת או null (לא נוגעים בעמימות).
  const resolveBy = (arr, name) => {
    const raw = (name || '').trim(); if (!raw) return null;
    let c = arr.find(x => (x.name || '').trim() === raw); if (c) return c;
    const nn = norm(raw); if (nn.length < 3) return null;
    c = arr.find(x => norm(x.name) === nn); if (c) return c;
    const cand = arr.filter(x => { const xn = norm(x.name); return xn && (xn.includes(nn) || nn.includes(xn)); });
    return cand.length === 1 ? cand[0] : null;
  };
  const db = load();
  const evs = companyEvents(db, q.companyId || giCompanyId());
  let clientsFixed = 0, clientIdFixed = 0, ctrFixed = 0;
  const applied = { clients: {}, contractors: {} };
  for (const ev of evs) {
    // ---- לקוח האירוע ----
    const name = (ev.clientName || '').trim();
    if (name) {
      const byName = resolveBy(clients, name);
      const byId = ev.clientId ? clById.get(String(ev.clientId)) : null;
      // שם הלקוח הוא מקור האמת ל"מי הלקוח"; אם אין התאמת שם ודאית אבל יש מזהה תקין ושם ריק — משלימים מהמזהה.
      const canonical = byName || (byId && !name ? byId : null);
      if (canonical) {
        if (ev.clientName !== canonical.name) { applied.clients[name] = canonical.name; ev.clientName = canonical.name; clientsFixed++; }
        if (String(ev.clientId || '') !== String(canonical.id)) { ev.clientId = canonical.id; clientIdFixed++; }
      }
    }
    // ---- קבלנים/ספקים של האירוע ----
    const fixName = (n) => { const nm = (n || '').trim(); if (!nm) return n; const s = resolveBy(suppliers, nm); if (s && s.name !== nm) { applied.contractors[nm] = s.name; ctrFixed++; return s.name; } return n; };
    if (Array.isArray(ev.contractorDetails)) for (const c of ev.contractorDetails) { const nn = fixName(c.name); if (nn !== c.name) c.name = nn; }
    if (Array.isArray(ev.contractors)) ev.contractors = ev.contractors.map(n => fixName(n));
  }
  if (clientsFixed || clientIdFixed || ctrFixed) save(db);
  json(res, { ok: true, clientsFixed, clientIdFixed, ctrFixed, applied });
});

// GET /api/contractors/:id/documents — מסמכי הוצאה של קבלן/ספק מחשבונית ירוקה
add('GET', /^\/api\/contractors\/([^/]+)\/documents$/, async (req, res, params) => {
  try { json(res, await greenInvoice.supplierExpenses(params[0])); }
  catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/payroll?companyId=&month=
add('GET', /^\/api\/payroll$/, (req, res, _p, q) => {
  const db = load();
  const _cid = q.companyId || giCompanyId();
  // בידוד: עובד ללא תיוג חברה = BPM (מוסכמה). לא להחזיר עובדי BPM לחברות אחרות.
  const emps = (db.employees || []).filter(e => (e.companyId || 'co_bpm') === _cid);
  json(res, employeePayForMonth(companyEvents(db, _cid), q.month, emps));
});

// ---- עובדים (רשימה מרכזית עם שכר בסיס) ----
// GET /api/employees?companyId=
add('GET', /^\/api\/employees$/, (req, res, _p, q) => {
  const db = load();
  const _cid = q.companyId || giCompanyId();
  // בידוד: עובד ללא תיוג חברה = BPM. חברה אחרת לא רואה עובדי BPM.
  json(res, (db.employees || []).filter(e => (e.companyId || 'co_bpm') === _cid)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he')));
});
// POST /api/employees  { name, baseRate }
add('POST', /^\/api\/employees$/, (req, res, _p, _q, body) => {
  const db = load();
  const cid = body.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  const name = (body.name || '').trim();
  if (!name) return json(res, { error: 'חסר שם עובד' }, 400);
  let emp = (db.employees || []).find(e => e.name === name && (e.companyId || 'co_bpm') === cid);
  if (emp) { emp.baseRate = body.baseRate ?? emp.baseRate; }
  else { emp = { id: id('emp'), companyId: cid, name, baseRate: body.baseRate ?? null, salaryType: body.salaryType || 'gross', active: true }; db.employees.push(emp); }
  save(db); json(res, emp);
});
// PUT /api/employees/:id
add('PUT', /^\/api\/employees\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const emp = (db.employees || []).find(e => e.id === params[0]);
  if (!emp) return json(res, { error: 'עובד לא נמצא' }, 404);
  // בידוד: אסור לערוך עובד של חברה אחרת
  const _cid = (body && body.companyId) || _q.companyId || giCompanyId();
  if ((emp.companyId || 'co_bpm') !== _cid) return json(res, { error: 'העובד שייך לחברה אחרת' }, 403);
  const { companyId, id: _bid, ...safe } = body || {}; // לא לאפשר העברת עובד בין חברות דרך העדכון
  Object.assign(emp, safe); save(db); json(res, emp);
});
// DELETE /api/employees/:id
add('DELETE', /^\/api\/employees\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const _cid = q.companyId || giCompanyId();
  const emp = (db.employees || []).find(e => e.id === params[0]);
  if (!emp) return json(res, { error: 'עובד לא נמצא' }, 404);
  if ((emp.companyId || 'co_bpm') !== _cid) return json(res, { error: 'העובד שייך לחברה אחרת' }, 403); // בידוד
  db.employees = (db.employees || []).filter(e => e.id !== params[0]);
  save(db); json(res, { ok: true });
});

// POST /api/employees/sync — יוצר עובדים מרכזיים מכל השמות שמופיעים באירועים
add('POST', /^\/api\/employees\/sync$/, (req, res, _p, q, body) => {
  const db = load();
  const cid = (body && body.companyId) || q.companyId || (db.companies.find(c => c.active) || db.companies[0])?.id;
  const names = new Set();
  for (const ev of companyEvents(db, cid)) for (const w of (ev.employeeDetails || [])) if (w.name) names.add(String(w.name).trim());
  // "כבר קיים" = לפי שם פרטי או לפי שם מלא (פרטי+משפחה) — כדי שלא ייווצר עובד כפול בשם המלא כשקיים כבר עובד בשם הפרטי
  const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const existing = new Set();
  for (const e of (db.employees || []).filter(e => (e.companyId || 'co_bpm') === cid)) {
    if (e.name) existing.add(nrm(e.name));
    if (e.name && e.lastName) existing.add(nrm(e.name + ' ' + e.lastName));
  }
  let added = 0;
  for (const name of names) { if (name && !existing.has(nrm(name))) { db.employees.push({ id: id('emp'), companyId: cid, name, baseRate: null, salaryType: 'gross', active: true }); added++; existing.add(nrm(name)); } }
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
// לאיזו חברה שייך קובץ מאוחסן. הקבצים מתויגים ב-employee_id לפי המקור שיצר אותם
// ('biz:<cid>' / 'mailscan:<cid>' / 'evdoc:<eventId>' / מזהה עובד / 'oldinv' / 'payable'),
// ואם התיוג לא מספיק — מאתרים את הרשומה שמפנה לקובץ. מחזיר null אם לא ניתן לקבוע.
function fileCompanyId(db, fileRec, fileId) {
  const owner = String((fileRec && (fileRec.employee_id || fileRec.employeeId)) || '');
  let m = owner.match(/^(?:biz|mailscan):(.+)$/);
  if (m) return m[1];
  m = owner.match(/^veh:(.+)$/);
  if (m) { const v = (db.vehicles || []).find(x => x.id === m[1]); return v ? (v.companyId || giCompanyId()) : null; }
  m = owner.match(/^evdoc:(.+)$/);
  if (m) { const ev = (db.events || []).find(e => e.id === m[1]); return ev ? (ev.companyId || giCompanyId()) : null; }
  if (owner && owner !== 'oldinv' && owner !== 'payable') {
    const emp = (db.employees || []).find(e => e.id === owner);
    if (emp) return emp.companyId || 'co_bpm';
  }
  const fid = String(fileId);
  for (const rec of (db.oldInvoices || [])) if ((rec.linkedDocs || []).some(d => String(d.id) === fid)) return rec.companyId || giCompanyId();
  for (const p of (db.supplierPayables || [])) if (String(p.localFileId) === fid) return p.companyId || giCompanyId();
  for (const ev of (db.events || [])) if ((ev.linkedDocs || []).some(d => String(d.id) === fid)) return ev.companyId || giCompanyId();
  for (const [cid, list] of Object.entries(db.mailRecords || {})) if ((list || []).some(r => String(r.fileId) === fid)) return cid;
  for (const [cid, p] of Object.entries(db.businessProfiles || {})) {
    const metas = [p.bankConfirmation, p.taxConfirmation, ...(p.additionalDocs || []),
      ...((p.managers || []).flatMap(mg => Object.values((mg && mg.files) || {})))].filter(Boolean);
    if (metas.some(x => String(x.fileId || '') === fid)) return cid;
  }
  return null;
}
// האם המשתמש רשאי לקבל את הקובץ. מנהל — הכל (יש לו גישה לכל העסקים ממילא).
// משתמש צפייה — רק קבצים של עסק שהורשה אליו; קובץ שלא ניתן לשייך נחסם.
function mayReadFile(req, fileRec, fileId) {
  const u = req && req.user;
  if (!u || u.role === 'admin') return true;
  const allowed = Array.isArray(u.companies) ? u.companies : [];
  const owner = fileCompanyId(load(), fileRec, fileId);
  return Boolean(owner) && allowed.includes(owner);
}

// ---- רכבי חברה ----
// מסמך לכל רכב: רישיון, ביטוח חובה, ביטוח מקיף. לכל אחד תוקף וקובץ.
// קבצים מתויגים veh:<id> כדי ש-fileCompanyId יאכוף הרשאה לפי החברה של הרכב.
const VEHICLE_SLOTS = ['license', 'cto', 'comp'];
const VEHICLE_SLOT_HE = { license: 'רישיון רכב', cto: 'ביטוח חובה', comp: 'ביטוח מקיף' };
const cleanVehicle = (b, prev = {}) => ({
  kind: b.kind === 'truck' ? 'truck' : 'private',
  plate: String(b.plate == null ? prev.plate || '' : b.plate).trim(),
  maker: String(b.maker == null ? prev.maker || '' : b.maker).trim(),
  ownerName: String(b.ownerName == null ? prev.ownerName || '' : b.ownerName).trim(),
  licenseExpiry: b.licenseExpiry !== undefined ? (b.licenseExpiry || null) : (prev.licenseExpiry || null),
  ctoExpiry: b.ctoExpiry !== undefined ? (b.ctoExpiry || null) : (prev.ctoExpiry || null),
  compExpiry: b.compExpiry !== undefined ? (b.compExpiry || null) : (prev.compExpiry || null),
  notes: String(b.notes == null ? prev.notes || '' : b.notes).trim(),
});

add('GET', /^\/api\/vehicles$/, (req, res, _p, q) => {
  const db = load(), cid = reqCompany(q);
  const list = (db.vehicles || []).filter(v => ownedBy(v, cid));
  list.sort((a, b) => String(a.plate || '').localeCompare(String(b.plate || ''), 'he'));
  json(res, list);
});

// POST /api/vehicles — יצירה, או עדכון כשנשלח id
add('POST', /^\/api\/vehicles$/, (req, res, _p, q, body) => {
  const db = load(), cid = reqCompany(q, body), b = body || {};
  db.vehicles = db.vehicles || [];
  let v = b.id ? db.vehicles.find(x => x.id === b.id) : null;
  if (b.id && !v) return json(res, { error: 'הרכב לא נמצא' }, 404);
  if (v && !ownedBy(v, cid)) return wrongCompany(res, 'הרכב');
  const fields = cleanVehicle(b, v || {});
  if (!fields.plate) return json(res, { error: 'חסר מספר רכב' }, 400);
  // מספר רכב כפול באותה חברה — כמעט תמיד טעות הקלדה, ולא רכב נוסף
  const dup = db.vehicles.find(x => ownedBy(x, cid) && x.id !== (v && v.id)
    && String(x.plate || '').replace(/\D/g, '') === fields.plate.replace(/\D/g, ''));
  if (dup) return json(res, { error: `מספר רכב ${fields.plate} כבר קיים ברשימה` }, 409);
  if (v) Object.assign(v, fields);
  else { v = { id: id('veh'), companyId: cid, createdAt: new Date().toISOString(), files: {}, ...fields }; db.vehicles.push(v); }
  save(db);
  json(res, { ok: true, vehicle: v });
});

// POST /api/vehicles/:id/file — העלאת מסמך לאחד השדות { slot, fileBase64, filename, mime }
add('POST', /^\/api\/vehicles\/([^/]+)\/file$/, async (req, res, params, q, body) => {
  const db = load(), cid = reqCompany(q, body), b = body || {};
  const v = (db.vehicles || []).find(x => x.id === params[0]);
  if (!v) return json(res, { error: 'הרכב לא נמצא' }, 404);
  if (!ownedBy(v, cid)) return wrongCompany(res, 'הרכב');
  const slot = String(b.slot || '');
  if (!VEHICLE_SLOTS.includes(slot)) return json(res, { error: 'שדה מסמך לא מוכר' }, 400);
  if (!b.fileBase64) return json(res, { error: 'חסר קובץ' }, 400);
  const saved = await saveFile({ employeeId: 'veh:' + v.id, kind: 'vehicle-' + slot,
    filename: b.filename || (VEHICLE_SLOT_HE[slot] + '.pdf'), mime: b.mime || 'application/octet-stream', data: b.fileBase64 });
  v.files = v.files || {};
  const old = v.files[slot];
  v.files[slot] = { id: saved.id, filename: b.filename || null, mime: b.mime || null, at: new Date().toISOString() };
  save(db);
  // מסמך שהוחלף — מוחקים את הקודם, אחרת האחסון מתמלא בקבצים שאין אליהם הפניה
  if (old && old.id && old.id !== saved.id) { try { await deleteFile(old.id); } catch { } }
  json(res, { ok: true, file: v.files[slot] });
});

add('DELETE', /^\/api\/vehicles\/([^/]+)\/file\/([^/]+)$/, async (req, res, params, q) => {
  const db = load(), cid = reqCompany(q);
  const v = (db.vehicles || []).find(x => x.id === params[0]);
  if (!v) return json(res, { error: 'הרכב לא נמצא' }, 404);
  if (!ownedBy(v, cid)) return wrongCompany(res, 'הרכב');
  const slot = params[1];
  const f = (v.files || {})[slot];
  if (f) { delete v.files[slot]; save(db); try { await deleteFile(f.id); } catch { } }
  json(res, { ok: true });
});

add('DELETE', /^\/api\/vehicles\/([^/]+)$/, async (req, res, params, q) => {
  const db = load(), cid = reqCompany(q);
  const v = (db.vehicles || []).find(x => x.id === params[0]);
  if (!v) return json(res, { error: 'הרכב לא נמצא' }, 404);
  if (!ownedBy(v, cid)) return wrongCompany(res, 'הרכב');
  db.vehicles = db.vehicles.filter(x => x.id !== v.id);
  save(db);
  for (const f of Object.values(v.files || {})) { try { await deleteFile(f.id); } catch { } }
  json(res, { ok: true });
});

// GET /api/files/:id — הגשת הקובץ (צפייה=inline / הורדה=?download=1)
add('GET', /^\/api\/files\/([^/]+)$/, async (req, res, params, q) => {
  const f = await getFile(params[0]);
  if (!f) return json(res, { error: 'קובץ לא נמצא' }, 404);
  if (!mayReadFile(req, f, params[0])) return json(res, { error: 'אין הרשאה לקובץ זה' }, 403);
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
// הערת ברירת מחדל שנוספת לכל המסמכים (ניתנת לעריכה בפרטי העסק פר-חברה). כוללת פרטי בנק להעברה.
function defaultDocRemark(cid) {
  if (cid === 'co_bpm') return 'שם מוטב: בי פי אם הגברה ותאורה בע"מ\nמספר חשבון: 347346\nמס\' סניף: 521 (מודיעין)\nמזרחי טפחות (20)';
  if (cid === 'co_moshe') return 'משה כורסיה בע"מ\nדיסקונט (11)\nסניף 152\nמספר חשבון: 0215130040';
  return '';
}
function bizProfile(db, cid) {
  db.businessProfiles = db.businessProfiles || {};
  if (!db.businessProfiles[cid]) {
    db.businessProfiles[cid] = { name: '', businessNumber: '', email: '', address: '', managers: [{}, {}], bankConfirmation: null, taxConfirmation: null, additionalDocs: [] };
  }
  const p = db.businessProfiles[cid];
  p.managers = Array.isArray(p.managers) ? p.managers : [{}, {}];
  while (p.managers.length < 2) p.managers.push({});
  p.additionalDocs = Array.isArray(p.additionalDocs) ? p.additionalDocs : [];
  // כתובת רו"ח להעברת הוצאות — פר-חברה. BPM: ברירת המחדל ההיסטורית. חברות אחרות: ריק עד שמגדירים (לא מעבירים לאף אחד).
  if (p.accountantEmail === undefined) p.accountantEmail = (cid === 'co_bpm') ? (process.env.FORWARD_EXPENSE_EMAIL || '516942349@rivh.it') : '';
  // כתובת "מאת" לשליחת מיילים (העברת הוצאות לרו"ח) — פר-חברה. ריק = ברירת המחדל של ה-SMTP.
  if (p.senderEmail === undefined) p.senderEmail = '';
  // כתובת רו"ח לשליחת פירוט עבודות / תלושי משכורת של העובדים — פר-חברה, נפרד לחלוטין מהעברת הוצאות. ריק = לא מוגדר.
  if (p.payrollEmail === undefined) p.payrollEmail = '';
  // חתימת מייל (HTML) — מודבקת מה-Gmail, כולל חותמת/תמונה. מצורפת בתחתית מיילים שנשלחים מהמערכת (פירוט עבודות). ריק = בלי חתימה.
  if (p.emailSignature === undefined) p.emailSignature = '';
  if (p.reportOverdueDays === undefined) p.reportOverdueDays = 0;   // 0 = ברירת המחדל מ-dailyReport.js
  if (p.defaultClassificationId === undefined) p.defaultClassificationId = '';   // סיווג הוצאה שנבחר אוטומטית כשאין לספק סיווג משלו
  // חשבון מייל שולח פר-חברה (Gmail + App Password) — כל חברה שולחת מהתיבה שלה
  if (p.mailUser === undefined) p.mailUser = '';
  if (p.mailPass === undefined) p.mailPass = '';
  if (p.mailFromName === undefined) p.mailFromName = '';
  if (p.mailBodyTemplate === undefined) p.mailBodyTemplate = ''; // ניסוח גוף המייל הקבוע (עם משתנים [שם החברה]/[סוג מסמך]/[מספר מסמך]/[שם הלקוח]). ריק = ברירת מחדל
  if (p.mailSubjectTemplate === undefined) p.mailSubjectTemplate = ''; // ניסוח שורת הנושא הקבועה. ריק = "חברה | סוג | מס' X"
  // שיעור ניכוי מס במקור (fraction). BPM: 5% היסטורי. חברות אחרות: 0 עד שמגדירים. ניתן לשינוי בפרטי העסק.
  if (p.withholdingRate === undefined) p.withholdingRate = (cid === 'co_bpm') ? 0.05 : 0;
  p.withholdingRate = Math.min(0.3, Math.max(0, Number(p.withholdingRate) || 0));
  if (p.docRemark === undefined) p.docRemark = defaultDocRemark(cid);
  try { greenInvoice.setCompanyRemark(cid, p.docRemark); } catch { } // סנכרון: ההערה תוזרק לכל מסמך שנוצר בחברה
  return p;
}
// פרטי חשבון המייל של החברה (Gmail App Password) לשליחת מסמכים "מהתיבה של החברה"
function companyMailCreds(db, cid) {
  const p = bizProfile(db, cid);
  const comp = (db.companies || []).find(c => c.id === cid);
  return { user: (p.mailUser || '').trim(), pass: p.mailPass || '', fromName: (p.mailFromName || p.name || (comp && comp.name) || '').trim() };
}
// החלפת טוקנים בניסוח מייל — תומך גם ב-[...] וגם ב-{...}. משתנים: שם החברה / סוג מסמך / מספר מסמך / שם הלקוח.
function renderMailTokens(tpl, v) {
  let s = String(tpl || '');
  s = s.replace(/\[שם החברה\]|\{שם החברה\}|\{עסק\}/g, v.company || '');
  s = s.replace(/\[סוג מסמך\]|\{סוג מסמך\}|\{סוג\}/g, v.docType || '');
  s = s.replace(/\[מספר מסמך\]|\{מספר מסמך\}|\{מספר\}/g, (v.num != null ? String(v.num) : ''));
  s = s.replace(/\[שם הלקוח\]|\{שם הלקוח\}|\{לקוח\}/g, v.client || '');
  return s;
}
function _mailVals(db, cid, { clientName = '', num = '', docType = '' } = {}) {
  const p = bizProfile(db, cid);
  const company = (p.mailFromName || p.name || '').trim();
  return { p, v: { company, docType: docType || 'מסמך', num, client: clientName } };
}
// גוף המייל הנשלח ללקוח — לפי "ניסוח מייל קבוע" של החברה. ריק = טקסט ברירת מחדל.
function mailBodyFor(db, cid, opts = {}) {
  const { p, v } = _mailVals(db, cid, opts);
  const tpl = String(p.mailBodyTemplate || '').trim();
  if (tpl) return renderMailTokens(tpl, v);
  return `שלום${v.client ? ' ' + v.client : ''},\nמצורף ${v.docType}${v.num ? ' מספר ' + v.num : ''} לעיונכם.\nתודה${v.company ? ', ' + v.company : ''}.`;
}
// שורת הנושא של המייל ללקוח — לפי "ניסוח נושא קבוע" של החברה. ריק = ברירת מחדל "חברה | סוג | מס' X".
function mailSubjectFor(db, cid, opts = {}) {
  const { p, v } = _mailVals(db, cid, opts);
  const tpl = String(p.mailSubjectTemplate || '').trim();
  if (tpl) return renderMailTokens(tpl, v);
  return [v.company, v.docType, v.num ? "מס' " + v.num : ''].filter(Boolean).join(' | ');
}
// חתימת המייל (HTML) של החברה — מוגדרת בפרטי העסק. ריק = אין חתימה.
function emailSigHtml(db, cid) { return String(bizProfile(db, cid).emailSignature || '').trim(); }
// עוטף גוף מייל טקסטואלי כ-HTML מיושר לימין (עברית) ומוסיף את חתימת החברה בתחתית. משמש בכל המיילים היוצאים.
function htmlBodyWithSig(db, cid, textBody) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bodyHtml = esc(textBody).replace(/\n/g, '<br>');
  const sig = emailSigHtml(db, cid);
  return `<div dir="rtl" style="text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1c2333">`
    + bodyHtml
    + (sig ? `<br><br><div dir="rtl" style="text-align:right">${sig}</div>` : '')
    + `</div>`;
}
// GET /api/business-profile?companyId=  (הסיסמה לא מוחזרת לצד לקוח — רק חיווי אם מוגדרת)
add('GET', /^\/api\/business-profile$/, (req, res, _p, q) => {
  const db = load();
  const p = bizProfile(db, q.companyId || giCompanyId());
  json(res, { ...p, mailPass: '', mailPassSet: Boolean(p.mailPass) });
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
  const cid = q.companyId || giCompanyId();
  const p = bizProfile(db, cid);
  const b = body || {};
  ['name', 'businessNumber', 'email', 'address'].forEach(k => { if (k in b) p[k] = String(b[k] || ''); });
  if ('docRemark' in b) p.docRemark = String(b.docRemark || ''); // הערה קבועה לכל המסמכים (פר-חברה)
  if ('accountantEmail' in b) p.accountantEmail = String(b.accountantEmail || '').trim();
  if ('senderEmail' in b) p.senderEmail = String(b.senderEmail || '').trim();
  if ('payrollEmail' in b) p.payrollEmail = String(b.payrollEmail || '').trim();
  if ('emailSignature' in b) p.emailSignature = String(b.emailSignature || '');
  if ('reportOverdueDays' in b) p.reportOverdueDays = Math.max(0, Math.min(365, Number(b.reportOverdueDays) || 0));
  if ('defaultClassificationId' in b) p.defaultClassificationId = String(b.defaultClassificationId || '').trim();
  // חשבון מייל שולח פר-חברה (Gmail). הסיסמה מתעדכנת רק אם נשלח ערך חדש לא-ריק (כדי לאפשר עדכון שאר השדות בלי לשלוח סיסמה שוב).
  if ('mailUser' in b) p.mailUser = String(b.mailUser || '').trim();
  if ('mailFromName' in b) p.mailFromName = String(b.mailFromName || '').trim();
  if ('mailBodyTemplate' in b) p.mailBodyTemplate = String(b.mailBodyTemplate || '');
  if ('mailSubjectTemplate' in b) p.mailSubjectTemplate = String(b.mailSubjectTemplate || '');
  if ('mailPass' in b && String(b.mailPass || '').trim() !== '') p.mailPass = String(b.mailPass).replace(/\s+/g, ''); // App Password — מסירים רווחים
  // שיעור ניכוי מס במקור — מתקבל באחוזים (0..30) ונשמר כ-fraction
  if ('withholdingPct' in b) p.withholdingRate = Math.min(0.3, Math.max(0, (Number(b.withholdingPct) || 0) / 100));
  else if ('withholdingRate' in b) p.withholdingRate = Math.min(0.3, Math.max(0, Number(b.withholdingRate) || 0));
  if (Array.isArray(b.managers)) b.managers.slice(0, 2).forEach((m, i) => {
    p.managers[i] = p.managers[i] || {};
    ['name', 'idNumber', 'phone', 'email'].forEach(k => { if (k in m) p.managers[i][k] = String(m[k] || ''); });
  });
  if ('taxExpiry' in b) { p.taxConfirmation = p.taxConfirmation || {}; p.taxConfirmation.expiry = b.taxExpiry ? String(b.taxExpiry).slice(0, 10) : ''; }
  if ('taxAuthorityRenewedAt' in b) { p.taxAuthority = p.taxAuthority || {}; p.taxAuthority.renewedAt = b.taxAuthorityRenewedAt ? String(b.taxAuthorityRenewedAt).slice(0, 10) : ''; }
  if ('taxAuthorityValidDays' in b) { p.taxAuthority = p.taxAuthority || {}; p.taxAuthority.validDays = Number(b.taxAuthorityValidDays) || 90; }
  save(db); json(res, { ...p, mailPass: '', mailPassSet: Boolean(p.mailPass) });
});
// POST /api/business-profile/mail-test?companyId= — בדיקת חשבון המייל של החברה (Gmail App Password)
add('POST', /^\/api\/business-profile\/mail-test$/, async (req, res, _p, q) => {
  const db = load();
  const creds = companyMailCreds(db, q.companyId || giCompanyId());
  if (!creds.user || !creds.pass) return json(res, { ok: false, error: 'חסרים כתובת מייל וסיסמת אפליקציה — שמור אותם קודם ואז בדוק.' });
  const r = await mailer.verifyMailerFor(creds);
  json(res, r.ok ? { ok: true, user: creds.user } : { ok: false, error: r.error });
});
// POST /api/mail-scan/test?companyId= { since? } — בדיקת קריאת IMAP של תיבת החברה (INBOX): ספירת הודעות ומאז תאריך.
add('POST', /^\/api\/mail-scan\/test$/, async (req, res, _p, q, body) => {
  const db = load();
  const cid = (q && q.companyId) || (body && body.companyId) || giCompanyId();
  const creds = companyMailCreds(db, cid);
  if (!creds.user || !creds.pass) return json(res, { ok: false, error: 'חסרים כתובת מייל וסיסמת אפליקציה — הגדר חשבון מייל בפרטי העסק.' });
  const since = (body && body.since) || (q && q.since) || null;
  const r = await mailReader.imapTest({ user: creds.user, pass: creds.pass }, since);
  json(res, r.ok ? { ok: true, user: creds.user, total: r.total, sinceCount: r.sinceCount, parserOk: r.parserOk, lastSubject: r.lastSubject } : { ok: false, error: r.error });
});

// GET /api/mail-scan/inspect?companyId=&q=&since= — אבחון מבנה הודעות (צרופות/לינקים/טקסט) — כדי ללמוד לחלץ מספק מסוים
add('GET', /^\/api\/mail-scan\/inspect$/, async (req, res, _p, q) => {
  const db = load();
  const cid = (q && q.companyId) || giCompanyId();
  const creds = companyMailCreds(db, cid);
  if (!creds.user || !creds.pass) return json(res, { ok: false, error: 'לחברה זו אין חשבון מייל' });
  const since = (q && q.since) || '2026-08-01';
  const r = await mailReader.inspectMailbox({ user: creds.user, pass: creds.pass }, since, { query: (q && q.q) || '', limit: Math.min(12, Number(q && q.limit) || 6) });
  json(res, r);
});

// ===== סורק מייל → טיוטות הוצאה/רישום לאישור =====
function mailScanState(db, cid) {
  db.mailScan = db.mailScan || {};
  if (!db.mailScan[cid]) db.mailScan[cid] = { seenUids: [], lastScanAt: null, since: null, uploadedHashes: [] };
  if (!Array.isArray(db.mailScan[cid].uploadedHashes)) db.mailScan[cid].uploadedHashes = []; // טביעות אצבע של קבצים שכבר עובדו (הועלו/נדחו/לא-חשבונית) — לא שולחים אותו קובץ ל-AI פעמיים
  // ה-backfill מתחילת 2026 רץ פעם אחת בלבד. אם כבר נסרקו הודעות בעבר — נחשב שהושלם (לא סורקים שוב מתחילת השנה).
  if (db.mailScan[cid].backfillDone == null) db.mailScan[cid].backfillDone = (db.mailScan[cid].seenUids || []).length > 0;
  return db.mailScan[cid];
}
// טביעת אצבע יציבה של תוכן הקובץ (לא תלויה ב-AI) — מזהה את אותו מסמך בדיוק גם בין הרצות
function _fileHash(base64) { try { return crypto.createHash('sha1').update(String(base64 || '')).digest('hex'); } catch { return ''; } }

// אצווה אחת של סריקת מייל לחברה — לוגיקה משותפת ל-endpoint הידני ולסריקה הלילית האוטומטית.
// רצה בהקשר החברה (withCompany) כך שכל קריאות חשבונית ירוקה מכוונות לחברה הנכונה בלבד.
async function mailScanBatchFor(cid, since, limit) {
  return await greenInvoice.withCompany(cid, async () => {
    const creds = companyMailCreds(load(), cid);
    if (!creds.user || !creds.pass) return { ok: false, error: 'לחברה זו אין חשבון מייל מוגדר — הגדר בפרטי העסק.' };
    if (!chatConfigured()) return { ok: false, error: 'AI לא מוגדר (חסר ANTHROPIC_API_KEY).' };
    if (!greenInvoice.haveCredentials()) return { ok: false, error: 'חשבונית ירוקה לא מחוברת' };
    const scan = await mailReader.scanMailbox({ user: creds.user, pass: creds.pass }, since, { excludeUids: mailScanState(load(), cid).seenUids, limit });
    if (!scan.ok) return { ok: false, error: scan.error };
    let suppliers = []; try { suppliers = await greenInvoice.listSuppliers(); } catch { }
    const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/^0+/, '').toLowerCase();
    const _amtEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1;
    // מסמכים שכבר קיימים במערכת — כדי לא להעלות כפילות: הוצאות/רשומות ספקים + טיוטות שכבר קיימות בחשבונית ירוקה
    const db0 = load();
    const existing = [];
    for (const p of (db0.supplierPayables || []).filter(x => (x.companyId || giCompanyId()) === cid)) if (p.number) existing.push({ num: nrm(p.number), amt: Number(p.amount) || 0, sup: nrm(p.supplierName) });
    try { for (const d of (await greenInvoice.expenseDrafts())) if (d.number) existing.push({ num: nrm(d.number), amt: Number(d.amount) || 0, sup: nrm(d.supplierName) }); } catch { }
    // גם הוצאות שכבר אושרו (לא רק טיוטות) — כדי לא להעלות שוב מסמך שכבר נקלט ואושר במערכת
    try { const _to = new Date().toISOString().slice(0, 10); for (const e of (await greenInvoice.expensesInRange(since, _to))) if (e.number) existing.push({ num: nrm(e.number), amt: Number(e.amount) || 0, sup: nrm(e.supplierName) }); } catch { }
    const isExisting = (ai) => {
      const num = nrm(ai.invoiceNumber), amt = ai.amountInclVat, sup = nrm(ai.supplierName);
      return existing.some(x => (num && x.num === num && (amt == null || _amtEq(x.amt, amt))) || (amt != null && _amtEq(x.amt, amt) && sup && x.sup && x.sup === sup));
    };
    let uploaded = 0, recorded = 0, duplicates = 0, skipped = 0, errors = 0, links = 0, unreadable = 0, aiCalls = 0;
    const erroredUids = new Set();               // הודעות שנכשלו זמנית — לא נסמן כ"נסרקו" כדי שינוסו שוב בהרצה הבאה
    const takenUids = new Set();                 // הודעות שמהן נלקח מסמך לקליטה (הועלה/נרשם) — נסמן אותן כ"נקראו" ב-Gmail
    const handledUids = new Set();               // הודעות שטופלו (נקלטו/כפילות/כבר קיים) — לא ייכנסו לרשימת "לטיפול ידני"
    const unresolvedUids = new Set();            // הודעות שמשהו בהן לא נקלט — יישארו לא-נקראות ובטיפול ידני
    const db = load();
    const st = mailScanState(db, cid);
    st.errCounts = st.errCounts || {};           // מונה כשלונות פר-הודעה — כדי להפסיק לנסות מסמכים שנכשלים שוב ושוב
    const uploadedSet = new Set((st.uploadedHashes || []).map(String)); // קבצים שכבר הועלו (טביעת אצבע של התוכן)
    db.mailRecords = db.mailRecords || {}; db.mailRecords[cid] = db.mailRecords[cid] || [];
    db.mailPending = db.mailPending || {}; db.mailPending[cid] = db.mailPending[cid] || []; // חשבוניות בלינק שלא נקלטו — רשת ביטחון
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const it of scan.items) {
      if (it.viaLink) links++;
      // סינון ראשון — לפני ה-AI: אם את הקובץ הזה בדיוק כבר העלינו פעם, מדלגים לגמרי (חוסך גם קריאת AI, מונע כפילות)
      const h = _fileHash(it.contentBase64);
      if (h && uploadedSet.has(h)) {
        duplicates++; if (it.uid != null) handledUids.add(String(it.uid));
        console.log(`[mail-scan] ${cid}: דולג ככפילות (אותו קובץ כבר נקלט) · ${it.filename || '?'} · מ-${it.from || '?'}`);
        continue;
      }
      // תקרת גודל לפני ה-AI. חשבונית אמיתית היא כמעט תמיד מתחת ל-3MB; קובץ כבד מזה הוא
      // בדרך כלל דוח/סריקה של עשרות עמודים, שנספר כעשרות אלפי טוקנים לקריאה אחת.
      // ב-backfill של 15-16.08 רצו 536 קריאות כאלה ושרפו את רוב הקרדיט. הקובץ לא נזרק —
      // הוא נכנס ל"חשבוניות לטיפול" כדי שתראה אותו ותחליט ידנית.
      const _bytes = Math.floor((String(it.contentBase64 || '').length * 3) / 4);
      if (_bytes > AI_FILE_MAX_BYTES) {
        skipped++;
        // לא מסומן כ"טופל" — הוא *לא* טופל. סימון כזה גם היה מסנן אותו מיד
        // מרשימת "לטיפול ידני" (ראה הסינון לפי handledUids בהמשך) וגם משאיר
        // את המייל כנקרא, כך שהחשבונית הייתה נעלמת פעמיים.
        if (it.uid != null) unresolvedUids.add(String(it.uid));
        db.mailPending[cid].push({ uid: it.uid, from: it.from || '', subject: it.subject || '',
          receivedDate: it.receivedDate || '', link: it.link || null, seenAt: new Date().toISOString(),
          reason: `קובץ כבד (${Math.round(_bytes / 1048576)}MB) — לא נשלח ל-AI, טיפול ידני` });
        console.log(`[mail-scan] ${cid}: דילוג על קובץ ${Math.round(_bytes / 1048576)}MB (מעל התקרה) — uid ${it.uid}`);
        continue;
      }
      if (aiDayBudgetLeft(db) <= 0) {
        skipped++;
        console.log(`[mail-scan] ${cid}: נגמר התקציב היומי (${AI_DAY_MAX} קריאות AI) — עוצר, ימשיך מחר`);
        break;
      }
      let ai;
      aiCalls++; // מונה קריאות AI בפועל — משמש לבלם הביטחון (תקרה לכל ריצה)
      aiDayBudgetSpend(db);
      try { ai = await classifyExpenseAttachment(it.contentBase64, it.mime, suppliers); }
      catch (e) {
        errors++;
        const msg = String((e && (e.message || e)) || '');
        // כשל קבוע = מסמך שלא ניתן לקריאה (PDF פגום/ריק) — Claude/Gemini דוחים אותו. אין טעם לנסות שוב.
        const permanent = /no pages|pdf spec|invalid_request|INVALID_ARGUMENT|unsupported|corrupt|not a valid|לא ניתן|פגום|no models/i.test(msg);
        // כשל זמני = מגבלת קצב / עומס / רשת — כן לנסות שוב בהרצה הבאה
        const transient = /429|rate|quota|overload|timeout|ETIMEDOUT|ECONN|network|529|503|502|500/i.test(msg);
        const uidS = String(it.uid);
        const cnt = (st.errCounts[uidS] || 0) + 1;
        if (permanent || (!transient && cnt >= 3)) {
          // מפסיקים לנסות — נסמן כ"נסרק" (לא נכנס ל-erroredUids) כדי שלא ייכשל שוב ושוב לנצח
          unreadable++; delete st.errCounts[uidS];
          if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); } // גם לפי טביעת אצבע — שלא ינסה קובץ זהה ממייל אחר
          console.error(`[mail-scan] ${cid} מסמך לא קריא — מדלגים לצמיתות (uid ${it.uid}): ${msg.slice(0, 120)}`);
        } else {
          st.errCounts[uidS] = cnt; erroredUids.add(uidS); // זמני — ננסה שוב
          console.error(`[mail-scan] ${cid} classify נכשל (uid ${it.uid}, ניסיון ${cnt}):`, msg.slice(0, 140));
        }
        await sleep(400); continue;
      }
      if (st.errCounts[String(it.uid)]) delete st.errCounts[String(it.uid)]; // הצליח — מאפסים מונה כשלונות
      await sleep(250); // קצב — למנוע חריגה ממגבלת ה-AI
      // לא חשבונית (לוגו/חתימה/מסמך שאינו פיננסי) — מדלגים, ושומרים טביעת אצבע כדי לא לנתח את אותו קובץ שוב לעולם (חוסך קרדיט בכל ריצה עתידית).
      if (!ai || ai.route === 'skip' || !ai.isFinancialDoc) { skipped++; if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); } continue; }
      if (isExisting(ai)) { duplicates++; if (it.uid != null) handledUids.add(String(it.uid)); if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); } continue; } // כבר קיים במערכת — לא מעלים, וגם מסמנים את הקובץ כדי לא לנתח אותו שוב
      // כלל: לא מעלים לאישור מסמך שתאריכו לפני 2026 (חשבוניות ישנות שנשלחו/הועברו במייל, או טעויות קריאה כמו 1976/2016).
      // נשמר כטביעת אצבע כדי לא לנתח את אותו קובץ שוב.
      const _docYear = (() => { const m = String(ai.date || '').match(/(20\d{2}|\d{4})/); return m ? +m[1] : null; })();
      if (_docYear && _docYear < 2026) { skipped++; if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); } console.log(`[mail-scan] ${cid}: דולג (מסמך משנת ${_docYear}) · ${ai.supplierName || '?'} · #${ai.invoiceNumber || '?'}`); continue; }
      if (ai.route === 'expense') {
        try {
          await greenInvoice.uploadExpenseFile(it.contentBase64, it.filename, it.mime); uploaded++;
          if (it.uid != null) { takenUids.add(it.uid); handledUids.add(String(it.uid)); }
          existing.push({ num: nrm(ai.invoiceNumber), amt: Number(ai.amountInclVat) || 0, sup: nrm(ai.supplierName) });
          if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); }
          // רישום *מה* נקלט. עד כה נרשם רק המונה המצטבר, ולכן לא היה אפשר לדעת מהלוג
          // אם מסמך מסוים נקלט — שאלה שחוזרת בכל בירור על חשבונית שלא נמצאת.
          console.log(`[mail-scan] ${cid}: נקלט · ${ai.supplierName || '?'} · #${ai.invoiceNumber || '?'} · ${ai.amountInclVat || '?'} · מ-${it.from || '?'}`);
        }
        catch (e) { errors++; erroredUids.add(String(it.uid)); console.error(`[mail-scan] ${cid} העלאה נכשלה (uid ${it.uid}):`, String(e.message || e).slice(0, 160)); }
      } else if (ai.route === 'record') {
        const saved = await saveFile({ employeeId: 'mailscan:' + cid, kind: 'mail-record', filename: it.filename, mime: it.mime, data: it.contentBase64 });
        db.mailRecords[cid].push({ id: 'mr_' + Math.random().toString(16).slice(2, 10), fileId: saved.id, filename: it.filename, mime: it.mime, from: it.from, subject: it.subject, receivedDate: it.receivedDate, documentType: ai.documentType, supplierName: ai.supplierName, number: ai.invoiceNumber, date: ai.date, amountInclVat: ai.amountInclVat, description: ai.description, recordedAt: new Date().toISOString() });
        if (h) { uploadedSet.add(h); st.uploadedHashes.push(h); } // נשמר — לא לנתח שוב את אותו קובץ
        if (it.uid != null) { takenUids.add(it.uid); handledUids.add(String(it.uid)); }
        recorded++;
      } else {
        skipped++;
        console.log(`[mail-scan] ${cid}: דולג (סווג "${ai.route || 'לא חשבונית'}") · ${ai.supplierName || '?'} · #${ai.invoiceNumber || '?'} · ${it.filename || '?'} · מ-${it.from || '?'}`);
      }
    }
    const seenUidSet = new Set(st.seenUids.map(String));
    // מסמנים כ"נסרקו" רק הודעות שלא נכשלו — כדי שכשלים ינוסו שוב בהרצה הבאה (ולא ייעלמו)
    (scan.processedUids || []).forEach(u => { const s = String(u); if (!seenUidSet.has(s) && !erroredUids.has(s)) st.seenUids.push(u); });
    // רשת ביטחון: כל מייל שנראה כמו חשבונית אך *לא* טופל (לא נקלט, לא כפילות) — נרשם לרשימת "לטיפול ידני" כדי שלא ייעלם
    const pend = db.mailPending[cid];
    const pendUids = new Set(pend.map(p => String(p.uid)));
    for (const u of (scan.candidates || [])) {
      if (handledUids.has(String(u.uid))) continue; // נקלט/כפילות — לא מוסיפים
      if (pendUids.has(String(u.uid))) continue;
      pend.push({ uid: u.uid, from: u.from || '', subject: u.subject || '', receivedDate: u.receivedDate || '', link: u.link || null, seenAt: new Date().toISOString() });
      pendUids.add(String(u.uid));
    }
    // הודעות שטופלו עכשיו — יורדות מרשימת ה"לטיפול ידני"
    if (handledUids.size) db.mailPending[cid] = db.mailPending[cid].filter(p => !handledUids.has(String(p.uid)));
    if (db.mailPending[cid].length > 300) db.mailPending[cid] = db.mailPending[cid].slice(-300);
    st.since = since; st.lastScanAt = new Date().toISOString();
    save(db);
    // סימון כ"נקרא" ב-Gmail — רק להודעה שכל מה שנמצא בה נקלט בפועל.
    // מייל אחד יכול להכיל כמה צרופות/קישורים: אם אחד נקלט ואחר נכשל, סימון כנקרא
    // היה מסתיר את הכישלון לגמרי. מייל שנשאר לא-נקרא הוא החיווי היחיד שנותר.
    const _seenNow = [...takenUids].filter(u => !unresolvedUids.has(String(u)) && !erroredUids.has(String(u))
      && !db.mailPending[cid].some(p => String(p.uid) === String(u)));
    const _held = takenUids.size - _seenNow.length;
    if (_held) console.log(`[mail-scan] ${cid}: ${_held} הודעות נשארו לא-נקראות — משהו בהן לא נקלט`);
    let markedSeen = 0;
    if (_seenNow.length) { try { const mr = await mailReader.markMessagesSeen({ user: creds.user, pass: creds.pass }, _seenNow); markedSeen = (mr && mr.count) || 0; } catch { } }
    return { ok: true, processed: (scan.processedUids || []).length, uploaded, recorded, duplicates, skipped, errors, unreadable, links, aiCalls, markedSeen, pending: (db.mailPending[cid] || []).length, remaining: scan.remaining, done: scan.remaining === 0 };
  });
}

// POST /api/mail-scan/run?companyId= { since?, limit? } — אצווה אחת; חוזר עם remaining (הצד-לקוח לולאה עד done).
add('POST', /^\/api\/mail-scan\/run$/, async (req, res, _p, q, body) => {
  const cid = (q && q.companyId) || (body && body.companyId) || giCompanyId();
  const since = (body && body.since) || mailScanState(load(), cid).since || '2026-06-01';
  const limit = Math.min(12, Math.max(1, Number(body && body.limit) || 5));
  // rescan=1 — שוכח אילו הודעות כבר נסרקו, כדי שהסורק יבחן אותן מחדש. נדרש אחרי
  // שיפור ביכולת הקליטה (למשל תמיכה ב-winmail.dat): הודעה שדולגה בעבר סומנה
  // כ"נסרקה" ומוחרגת לצמיתות, ולכן התיקון לעולם לא היה מגיע אליה.
  if (body && body.rescan) {
    const d = load(); const st0 = mailScanState(d, cid);
    const n = (st0.seenUids || []).length;
    st0.seenUids = []; st0.errCounts = {};
    save(d);
    console.log(`[mail-scan] ${cid}: סריקה מחדש — ${n} הודעות שנסרקו בעבר ייבחנו שוב`);
  }
  const r = await mailScanBatchFor(cid, since, limit);
  json(res, r.ok ? r : { ok: false, error: r.error });
});

// ===== סריקה לילית אוטומטית לכל החברות =====
// סורק את כל טווח הזמן (מ-since) עד שאין עוד — באצוות קטנות כדי לא להעמיס. seenUids מונע כפילויות בין לילות.
async function runMailScanFull(cid, since, maxBatches = 400, aiCap = 40) {   // aiCap היה 400 — אפשר 433 קריאות ביום אחד
  const tot = { uploaded: 0, recorded: 0, duplicates: 0, skipped: 0, errors: 0, unreadable: 0, links: 0, aiCalls: 0, batches: 0, completed: false, cappedAt: null };
  let done = false, i = 0;
  while (!done && i++ < maxBatches) {
    let r;
    try { r = await mailScanBatchFor(cid, since, 4); } catch { tot.errors++; break; }
    if (!r || !r.ok) break;
    tot.uploaded += r.uploaded || 0; tot.recorded += r.recorded || 0; tot.duplicates += r.duplicates || 0;
    tot.skipped += r.skipped || 0; tot.errors += r.errors || 0; tot.unreadable += r.unreadable || 0; tot.links += r.links || 0; tot.aiCalls += r.aiCalls || 0; tot.batches++;
    done = !!r.done;
    // בלם ביטחון — לא לחרוג ממכסת קריאות AI לריצה אחת. מה שלא עובד היום יעובד בריצה הבאה (לא סומן "נסרק"), אז שום מייל לא מתפספס.
    if (tot.aiCalls >= aiCap) { tot.cappedAt = tot.aiCalls; console.log(`[mail-scan] ${cid}: הגיע לתקרת ${aiCap} קריאות AI לריצה — עוצר, ימשיך בריצה הבאה`); break; }
  }
  tot.completed = done; // הגענו לסוף הטווח (אין עוד הודעות) — אפשר לסמן backfill כהושלם
  return tot;
}
// טביעת אצבע של קובץ הטיוטה (מהקישור בחשבונית ירוקה) — לזיהוי שתי טיוטות מאותו קובץ בדיוק, גם כשאין מספר OCR.
async function _draftFileHash(url) {
  if (!url) return '';
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    clearTimeout(to);
    if (!r || !r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return '';
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch { clearTimeout(to); return ''; }
}
// ניקוי כפילויות: מוחק טיוטות הוצאה שכבר קיימות במערכת (הוצאה שנקלטה / רשומה) — לפי מספר+סכום,
// וגם שתי טיוטות זהות זו-לזו: לפי מספר+סכום, ואם אין מספר — לפי טביעת אצבע של תוכן הקובץ. פר-חברה (withCompany).
async function dedupeCompanyDrafts(cid, fromDate) {
  return await greenInvoice.withCompany(cid, async () => {
    let deleted = 0;
    try {
      greenInvoice.clearDataCache();
      const drafts = await greenInvoice.expenseDrafts();
      if (!drafts || !drafts.length) return 0;
      const today = new Date().toISOString().slice(0, 10);
      let expenses = [];
      try { expenses = await greenInvoice.expensesInRange(fromDate || '2026-01-01', today); } catch { }
      const nrm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/^0+/, '').toLowerCase();
      const amtEq = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1;
      // מסמכים שכבר קיימים במערכת: הוצאות בפועל בחשבונית ירוקה + רשומות ספקים מקומיות (כולל שהותאמו בבנק)
      const existing = [];
      for (const e of (expenses || [])) if (e.number) existing.push({ num: nrm(e.number), amt: Number(e.amount) || 0 });
      const db = load();
      for (const p of (db.supplierPayables || []).filter(x => (x.companyId || giCompanyId()) === cid)) if (p.number) existing.push({ num: nrm(p.number), amt: Number(p.amount) || 0 });
      const seenDraft = new Set();
      const hashCache = {};   // id → file hash, כדי לא להוריד פעמיים
      for (const d of drafts) {
        const num = nrm(d.number);
        let dk, isDupExisting = false;
        if (num) {
          const amt = d.amount != null ? Number(d.amount) : null;
          isDupExisting = existing.some(x => x.num === num && (amt == null || amtEq(x.amt, amt)));
          dk = num + '|' + (amt != null ? Math.round(amt) : 'x');
        } else {
          // אין מספר OCR — מזהים כפילות לפי טביעת אצבע של תוכן הקובץ
          const h = await _draftFileHash(d.url); hashCache[d.id] = h;
          if (!h) continue;           // לא הצלחנו להוריד/לגבב — משאירים ולא נוגעים
          dk = 'h:' + h;
        }
        const isDupDraft = seenDraft.has(dk);
        if (isDupExisting || isDupDraft) {
          try { await greenInvoice.deleteExpenseDraft(d.id); deleted++; }
          catch { /* ה-API אולי לא תומך במחיקה — מדלגים */ }
        } else { seenDraft.add(dk); }
      }
    } catch (e) { console.error(`[mail-dedupe] ${cid} נכשל:`, e.message); }
    return deleted;
  });
}
// POST /api/mail-scan/dedupe?companyId= { since? } — ניקוי כפילויות ידני לחברה
add('POST', /^\/api\/mail-scan\/dedupe$/, async (req, res, _p, q, body) => {
  const cid = (q && q.companyId) || (body && body.companyId) || giCompanyId();
  const from = (body && body.since) || (load().mailAutoScan && load().mailAutoScan.since) || '2026-01-01';
  const deleted = await dedupeCompanyDrafts(cid, from);
  json(res, { ok: true, deleted });
});

let _nightlyMailRunning = false;
// תקרת גודל לקובץ שנשלח לקריאת AI — הגנה מפני שריפת קרדיט על מסמכים כבדים
const AI_FILE_MAX_BYTES = Number(process.env.AI_FILE_MAX_MB || 3) * 1024 * 1024;
// תקציב יומי של קריאות AI לקליטת מייל, חוצה חברות. התקרה שהייתה קיימת (400 לכל חברה
// בכל ריצה) אפשרה 433 קריאות ביום אחד ב-backfill — רוב שריפת הקרדיט. זו תקרה אמיתית:
// כשנגמרת, הקליטה ממשיכה מחר. מייל אמיתי הוא 6-14 קריאות ביום, אז זה לא מפריע בשגרה.
const AI_DAY_MAX = Number(process.env.AI_DAY_MAX || 80);
function aiDayBudgetLeft(db) {
  const today = new Date().toISOString().slice(0, 10);
  const a = db.mailAutoScan && db.mailAutoScan.aiDay;
  if (!a || a.date !== today) return AI_DAY_MAX;
  return Math.max(0, AI_DAY_MAX - (Number(a.count) || 0));
}
function aiDayBudgetSpend(db, n = 1) {
  const today = new Date().toISOString().slice(0, 10);
  db.mailAutoScan = db.mailAutoScan || {};
  const a = db.mailAutoScan.aiDay;
  db.mailAutoScan.aiDay = (a && a.date === today) ? { date: today, count: (Number(a.count) || 0) + n } : { date: today, count: n };
}
async function runNightlyMailScan(sinceOverride, resetSeen, opts = {}) {
  if (_nightlyMailRunning) return { skipped: 'כבר רץ' };
  _nightlyMailRunning = true;
  const per = {};
  try {
    const db = load();
    // טווח ה-backfill החד-פעמי (מתחילת 2026). אחרי שהושלם — סורקים רק חלון קצר של מייל חדש.
    const backfillSince = sinceOverride || (db.mailAutoScan && db.mailAutoScan.since) || '2026-01-01';
    const INCREMENTAL_DAYS = 21; // חלון מתגלגל למייל חדש (עם חפיפה קטנה לביטחון; seenUids/hash מונעים כפילויות)
    const incSince = (() => { const d = new Date(); d.setDate(d.getDate() - INCREMENTAL_DAYS); return d.toISOString().slice(0, 10); })();
    const companies = (db.companies || []).map(c => c.id);
    // reset ידני = בקשה מפורשת ל-backfill מלא מחדש: מאפסים "נסרקו" וגם את דגל ה-backfill.
    // reset ידני = בקשה מפורשת ל-backfill מלא מחדש: מאפסים "נסרקו", דגל ה-backfill, וגם את טביעות האצבע של הקבצים —
    // כדי שמסמכים שדולגו בעבר (למשל עסקה/זיכוי שלא נקלטו קודם) ייסרקו מחדש. כפילויות אמיתיות נחסמות ע"י isExisting.
    if (resetSeen) { const d = load(); for (const cid of companies) { const s = mailScanState(d, cid); s.seenUids = []; s.backfillDone = false; s.uploadedHashes = []; s.errCounts = {}; } save(d); console.log('[mail-nightly] reset מלא — seenUids + uploadedHashes + backfillDone אופסו לכל החברות'); }
    for (const cid of companies) {
      const creds = companyMailCreds(load(), cid);
      if (!creds.user || !creds.pass) { per[cid] = { skipped: 'אין חשבון מייל' }; continue; }
      const st0 = mailScanState(load(), cid);
      // backfill מתחילת השנה — פעם אחת בלבד; אחר כך רק מייל חדש (חלון מתגלגל). חוסך את עיקר הקרדיט.
      const effSince = st0.backfillDone ? incSince : backfillSince;
      try { per[cid] = await runMailScanFull(cid, effSince); if (per[cid]) per[cid].mode = st0.backfillDone ? 'incremental' : 'backfill'; }
      catch (e) { per[cid] = { error: e.message }; }
      // סימון שה-backfill הושלם — כדי שלא נסרוק שוב מתחילת השנה (רק אם הריצה הגיעה לסוף הטווח בהצלחה)
      if (!st0.backfillDone && per[cid] && per[cid].completed) { const d2 = load(); mailScanState(d2, cid).backfillDone = true; save(d2); console.log(`[mail-nightly] ${cid}: backfill הושלם — מכאן סריקה מצטברת בלבד`); }
      // אחרי הקליטה — ניקוי כפילויות מול מסמכים שכבר קיימים במערכת (פר-חברה). מדלגים בסריקות התכופות (כל 15 דק') כדי לא להוריד קבצי טיוטה שוב ושוב — הניקוי רץ בלילה.
      if (!opts.skipDedupe) { try { const del = await dedupeCompanyDrafts(cid, backfillSince); if (per[cid] && typeof per[cid] === 'object') per[cid].dupsDeleted = del; } catch { } }
      try { console.log(`[mail-nightly] ${cid}:`, JSON.stringify(per[cid])); } catch { }
    }
    const db2 = load();
    db2.mailAutoScan = { ...(db2.mailAutoScan || {}), enabled: true, since: backfillSince, lastRun: { at: new Date().toISOString(), per } };
    save(db2);
    console.log('[mail-nightly] הסתיים', new Date().toISOString());
  } catch (e) { console.error('[mail-nightly] נכשל:', e.message); }
  finally { _nightlyMailRunning = false; }
  return { ok: true, per };
}
function scheduleNightlyMailScan() {
  const HOUR_UTC = 23, MIN_UTC = 30; // ~02:30 שעון ישראל — לילה, מוכן לבוקר
  const msToNext = () => {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR_UTC, MIN_UTC, 0, 0));
    if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  };
  const arm = () => { setTimeout(async () => { await runNightlyMailScan(); arm(); }, msToNext()); };
  arm();
  console.log(`[mail-nightly] מתוזמן — ריצה ראשונה בעוד ~${Math.round(msToNext() / 60000)} דק'`);
  // סריקה תכופה כל 15 דקות — קליטה "חיה" של מייל חדש. מצטברת בלבד (רק מייל חדש, בלי backfill, בלי dedupe כבד).
  // ה-guard _nightlyMailRunning מונע חפיפה עם הריצה הלילית.
  const POLL_MIN = 45;   // היה 15 — 96 ריצות ביום על שלוש חברות, כמעט תמיד בלי מייל חדש
  setInterval(() => { runNightlyMailScan(undefined, false, { skipDedupe: true }).catch(() => {}); }, POLL_MIN * 60 * 1000);
  console.log(`[mail-poll] סריקה תכופה מתוזמנת — כל ${POLL_MIN} דקות (מצטברת)`);
}
// POST /api/mail-scan/nightly-now { since? } — הפעלה ידנית של הסריקה המלאה לכל החברות (רקע). לא ממתין לסיום.
add('POST', /^\/api\/mail-scan\/nightly-now$/, async (req, res, _p, q, body) => {
  if (_nightlyMailRunning) return json(res, { ok: false, error: 'סריקה כבר רצה כרגע' });
  const since = (body && body.since) || undefined;
  const reset = !!(body && body.reset);
  runNightlyMailScan(since, reset); // רקע — לא await
  json(res, { ok: true, started: true, reset, since: since || 'ברירת מחדל (01/01/2026)' });
});
// GET /api/mail-scan/nightly-status — תוצאת הריצה האחרונה
add('GET', /^\/api\/mail-scan\/nightly-status$/, (req, res) => {
  const a = load().mailAutoScan || {};
  json(res, { ok: true, running: _nightlyMailRunning, since: a.since || '2026-01-01', lastRun: a.lastRun || null });
});
// GET /api/mail-scan/pending?companyId= — חשבוניות שהגיעו כלינק ולא נקלטו אוטומטית (לטיפול ידני)
add('GET', /^\/api\/mail-scan\/pending$/, (req, res, _p, q) => {
  const db = load();
  const cid = q.companyId || giCompanyId();
  const list = ((db.mailPending || {})[cid] || []).slice()
    .sort((a, b) => String(b.receivedDate || b.seenAt || '').localeCompare(String(a.receivedDate || a.seenAt || '')));
  json(res, { ok: true, pending: list, count: list.length });
});
// POST /api/mail-scan/pending/dismiss { uid | all } — הסרת פריט/הכל מרשימת הטיפול הידני
add('POST', /^\/api\/mail-scan\/pending\/dismiss$/, (req, res, _p, q, body) => {
  const db = load();
  const cid = (body && body.companyId) || q.companyId || giCompanyId();
  db.mailPending = db.mailPending || {};
  const before = (db.mailPending[cid] || []).length;
  if (body && body.all) db.mailPending[cid] = [];
  else db.mailPending[cid] = (db.mailPending[cid] || []).filter(p => String(p.uid) !== String(body && body.uid));
  save(db);
  json(res, { ok: true, removed: before - (db.mailPending[cid] || []).length });
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
  // בידוד: עובד ללא companyId שייך ל-BPM (מוסכמה). בלי זה עובדי BPM דלפו לחישוב של חברות אחרות.
  const _ecid = emp.companyId || 'co_bpm';
  const emps = (db.employees || []).filter(e => (e.companyId || 'co_bpm') === _ecid);
  const pay = employeePayForMonth(companyEvents(db, emp.companyId), q.month, emps).find(p => p.name === emp.name);
  json(res, { employee: emp, month: q.month, pay: pay || { shifts: [], base: 0, bonus: 0, total: 0 } });
});

// POST /api/interpret-bonuses  { note, employees:[names] } — מפרש הוראת בונוס להחלה על עובדים
add('POST', /^\/api\/interpret-bonuses$/, async (req, res, _p, q, body) => {
  try {
    const note = body?.note || '';
    const result = await interpretBonuses(note, body?.employees || []);
    if (!Array.isArray(result)) return json(res, result);
    const cid = reqCompany(q, body);
    const db = load();
    const baseMap = {}, defMap = {};
    for (const e of (db.employees || [])) {
      if ((e.companyId || 'co_bpm') !== cid) continue;   // בידוד: עובד ללא תיוג = BPM
      const nm = String(e.name).trim();
      if (e.baseRate != null && e.baseRate !== '') baseMap[nm] = Number(e.baseRate);
      if (e.bonus != null && e.bonus !== '') defMap[nm] = Number(e.bonus);
    }
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const knownNames = new Set([...Object.keys(baseMap), ...Object.keys(defMap)]);
    // התאמה דו-כיוונית: השם לפני מילת-המפתח או אחריה, כולל "ל"/"-"/":" מפרידים.
    // תופס גם "אליאל בונוס" וגם "בונוס לאליאל", גם "מתן כפולה" וגם "כפולה למתן".
    const kwNear = (nm, kw) => {
      if (!nm) return false;
      const n = esc(nm);
      // מרשה גם חיבור "ו" בין השם למילת-המפתח: "מתן ובונוס", "מתן-בונוס", "מתן בונוס"
      return new RegExp(n + '\\s*[-:]?\\s*(?:ו)?(?:' + kw + ')').test(note)
          || new RegExp('(?:ו)?(?:' + kw + ')\\s*(?:ל)?\\s*[-:]?\\s*' + n).test(note);
    };
    const nameDouble = (nm) => kwNear(nm, 'כפולה');
    const nameHalf = (nm) => kwNear(nm, 'יומית\\s*וחצי');
    const nameBonus = (nm) => kwNear(nm, 'בונוס|תוספת');
    // מילת-מפתח ללא שם עובד מוכר צמוד אליה (למשל "יומית וחצי שניהם", "כפולה לכולם") → חל על כל העובדים באירוע
    const anyKnownNear = (kwFn) => [...knownNames].some(nm => kwFn(nm));
    const globalDouble = /כפולה/.test(note) && !anyKnownNear(nameDouble);
    const globalHalf = /יומית\s*וחצי/.test(note) && !anyKnownNear(nameHalf);
    // "בונוס לכולם" / "בונוס לשניהם" — מילת בונוס ללא שם עובד מוכר צמוד → כל עובד מקבל את הבונוס הקבוע שלו
    const globalBonus = /בונוס|תוספת/.test(note) && !anyKnownNear(nameBonus);
    // סכום שנכתב במפורש ליד "בונוס"/"תוספת" ("בונוס 1000", "1000 בונוס", "תוספת של 250").
    // כשיש סכום כזה הוא גובר על הבונוס הקבוע של העובד — הבונוס הקבוע נועד ל"בונוס לכולם" בלי מספר.
    const AMT = '(\\d{1,7}(?:[.,]\\d{1,2})?)';
    const amts = [
      ...note.matchAll(new RegExp('(?:בונוס|תוספת)\\s*(?:של\\s*)?(?:₪\\s*)?' + AMT, 'g')),
      ...note.matchAll(new RegExp(AMT + '\\s*(?:₪|ש"?ח)?\\s*(?:בונוס|תוספת)', 'g')),
      // גם סכום שצמוד למילת "כולל"/"סה״כ" ולא לבונוס עצמו ("סה״כ 1000 כולל בונוס", "כולל 1000").
      // רלוונטי רק כשההערה כבר הוכרה כהוראת בונוס, ולכן לא תופס מספרים אקראיים.
      ...note.matchAll(new RegExp('(?:כולל|סה"כ|סה״כ|סהכ|ביחד|בסך\\s*הכל)\\s*(?:של\\s*)?(?:₪\\s*)?' + AMT, 'g')),
      ...note.matchAll(new RegExp(AMT + '\\s*(?:₪|ש"?ח)?\\s*(?:כולל|סה"כ|סה״כ|סהכ|ביחד)', 'g')),
    ].map(m => Number(String(m[1]).replace(',', '.'))).filter(n => !isNaN(n));
    const hasExplicitAmount = amts.length > 0;
    const uniqAmts = [...new Set(amts)];
    const explicitAmount = uniqAmts.length === 1 ? uniqAmts[0] : null;  // כמה סכומים שונים → סומכים על הפירוש פר-עובד
    // "כולל" / "סה״כ" / "ביחד" → הסכום שנכתב הוא הסך הכולל לעובד, והבונוס הוא ההפרש מהיומית שלו
    const isTotalNote = /כולל|סה"כ|סה״כ|סהכ|ביחד|בסך\s*הכל/.test(note);
    // "ללא בונוס" — אסור שהבונוס הקבוע יידרס לתוכו
    const noBonusNote = /(?:ללא|בלי|אין)\s*בונוס/.test(note);
    // הבונוס הקבוע של העובד חל רק כשההערה לא נקבה בסכום ולא ביטלה את הבונוס
    const useDefaultBonus = !hasExplicitAmount && !noBonusNote;
    // מחשב את הבונוס לעובד לפי הסכום שנכתב: במצב "כולל" — הסכום פחות היומית שלו
    const bonusFromNote = (amt, base, r) => {
      if (amt == null) return false;
      if (isTotalNote) {
        if (base == null) { r.bonus = amt; r.baseMissing = true; }
        else { r.bonus = Math.max(0, +(amt - base).toFixed(2)); r.noteTotal = amt; r.totalAsBonus = true; }
      } else r.bonus = amt;
      r.bonusFactor = null;
      if (r.factor == null || r.factor === '') r.factor = '1';
      return true;
    };
    for (const r of result) {
      const nm = String(r.name || '').trim();
      const base = baseMap[nm];
      // "כפולה" = יומית (פקטור 1) + בונוס בגובה היומית של אותו עובד. גובר על בונוס קבוע.
      if (Number(r.factor) === 2 || nameDouble(nm) || globalDouble) {
        r.factor = '1';
        if (base != null) { r.bonus = base; r.bonusFactor = null; r.doubleAsBonus = true; }
        continue;
      }
      // "יומית וחצי" = יומית (פקטור 1) + בונוס בגובה חצי מהיומית של אותו עובד. גובר על בונוס קבוע.
      if (Number(r.factor) === 1.5 || nameHalf(nm) || globalHalf) {
        r.factor = '1';
        if (base != null) { r.bonus = Math.round(base / 2); r.bonusFactor = null; r.halfAsBonus = true; }
        continue;
      }
      // "בונוס"/"תוספת" ליד שם העובד או כללי ("לכולם") → הבונוס הקבוע שהוגדר לעובד
      if (nameBonus(nm) || globalBonus) {
        if (hasExplicitAmount) {
          // סכום מפורש בהערה — הוא הקובע. אם נכתבו כמה סכומים שונים, לוקחים את זה שה-AI ייחס לעובד.
          bonusFromNote(explicitAmount != null ? explicitAmount : (r.bonus != null ? Number(r.bonus) : null), base, r);
        } else if (useDefaultBonus) {
          const def = defMap[nm];
          if (def != null) { r.bonus = def; r.bonusFactor = null; r.defaultBonus = true; if (r.factor == null || r.factor === '') r.factor = '1'; }
        }
      }
    }
    // רשת ביטחון: עובד שמופיע בתיאור עם "כפולה"/"בונוס"/"תוספת" אך ה-AI לא זיהה — נוסיף אותו ידנית
    const present = new Set(result.map(r => String(r.name || '').trim()));
    for (const nm of knownNames) {
      if (present.has(nm)) continue;
      if (nameDouble(nm)) {
        const base = baseMap[nm];
        result.push({ name: nm, factor: '1', bonus: base != null ? base : null, bonusFactor: null, doubleAsBonus: true });
        present.add(nm);
      } else if (nameHalf(nm)) {
        const base = baseMap[nm];
        result.push({ name: nm, factor: '1', bonus: base != null ? Math.round(base / 2) : null, bonusFactor: null, halfAsBonus: true });
        present.add(nm);
      } else if (nameBonus(nm)) {
        if (hasExplicitAmount) {
          const r = { name: nm, factor: '1', bonus: null, bonusFactor: null };
          if (bonusFromNote(explicitAmount, baseMap[nm], r)) { result.push(r); present.add(nm); }
        } else if (useDefaultBonus) {
          const def = defMap[nm];
          if (def != null) { result.push({ name: nm, factor: '1', bonus: def, bonusFactor: null, defaultBonus: true }); present.add(nm); }
        }
      }
    }
    // רשת ביטחון גלובלית: הוראה שאין בה שם עובד ("כולל בונוס 1000", "בונוס לכולם", "כפולה")
    // חלה על כל עובדי האירוע. חיונית כשה-AI מחזיר ריק (עומס/כשל/ניסוח לא מוכר) — בלעדיה
    // ההוראה נבלעת והמשתמש מקבל "לא זוהתה הוראת בונוס/תשלום תקפה".
    const eventNames = (Array.isArray(body?.employees) ? body.employees : []).map(n => String(n || '').trim()).filter(Boolean);
    for (const nm of eventNames) {
      if (present.has(nm)) continue;
      const base = baseMap[nm];
      if (globalDouble) { result.push({ name: nm, factor: '1', bonus: base != null ? base : null, bonusFactor: null, doubleAsBonus: true }); present.add(nm); continue; }
      if (globalHalf) { result.push({ name: nm, factor: '1', bonus: base != null ? Math.round(base / 2) : null, bonusFactor: null, halfAsBonus: true }); present.add(nm); continue; }
      if (!globalBonus) continue;
      const r = { name: nm, factor: '1', bonus: null, bonusFactor: null };
      if (hasExplicitAmount) { if (bonusFromNote(explicitAmount, base, r)) { result.push(r); present.add(nm); } }
      else if (noBonusNote) { r.bonus = 0; result.push(r); present.add(nm); }
      else if (useDefaultBonus) { const def = defMap[nm]; if (def != null) { r.bonus = def; r.defaultBonus = true; result.push(r); present.add(nm); } }
    }
    json(res, result);
  } catch (e) { json(res, { error: e.message }, 200); }
});

// GET /api/ai-usage — פירוט צריכת ה-AI מאז עליית השרת (הנהלה בלבד).
// נועד להחליף ניחושים במדידה: כמה עולה כל סוג קריאה בפועל.
add('GET', /^\/api\/ai-usage$/, (req, res) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  const rows = Object.entries(aiUsage.byLabel)
    .map(([label, e]) => ({ label, ...e, cost: +e.cost.toFixed(4), avgCost: +(e.cost / Math.max(1, e.calls)).toFixed(5) }))
    .sort((a, b) => b.cost - a.cost);
  json(res, {
    ok: true, since: aiUsage.since, calls: aiUsage.calls,
    totalCost: +rows.reduce((t, r) => t + r.cost, 0).toFixed(4),
    rows,
  });
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
  try { json(res, { classifications: await greenInvoice.listAccountingClassifications() }); }
  catch (e) { json(res, { classifications: [], error: e.message }); }
});

// POST /api/clients — יצירת לקוח חדש בחשבונית ירוקה
add('POST', /^\/api\/clients$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.name) return json(res, { error: 'חסר שם' }, 400);
  try { json(res, { ok: true, client: await greenInvoice.createClient(body) }); }
  catch (e) {
    // errorCode 1010 — לקוח עם אותו ח.פ כבר קיים בחשבונית ירוקה. errorMessage מכיל את מזהה הלקוח הקיים; נחזיר אותו כהצלחה.
    const msg = String(e.message || '');
    const uuid = (msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    if (/1010/.test(msg) && uuid) {
      try { return json(res, { ok: true, existed: true, client: await greenInvoice.getClient(uuid) }); }
      catch { return json(res, { ok: true, existed: true, client: { id: uuid, name: body.name } }); }
    }
    json(res, { error: e.message }, 500);
  }
});

// POST /api/suppliers — יצירת ספק חדש בחשבונית ירוקה
add('POST', /^\/api\/suppliers$/, async (req, res, _p, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  if (!body?.name) return json(res, { error: 'חסר שם' }, 400);
  try { json(res, { ok: true, supplier: await greenInvoice.createSupplier(body) }); }
  catch (e) {
    // errorCode 1010 — ספק עם אותו ח.פ כבר קיים; נחזיר את המזהה הקיים כהצלחה
    const msg = String(e.message || '');
    const uuid = (msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    if (/1010/.test(msg) && uuid) return json(res, { ok: true, existed: true, supplier: { id: uuid, name: body.name } });
    json(res, { error: e.message }, 500);
  }
});

// GET /api/clients/:id/details — פרטי לקוח מלאים (טלפון, ח.פ, מיילים) למילוי חלונית העריכה (הרשימה מחזירה רק שם/מייל)
add('GET', /^\/api\/clients\/([^/]+)\/details$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const c = await greenInvoice.getClient(params[0]);
    const emails = Array.isArray(c.emails) ? c.emails.filter(Boolean) : [];
    json(res, { ok: true, client: { name: c.name || '', phone: c.phone || c.mobile || '', taxId: c.taxId || '', emails, email: emails[0] || '' } });
  } catch (e) { json(res, { error: e.message }, 500); }
});
// GET /api/suppliers/:id/details — פרטי ספק מלאים (למילוי חלונית העריכה)
add('GET', /^\/api\/suppliers\/([^/]+)\/details$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const c = await greenInvoice.getSupplier(params[0]);
    const emails = Array.isArray(c.emails) ? c.emails.filter(Boolean) : [];
    json(res, { ok: true, client: { name: c.name || '', phone: c.phone || c.mobile || '', taxId: c.taxId || '', emails, email: emails[0] || '' } });
  } catch (e) { json(res, { error: e.message }, 500); }
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
  return { ok: false, error: 'לא נתמך' };
}

// כרטיס חיבור בודד. isOwner=האם החברה הנוכחית היא בעלת חיבור זה (הסודות גלובליים ושייכים לחברה אחת).
// חברה שאינה בעלת החיבור רואה "לא מחובר" בתצוגה-בלבד (readonly) — בלי טופס חיבור, כדי לא לדרוס בטעות חיבור של חברה אחרת.
// טעינת מפתחות החיבורים פר-חברה מבסיס הנתונים לזיכרון (עליית שרת + אחרי כל חיבור)
function hydrateConnCreds() {
  const db = load();
  const cc = db.connCreds || {};
  for (const cid of Object.keys(cc)) {
    const gi = cc[cid].greenInvoice;
    if (gi && gi.GREENINVOICE_API_KEY_ID && gi.GREENINVOICE_API_SECRET) {
      greenInvoice.setDbCreds(cid, { id: gi.GREENINVOICE_API_KEY_ID, secret: gi.GREENINVOICE_API_SECRET });
    }
    const cal = cc[cid].googleCalendar;
    if (cal) setDbIcal(cid, [cal.GOOGLE_ICAL_URL, cal.GOOGLE_ICAL_URL_2, cal.GOOGLE_ICAL_URL_3].filter(Boolean));
  }
}

// ---- סיכום יומי פר-חברה ----
// נשלח ב-07:00 לתיבת כל חברה, ורק אם יש בו משהו שדורש פעולה.
const REPORT_HOUR_UTC = 4, REPORT_MIN_UTC = 0;   // 07:00 שעון ישראל
let _lastReport = null;

async function gatherReportData(cid) {
  const db = load();
  const prof = bizProfile(db, cid);
  const comp = (db.companies || []).find(c => c.id === cid);
  const overdueDays = Number(prof.reportOverdueDays) > 0 ? Number(prof.reportOverdueDays) : DEFAULT_OVERDUE_DAYS;
  const out = {
    companyName: (prof.mailFromName || prof.name || (comp && comp.name) || '').trim(),
    overdueDays, appUrl: (process.env.APP_URL || 'https://asfinance.co.il'),
    overdueInvoices: [], uninvoicedEvents: [], payablesReady: [], payablesWaiting: [],
    mailPending: 0, bankUnmatched: 0, eventsPending: 0,
  };

  // חשבוניות פתוחות מעל הסף — מחשבונית ירוקה
  if (giEnabled(cid)) {
    try {
      const docs = await greenInvoice.openDocuments() || [];
      for (const d of docs) {
        // כל המסמכים הפתוחים נכנסים — הסף רק מסמן מי מתעכבת, לא מסנן
        const days = daysSince(d.date || d.documentDate);
        out.overdueInvoices.push({
          clientName: d.clientName || (d.client && d.client.name) || '',
          typeName: DOC_NAMES_HE[Number(d.type)] || 'מסמך',
          number: d.number || null,
          amount: d.amountDue != null ? Number(d.amountDue) : Number(d.amount) || 0,
          date: d.date || d.documentDate || null,
          description: String(d.description || '').trim().slice(0, 90) || null,
          days,
        });
      }
    } catch { /* חשבונית ירוקה לא זמינה — שאר המקטעים עדיין שווים משלוח */ }
  }

  const evs = (db.events || []).filter(e => ownedBy(e, cid));
  // אירועים שעברו וטרם חויבו — רק אחרי שהחודש שלהם נסגר
  for (const e of evs) {
    if (!e.confirmed || e.noInvoice) continue;
    if (e.invoiceStatus === 'invoiced') continue;
    const d = e.date || e.dateRaw || '';
    if (!monthClosed(d)) continue;
    out.uninvoicedEvents.push({ date: d, artist: e.artist || e.title || '', location: e.location || '', amount: eventTotal(e) });
  }
  out.eventsPending = evs.filter(e => !e.confirmed).length;

  // ספקים לתשלום
  for (const p of (db.supplierPayables || [])) {
    if (!ownedBy(p, cid) || p.paid) continue;
    const row = { supplierName: p.supplierName || '', number: p.number || null, amount: Number(p.amount) || 0 };
    if (p.readiness === 'ready') out.payablesReady.push(row);
    else if (p.readiness === 'waiting' || p.readiness === 'partial') out.payablesWaiting.push(row);
  }

  // תנועת הבנק בחודש הנוכחי. תאריכי התנועות הם dd/mm/yyyy.
  const nowD = new Date();
  const mm = String(nowD.getMonth() + 1).padStart(2, '0'), yy = String(nowD.getFullYear());
  const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  let bCredit = 0, bDebit = 0;
  for (const t of (db.bankTx || [])) {
    if (!ownedBy(t, cid)) continue;
    const m = String(t.date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m || m[2] !== mm || m[3] !== yy) continue;
    const v = Math.abs(Number(t.absAmount != null ? t.absAmount : t.amount) || 0);
    if (t.direction === 'credit') bCredit += v; else if (t.direction === 'debit') bDebit += v;
  }
  out.bankDebit = +bDebit.toFixed(2);   // הוצאות החודש = סך תנועות החובה בבנק
  out.monthLabel = `${MONTHS_HE[nowD.getMonth()]} ${yy}`;

  // חשבוניות ששולמו והתקבלו — תנועות זכות בבנק שהותאמו למסמך, בחודש הנוכחי.
  // זה הכסף שנכנס בפועל, עם המסמך שכנגדו.
  out.paidInvoices = [];
  for (const t of (db.bankTx || [])) {
    if (!ownedBy(t, cid) || t.direction !== 'credit') continue;
    const m = String(t.date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m || m[2] !== mm || m[3] !== yy) continue;
    const invs = Array.isArray(t.matchedInvoices) ? t.matchedInvoices : [];
    if (!invs.length) continue;
    out.paidInvoices.push({
      date: t.date,
      name: (invs[0] && (invs[0].clientName || invs[0].supplierName)) || t.nameHint || t.description || '—',
      docs: invs.map(i => `#${i.number || '—'}`).join(', '),
      amount: Math.abs(Number(t.absAmount != null ? t.absAmount : t.amount) || 0),
      _invIds: invs.map(i => i.id).filter(Boolean),
      description: [...new Set(invs.map(i => String(i.description || '').trim()).filter(Boolean))].join(' · ') || null,
    });
  }

  // השיוך בבנק לא תמיד שומר את תיאור המסמך. משלימים מחשבונית ירוקה — עד 25
  // מסמכים לריצה, עם מטמון פר-מזהה, כדי לא להעמיס על ה-API. כישלון לא חוסם.
  if (giEnabled(cid)) {
    const cache = new Map();
    let budget = 25;
    for (const p of out.paidInvoices) {
      if (p.description || !p._invIds.length || budget <= 0) continue;
      const descs = [];
      for (const id of p._invIds) {
        if (budget <= 0) break;
        if (!cache.has(id)) {
          budget--;
          try { const doc = await greenInvoice.getDocument(id); cache.set(id, String(doc.description || '').trim()); }
          catch { cache.set(id, ''); }
        }
        const d = cache.get(id);
        if (d) descs.push(d);
      }
      p.description = [...new Set(descs)].join(' · ') || null;
    }
  }
  for (const p of out.paidInvoices) { delete p._invIds; if (p.description) p.description = p.description.slice(0, 120); }

  out.mailPending = ((db.mailPending || {})[cid] || []).length;
  // תנועות זכות שלא הותאמו — כסף שנכנס ולא ידוע מול איזו חשבונית. זו אותה הגדרה
  // בדיוק שבמסך הבנק (matchStatus === 'unmatched', ברירת המחדל שם היא זכות בלבד).
  // קודם נספרה כל תנועה בלי חשבונית משויכת — כולל חובה, מאושרות ומקובצות — ולכן
  // המספר היה גדול פי עשרות ממה שמוצג במסך.
  out.bankUnmatched = (db.bankTx || []).filter(t => ownedBy(t, cid)
    && t.matchStatus === 'unmatched' && t.direction === 'credit').length;
  return out;
}

async function runDailyReport(trigger = 'scheduled', onlyCid = null) {
  const db = load();
  const per = {};
  for (const c of (db.companies || [])) {
    const cid = c.id;
    if (onlyCid && cid !== onlyCid) continue;
    const creds = companyMailCreds(db, cid);
    if (!mailer.companyMailConfigured(creds)) { per[cid] = { skipped: 'אין חשבון מייל' }; continue; }
    try {
      const data = await greenInvoice.withCompany(cid, () => gatherReportData(cid));
      const rep = buildReport(data);
      if (!rep) { per[cid] = { skipped: 'אין מה לדווח' }; continue; }
      await mailer.sendMailFrom(creds, {
        to: [creds.user], subject: rep.subject, text: rep.text, html: reportHtml(rep.report),
      });
      per[cid] = { ok: true, to: creds.user, overdue: data.overdueInvoices.length, uninvoiced: data.uninvoicedEvents.length };
      console.log(`[report] ${cid}: נשלח ל-${creds.user}`);
    } catch (e) { per[cid] = { error: e.message }; console.error(`[report] ${cid} נכשל:`, e.message); }
  }
  _lastReport = { at: new Date().toISOString(), trigger, per };
  return per;
}

function scheduleDailyReport() {
  const msToNext = () => {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), REPORT_HOUR_UTC, REPORT_MIN_UTC, 0, 0));
    if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  };
  const arm = () => { setTimeout(async () => { await runDailyReport(); arm(); }, msToNext()); };
  arm();
  // הרצה חד-פעמית בעליית השרת — לבדיקה/הפעלה ראשונה בלי להמתין ל-07:00.
  // מופעל ע"י REPORT_ON_BOOT=1 ומכובה מיד אחרי, כדי שלא ישלח בכל פריסה.
  // '1' = כל החברות, או מזהה חברה יחידה (למשל co_bpm) לבדיקה ממוקדת
  const boot = (process.env.REPORT_ON_BOOT || '').trim();
  if (boot) {
    const only = boot === '1' ? null : boot;
    setTimeout(() => { runDailyReport('boot', only).catch(e => console.error('[report] boot נכשל:', e.message)); }, 8000);
    console.log(`[report] REPORT_ON_BOOT=${boot} — ריצה חד-פעמית בעוד 8 שניות${only ? ` (${only} בלבד)` : ''}`);
  }
  console.log(`[report] סיכום יומי מתוזמן — ריצה ראשונה בעוד ~${Math.round(msToNext() / 60000)} דק'`);
}

// GET /api/daily-report/preview — תצוגה מקדימה של המייל לחברה הנוכחית, בלי לשלוח
add('GET', /^\/api\/daily-report\/preview$/, async (req, res, _p, q) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  try {
    const cid = reqCompany(q);
    const data = await gatherReportData(cid);
    const rep = buildReport(data);
    json(res, { ok: true, empty: !rep, subject: rep ? rep.subject : null, text: rep ? rep.text : null, overdueDays: data.overdueDays });
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/daily-report/run — שליחה עכשיו (חברה נוכחית בלבד, לבדיקה)
add('POST', /^\/api\/daily-report\/run$/, async (req, res, q, body) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  const cid = reqCompany(q, body);
  const per = await runDailyReport('manual', cid);
  json(res, { ok: true, result: per[cid] || null });
});

// POST /api/supplier-payables/:id/event-amounts — עדכון הסכום של שורות הקבלן באירועים
// שההוצאה מכסה. הסכום נשמר על האירוע עצמו (contractorDetails[index].amount), ולכן
// משתקף מיד גם במסך האירועים, ברווחיות ובחישוב "מוכן לתשלום".
// { items: [{ eventId, index, amount }] }
add('POST', /^\/api\/supplier-payables\/([^/]+)\/event-amounts$/, (req, res, params, q, body) => {
  const db = load();
  const cid = reqCompany(q, body);
  const pay = (db.supplierPayables || []).find(x => x.id === params[0]);
  if (!pay) return json(res, { error: 'רישום ההוצאה לא נמצא' }, 404);
  if (!ownedBy(pay, cid)) return wrongCompany(res, 'ההוצאה');
  const items = Array.isArray(body && body.items) ? body.items : [];
  const updated = [], errors = [];
  let linked = 0;   // שורות שהקישור שלהן קובע למזהה
  for (const it of items) {
    const ev = (db.events || []).find(e => e.id === String(it.eventId));
    if (!ev) { errors.push(`אירוע ${it.eventId} לא נמצא`); continue; }
    if (!ownedBy(ev, cid)) { errors.push('אירוע שייך לחברה אחרת'); continue; }
    const idx = Number(it.index);
    const row = (ev.contractorDetails || [])[idx];
    if (!row) { errors.push(`שורת קבלן ${idx} לא נמצאה באירוע ${it.eventId}`); continue; }
    const amt = Number(it.amount);
    if (!isFinite(amt) || amt < 0) { errors.push('סכום לא תקין'); continue; }
    // קיבוע הקישור למזהה ההוצאה. חלק מהשורות מקושרות רק בהתאמת "מספר חשבונית + שם
    // ספק", וכל עריכה של אחד מהשדות האלה מנתקת אותן בשקט. אנחנו כאן בהקשר של ההוצאה
    // הזו בוודאות, אז זו ההזדמנות להפוך את הקישור למפורש ועמיד.
    if (!row.paidPayableId) { row.paidPayableId = pay.id; linked++; }
    const before = Number(row.amount) || 0;
    if (Math.abs(before - amt) < 0.005) continue;   // לא השתנה
    row.amount = +amt.toFixed(2);
    updated.push({ eventId: ev.id, index: idx, name: row.name || '', before, after: row.amount });
  }
  // תיעוד מלא — כדי שאם שיוך נשבר שוב, יהיה מה לקרוא בלוגים במקום לנחש
  const after = (db.events || []).filter(e => ownedBy(e, cid))
    .flatMap(e => (e.contractorDetails || []).map((c, i) => ({ ev: e.id, i, c })))
    .filter(x => x.c && String(x.c.paidPayableId || '') === String(pay.id))
    .map(x => `${x.ev}#${x.i}`);
  console.log(`[event-amounts] ${pay.id} (${pay.supplierName || ''} #${pay.number || ''}) · עודכנו ${updated.length} · קובעו ${linked} · שורות מקושרות אחרי: ${after.length ? after.join(', ') : 'אין'}${errors.length ? ' · שגיאות: ' + errors.join('; ') : ''}`);
  if (updated.length || linked) save(db);
  json(res, { ok: true, updated, errors, linked, linkedRows: after });
});

// ---- גיבוי ----
// כל הנתונים הפיננסיים של שלוש החברות יושבים במסמך אחד. בלי גיבוי, באג או תקלה
// אצל ספק האחסון = אובדן מוחלט. הגיבוי יוצא מהמערכת החוצה, לתיבה נפרדת.
const BACKUP_HOUR_UTC = 23, BACKUP_MIN_UTC = 0;   // 02:00 שעון ישראל
let _lastBackup = null;

async function runDailyBackup(trigger = 'scheduled') {
  const to = (process.env.BACKUP_EMAIL || '').trim();
  const db = load();
  const creds = companyMailCreds(db, giCompanyId());
  if (!to) { console.log('[backup] דילוג — לא הוגדר BACKUP_EMAIL'); return { skipped: 'לא הוגדר BACKUP_EMAIL' }; }
  if (!mailer.companyMailConfigured(creds)) { console.log('[backup] דילוג — אין חשבון מייל לחברה הראשית'); return { skipped: 'אין חשבון מייל' }; }
  try {
    const r = await runBackupMail(mailer.sendMailFrom, creds, to);
    console.log(`[backup] נשלח ל-${to} · ${(r.gzBytes / 1048576).toFixed(2)}MB · ${r.counts.events} אירועים, ${r.counts.bankTx} תנועות בנק`);
    // ניקוי ישנים בתיבת היעד לפי מדיניות השמירה. דורש גישת IMAP לאותה תיבה
    // (BACKUP_MAIL_USER/PASS); בלעדיה הגיבוי עדיין נשלח, רק לא מתנקה.
    let cleaned = null;
    const bCreds = { user: (process.env.BACKUP_MAIL_USER || '').trim(), pass: (process.env.BACKUP_MAIL_PASS || '').trim() };
    if (bCreds.user && bCreds.pass) {
      try {
        const listed = await mailReader.listBackupMails(bCreds);
        if (listed.ok) {
          const plan = planRetention(listed.items);
          const del = plan.remove.map(f => f.id);
          const res2 = del.length ? await mailReader.deleteMails(bCreds, del) : { ok: true, count: 0 };
          cleaned = { total: listed.items.length, kept: plan.keep.length, removed: res2.count || 0, error: res2.error || null };
          if (cleaned.removed) console.log(`[backup] ניקוי: נמחקו ${cleaned.removed} גיבויים ישנים, נשארו ${cleaned.kept}`);
        } else cleaned = { error: listed.error };
      } catch (e) { cleaned = { error: e.message }; }
    }
    _lastBackup = { ...r, trigger, ok: true, cleaned };
    return { ...r, cleaned };
  } catch (e) {
    _lastBackup = { ok: false, error: e.message, at: new Date().toISOString(), trigger };
    console.error('[backup] נכשל:', e.message);
    return { error: e.message };
  }
}

function scheduleDailyBackup() {
  const msToNext = () => {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), BACKUP_HOUR_UTC, BACKUP_MIN_UTC, 0, 0));
    if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  };
  const arm = () => { setTimeout(async () => { await runDailyBackup(); arm(); }, msToNext()); };
  arm();
  // BACKUP_ON_BOOT=1 — גיבוי חד-פעמי בעליית השרת, בלי להמתין ל-02:00. משמש לפני
  // שינויים מבניים בנתונים. מכובה מיד אחרי השימוש.
  if ((process.env.BACKUP_ON_BOOT || '').trim() === '1') {
    setTimeout(() => { runDailyBackup('boot').catch(e => console.error('[backup] boot נכשל:', e.message)); }, 6000);
    console.log('[backup] BACKUP_ON_BOOT=1 — גיבוי חד-פעמי בעוד 6 שניות');
  }
  console.log(`[backup] מתוזמן — ריצה ראשונה בעוד ~${Math.round(msToNext() / 60000)} דק'${process.env.BACKUP_EMAIL ? '' : ' (אך BACKUP_EMAIL לא מוגדר)'}`);
}

// GET /api/backup/status — מתי רץ לאחרונה ומה קרה (הנהלה בלבד)
add('GET', /^\/api\/backup\/status$/, (req, res) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  json(res, { ok: true, configured: Boolean((process.env.BACKUP_EMAIL || '').trim()), to: (process.env.BACKUP_EMAIL || '').trim() || null, last: _lastBackup });
});

// GET /api/backup/download — הורדת גיבוי עכשיו למחשב (הנהלה בלבד)
add('GET', /^\/api\/backup\/download$/, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  try {
    const info = await buildBackup();
    const name = backupFileName(new Date(info.at));
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': info.buf.length,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    res.end(info.buf);
  } catch (e) { json(res, { error: e.message }, 500); }
});

// POST /api/backup/run — הרצת גיבוי במייל עכשיו (הנהלה בלבד)
add('POST', /^\/api\/backup\/run$/, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return json(res, { error: 'אין הרשאה' }, 403);
  const r = await runDailyBackup('manual');
  json(res, r.error ? { error: r.error } : { ok: true, ...r });
});

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

// GET /api/clients/:id/documents — כל המסמכים של לקוח (כולל מסמכים ישנים שהועלו ידנית — לשיוך בבנק/אירועים)
add('GET', /^\/api\/clients\/([^/]+)\/documents$/, async (req, res, params) => {
  try {
    const docs = (await greenInvoice.clientDocuments(params[0]) || []).slice(); // שכפול — לא לגעת במטמון
    try {
      const clients = await greenInvoice.listClients();
      const c = clients.find(x => String(x.id) === String(params[0]));
      const nm = c && c.name ? c.name : '';
      if (nm) {
        const normU = (s) => String(s || '').replace(/בע["'׳״]?\s*מ\.?/g, '').replace(/[."'׳״,()\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const want = normU(nm);
        const match = (x) => { const a = normU(x); return !!a && (a === want || a.includes(want) || want.includes(a)); };
        const db = load();
        const seen = new Set();
        const push = (d, clientName) => {
          if (!d || !d.uploaded) return;
          const key = (d.number || d.id) + '|' + Number(d.type);
          if (seen.has(key)) return; seen.add(key);
          docs.push({ id: d.id, number: d.number || null, type: Number(d.type), date: d.date || null, amount: d.amount != null ? Number(d.amount) : null, amountDue: d.amount != null ? Number(d.amount) : null, url: d.url || ('/api/files/' + d.id), status: 0, uploaded: true, clientName });
        };
        for (const e of (db.events || [])) { if (!match(e.clientName || e.client || '')) continue; for (const d of (e.linkedDocs || [])) if (d && d.uploaded) push(d, e.clientName || nm); }
        for (const rec of (db.oldInvoices || [])) { if (!match(rec.clientName || '')) continue; for (const d of (rec.linkedDocs || [])) if (d && d.uploaded) push(d, rec.clientName || nm); }
      }
    } catch {}
    json(res, docs);
  } catch (e) { json(res, { error: e.message }, 500); }
});

// GET /api/suppliers/:id/documents — מסמכי ההוצאה של ספק (לשיוך ידני בבנק)
add('GET', /^\/api\/suppliers\/([^/]+)\/documents$/, async (req, res, params, q) => {
  const supId = params[0];
  let docs = [];
  try { const r = await greenInvoice.supplierExpenses(supId); docs = Array.isArray(r) ? r : ((r && r.items) || []); }
  catch (e) { docs = []; }
  // מיזוג רשומות הוצאה מקומיות (אופק / חשבון עסקה פנימי) של אותו ספק — אינן קיימות בחשבונית ירוקה,
  // ולכן בלי זה הן לא מופיעות במודל השיוך של הבנק. הקובץ מוגש מ-/api/supplier-payables/:id/file.
  try {
    const db = load();
    const cid = q.companyId || giCompanyId();
    const already = new Set(docs.map(d => String(d.id)));
    // התאמה לפי מזהה *או* לפי שם. רשומה מקומית אינה מחייבת בחירת ספק (ראה localOnly
    // באישור הטיוטה), ולכן supplierId שלה יכול להיות ריק — ואז היא לא הופיעה תחת אף
    // ספק, לא בכרטיס הספק ולא במודל שיוך הבנק, למרות שהיא מוצגת ב"ספקים לתשלום".
    let supName = '';
    try { const sp = await greenInvoice.getSupplier(supId); supName = String((sp && sp.name) || '').trim(); } catch { }
    const nrmName = (x) => String(x || '').trim().toLowerCase();
    const locals = (db.supplierPayables || []).filter(p => p.localOnly
      && (p.companyId || 'co_bpm') === cid && !already.has(String(p.id))
      && (String(p.supplierId || '') === String(supId)
        || (!p.supplierId && supName && nrmName(p.supplierName) === nrmName(supName))));
    for (const p of locals) {
      docs.push({
        id: p.id, number: p.number, type: Number(p.documentType) || 305,
        date: String(p.date || '').slice(0, 10), amount: p.amount, amountIncVat: p.amount,
        supplierName: p.supplierName || '', description: p.description || '',
        url: `/api/supplier-payables/${p.id}/file`, localOnly: true,
      });
    }
  } catch { }
  json(res, docs);
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

// GET /api/expenses/:id/details — ערכי ההוצאה הנוכחיים לפתיחת טופס עריכה
add('GET', /^\/api\/expenses\/([^/]+)\/details$/, async (req, res, params) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  try {
    const e = await greenInvoice.getExpense(params[0]);
    const amount = Number(e.amount ?? e.total ?? e.sum ?? 0);
    const pay = e.paymentType;
    json(res, {
      ok: true, id: params[0],
      number: String(e.number ?? e.documentNumber ?? ''),
      date: String(e.documentDate || e.date || '').slice(0, 10),
      description: e.description || '',
      amount,
      amountExcludeVat: e.amountExcludeVat != null ? Number(e.amountExcludeVat) : null,
      supplierName: e.supplier?.name || '',
      supplierId: e.supplier?.id || null,
      paid: pay != null && pay !== -1,
      reported: Number(e.status) === 20,
      url: (e.url && (e.url.he || e.url.origin || e.url.pdf)) || (typeof e.url === 'string' ? e.url : null),
    });
  } catch (err) {
    // Fallback: אם חשבונית ירוקה לא מחזירה את ההוצאה (למשל מזהה שהתיישן / 404) — מציגים את הנתונים המקומיים כדי שהעורך ייפתח בכל זאת ואפשר יהיה לערוך סכום פר-אירוע
    try {
      const db = load();
      const p = (db.supplierPayables || []).find(x => String(x.giExpenseId) === String(params[0]));
      if (p) {
        return json(res, {
          ok: true, id: params[0], giUnavailable: true,
          number: String(p.number || ''),
          date: String(p.date || '').slice(0, 10),
          description: p.description || (db.expenseNotes && db.expenseNotes[params[0]]) || '',
          amount: Number(p.amount) || 0,
          amountExcludeVat: p.amountExcludeVat != null ? Number(p.amountExcludeVat) : null,
          supplierName: p.supplierName || '',
          supplierId: p.supplierId || null,
          paid: !!p.paid,
          reported: false,
          url: (p.giExpenseId || p.draftId || p.localFileId) ? `/api/supplier-payables/${p.id}/file` : null,
        });
      }
    } catch { }
    json(res, { error: err.message }, 500);
  }
});
// PUT /api/expenses/:id — עדכון מלא של הוצאה (תיאור/מספר/תאריך/סכום/שולם) + סנכרון מקומי
add('PUT', /^\/api\/expenses\/([^/]+)$/, async (req, res, params, _q, body) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const id = params[0], b = body || {};
  try { await greenInvoice.updateExpense(id, b); }
  catch (e) {
    // errorCode 1010 = כפילות: כבר קיימת הוצאה אחרת של אותו ספק עם אותו מספר מסמך.
    // ה-errorMessage הוא המזהה של ההוצאה הקיימת — שולפים אותה כדי להראות למשתמש במה מדובר,
    // במקום להציג את שגיאת ה-API הגולמית.
    const m = /"errorCode"\s*:\s*1010[\s\S]*?"errorMessage"\s*:\s*"([^"]+)"/.exec(e.message || '');
    if (m) {
      let dup = null;
      try { dup = await greenInvoice.getExpense(m[1]); } catch { }
      const num = (dup && dup.number) || b.number || '';
      const who = (dup && (dup.supplier?.name || dup.supplierName)) || '';
      const when = dup && dup.date ? String(dup.date).slice(0, 10).split('-').reverse().join('/') : '';
      const amt = dup && dup.amount != null ? `₪${Math.round(Number(dup.amount)).toLocaleString('he-IL')}` : '';
      const detail = [who, when && `מתאריך ${when}`, amt].filter(Boolean).join(' · ');
      return json(res, {
        error: `כבר קיימת הוצאה עם מספר מסמך ${num}${detail ? ` (${detail})` : ''}. חשבונית ירוקה לא מאפשרת שתי הוצאות של אותו ספק עם אותו מספר. שנה את מספר המסמך, או מחק את הכפילות.`,
        duplicateId: m[1], duplicateNumber: num, duplicate: true,
      }, 409);
    }
    console.log(`[expense-update] ${reqCompany(_q, b)}: ${id} נכשל · ${e.message}`);
    return json(res, { error: e.message }, 500);
  }
  const db = load();
  if (b.description != null) {
    db.expenseNotes = db.expenseNotes || {};
    const d = String(b.description).trim();
    if (d) db.expenseNotes[id] = d; else delete db.expenseNotes[id];
    for (const t of (db.bankTx || [])) for (const inv of (t.matchedInvoices || [])) if (inv.id === id) inv.description = d;
  }
  if (b.paid != null) for (const p of (db.supplierPayables || [])) if (p.giExpenseId === id) { p.paid = !!b.paid; p.paidAt = b.paid ? (p.paidAt || new Date().toISOString()) : null; }
  save(db);
  json(res, { ok: true, id });
});
// ניתוק מסמך שנמחק מכל שורות הבנק של החברה.
// שני מקומות, לא אחד: matchedInvoices (השיוך בפועל) ו-suggestions (ההצעות).
// ההצעות הן תצלום קפוא שנשמר על השורה בזמן הייבוא/הרענון — אם לא ננקה אותן,
// המסמך המחוק ימשיך להופיע ככפתור הצעה עד שמישהו ילחץ "רענן הצעות".
// שורה שנשארה בלי אף מסמך משויך חוזרת ל"לא מותאמת" (שורה שהוסתרה נשארת מוסתרת).
function dropDocFromBank(db, docId, companyId) {
  const same = (x) => x && String(x.id) === String(docId);
  let unmatched = 0, dropped = 0;
  for (const t of (db.bankTx || [])) {
    if (companyId && !ownedBy(t, companyId)) continue;
    if (Array.isArray(t.suggestions) && t.suggestions.some(same)) {
      t.suggestions = t.suggestions.filter(x => !same(x)); dropped++;
    }
    if (Array.isArray(t.matchedInvoices) && t.matchedInvoices.some(same)) {
      t.matchedInvoices = t.matchedInvoices.filter(x => !same(x));
      if (!t.matchedInvoices.length && t.matchStatus !== 'ignored') { t.matchStatus = 'unmatched'; unmatched++; }
    }
  }
  return { unmatched, dropped };
}

// DELETE /api/expenses/:id — מחיקת הוצאה מחשבונית ירוקה + ניקוי מקומי
add('DELETE', /^\/api\/expenses\/([^/]+)$/, async (req, res, params, q) => {
  if (!greenInvoice.haveCredentials()) return json(res, { error: 'חשבונית ירוקה לא מחוברת' }, 400);
  const id = params[0];
  try { await greenInvoice.deleteExpense(id); }
  catch (e) { return json(res, { error: e.message }, 500); }
  const db = load();
  if (db.expenseNotes) delete db.expenseNotes[id];
  // שחרור אירועים משויכים — מחיקת ההוצאה מחזירה את שורות הקבלן שלה למצב פתוח (מונע שיוך "יתום")
  const _delPays = (db.supplierPayables || []).filter(p => String(p.giExpenseId) === String(id));
  for (const ev of (db.events || [])) for (const cd of (ev.contractorDetails || [])) {
    if (!cd || !cd.paid) continue;
    const here = (cd.paidExpenseId && String(cd.paidExpenseId) === String(id))
      || _delPays.some(p => (cd.paidPayableId && String(cd.paidPayableId) === String(p.id)) || (p.number && cd.paidInvoice && String(cd.paidInvoice) === String(p.number) && (cd.name || '').trim() === (p.supplierName || '').trim()));
    if (here) { cd.paid = false; cd.paidPayableId = null; cd.paidInvoice = null; cd.paidExpenseId = null; cd.paidExpenseUrl = null; }
  }
  db.supplierPayables = (db.supplierPayables || []).filter(p => p.giExpenseId !== id);
  dropDocFromBank(db, id, reqCompany(q));
  save(db);
  json(res, { ok: true, id });
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
function ddmmyyyyToISO(d) { const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); if (!m) return null; const dd = +m[1], mm = +m[2]; if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null; return `${m[3]}-${m[2]}-${m[1]}`; }
function shiftISODays(iso, days) { const d = new Date(iso); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
// ניקוי תיאור לצורך חתימה: מסיר תווי קידוד שבורים (U+FFFD �) ורווחים כפולים, כדי שקידוד עברית פגום לא ישנה את החתימה
function normDesc(s) { return String(s || '').replace(/�/g, '').replace(/\s+/g, ' ').trim().slice(0, 20); }
// חתימת תנועה למניעת כפילויות בייבוא חוזר. כשיש אסמכתא — מתבססים עליה (מזהה ייחודי לתנועה בבנק) ומתעלמים מהתיאור,
// כי קידוד העברית עלול להישבר בייבוא חוזר ולשנות את התיאור — מה שיצר בעבר תנועות כפולות. ללא אסמכתא: תיאור מנוקה.
function bankSig(t) {
  const base = `${t.date}|${t.absAmount}|${t.direction || ''}`;
  return t.reference ? `${base}|R${t.reference}` : `${base}|${normDesc(t.description)}`;
}

// ---- התאמת בנק ↔ חשבונית ירוקה ברקע (הכנסות/קבלות + הוצאות) ----
// רץ אחרי שהתגובה כבר נשלחה, כדי שקבצים גדולים לא יגרמו ל-timeout. מעדכן matchStatus על התנועות השמורות.
const _bankMatchBg = {};        // companyId -> true בזמן ריצה
const _bankMatchState = {};     // companyId -> { running, at, matched }
async function runBankMatchBg(companyId) {
  if (_bankMatchBg[companyId]) return;
  _bankMatchBg[companyId] = true;
  _bankMatchState[companyId] = { running: true, at: new Date().toISOString(), matched: (_bankMatchState[companyId] || {}).matched || 0 };
  try {
    const snap = load();
    const txns = (snap.bankTx || []).filter(t => !companyId || t.companyId === companyId);
    if (!txns.length || !giEnabled(companyId)) return;
    const iso = txns.map(t => ddmmyyyyToISO(t.date)).filter(Boolean).sort();
    if (!iso.length) return;
    const from = shiftISODays(iso[0], -75), to = shiftISODays(iso[iso.length - 1], 5);
    let invoices = [], receipts = [], expenses = [];
    await greenInvoice.withCompany(companyId, async () => {
      try { const inc = await greenInvoice.incomeForRange(from, to); invoices = inc.docs || []; } catch { }
      try { receipts = await greenInvoice.receiptsForRange(from, to); } catch { }
      try { expenses = await greenInvoice.expensesInRange(from, to); } catch { }
    });
    try { const _notes = snap.expenseNotes || {}; if (Object.keys(_notes).length) expenses.forEach(e => { if (_notes[e.id]) e.description = _notes[e.id]; }); } catch { }
    const whRate = bizProfile(snap, companyId).withholdingRate || 0;   // שיעור ניכוי מס במקור של החברה
    const cmatched = attachReceipts(matchCredits(txns, invoices, whRate), receipts);  // תנועות זכות מסומנות במקום
    const dmap = new Map();
    try { for (const dm of matchDebits(txns, expenses)) dmap.set(dm.i, dm); } catch { }
    // כותבים על ה-DB העדכני לפי id (למניעת דריסת שינויים מקבילים)
    const db2 = load();
    const byId = new Map((db2.bankTx || []).map(r => [r.id, r]));
    let matchedCount = 0;
    txns.forEach((t, i) => {
      const row = byId.get(t.id);
      if (!row || row.matchStatus === 'manual' || row.matchStatus === 'ignored' || row.matchStatus === 'approved') return;
      if (row.direction === 'credit') {
        const cm = cmatched[i];
        if (cm) { row.matchStatus = cm.matchStatus; row.matchedInvoices = cm.matchedInvoices || []; row.suggestions = cm.suggestions || []; }
      } else {
        const dm = dmap.get(i);
        if (dm) { row.matchStatus = dm.matchStatus; row.matchedInvoices = dm.matchedInvoices || []; row.suggestions = dm.suggestions || []; }
      }
      if (row.matchStatus === 'auto') matchedCount++;
    });
    applyGroupRules(db2, companyId);   // שיוך-אוטומטי לפי שם (למשל גלי בראון → דיגיטל)
    db2.bankMatchDone = db2.bankMatchDone || {};
    db2.bankMatchDone[companyId] = new Date().toISOString();
    save(db2);
    _bankMatchState[companyId] = { running: false, at: new Date().toISOString(), matched: matchedCount };
  } catch (e) {
    _bankMatchState[companyId] = { running: false, at: new Date().toISOString(), error: e.message, matched: (_bankMatchState[companyId] || {}).matched || 0 };
  } finally {
    _bankMatchBg[companyId] = false;
  }
}

// POST /api/bank/rematch-all { companyId } — הרצה מחדש של כל ההתאמה ברקע (זכות+חובה+קבלות),
// לרענון תנועות שלא אושרו ידנית. משמש בין השאר לתיקון שיוך קבלות אחרי שיפור הלוגיקה.
add('POST', /^\/api\/bank\/rematch-all$/, (req, res, _p, _q, body) => {
  const companyId = body?.companyId || null;
  if (giEnabled(companyId)) runBankMatchBg(companyId).catch(() => { });
  json(res, { ok: true, matching: giEnabled(companyId) ? 'background' : 'none' });
});

// GET /api/bank/match-status?companyId= — האם ההתאמה ברקע עדיין רצה + כמה הותאמו
add('GET', /^\/api\/bank\/match-status$/, (req, res, _p, q) => {
  const cid = q.companyId || null;
  const st = _bankMatchState[cid] || { running: false, matched: 0 };
  json(res, { running: !!st.running, at: st.at || null, matched: st.matched || 0, error: st.error || null });
});

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
  // שמירה מהירה של התנועות (בלי לחכות לחשבונית ירוקה) — ההתאמה רצה ברקע כדי לא לגרום ל-timeout בקבצים גדולים.
  const db = load();
  db.bankTx = db.bankTx || [];
  // מחשבים את החתימה מחדש מכל תנועה קיימת (ולא סומכים על t.sig השמור), כדי שהתיקון יחול גם על תנועות ישנות ולא ייווצרו כפילויות
  const companyRows = db.bankTx.filter(t => !companyId || t.companyId === companyId);
  const bySig = new Map(companyRows.map(t => [bankSig(t), t]));
  // זיהוי כפילות בין-פורמט: אותה תנועה (תאריך+סכום+כיוון) שיובאה שוב בפורמט אחר — כשהתיאור/האסמכתא שונים,
  // או כשלאחד הצדדים אין מספר אסמכתא. מונע כפילויות בייבוא חוזר של טווח תאריכים חופף (למשל פורמט ישן מול חדש).
  const crossDup = (t) => {
    const same = companyRows.filter(e => e.date === t.date && e.absAmount === t.absAmount && e.direction === t.direction);
    if (!same.length) return null;
    if (t.reference) { const r = same.find(e => String(e.reference) === String(t.reference)); if (r) return r; }
    return same.find(e => !e.reference || !t.reference) || null; // אם לאחד הצדדים אין אסמכתא — אותה תנועה
  };
  // ---- מסגור-מחדש של הבנק ("עוד לא התעדכן סופית") ----
  // הבנק רושם תנועה זמנית (בלי אסמכתא), ולמחרת סוגר אותה סופית — ואז *התאריך, התיאור והאסמכתא
  // משתנים כולם*. דוגמה אמיתית: שיק דחוי לגבייה שנרשם 15/08 "פירעון שיק דחוי" בלי אסמכתא,
  // ולמחרת הופיע כ-16/08 "פרעון שיק דחוי לגביה" עם אסמכתא 26985. crossDup לא תפס כי התאריך זז.
  //
  // הזיהוי: אותו סכום + אותו כיוון + חלון ימים קצר + *השורה הקיימת חסרת אסמכתא* (כלומר נראית זמנית)
  // + לחדשה יש אסמכתא (כלומר נסגרה). התניית חוסר-האסמכתא היא הבלם: שתי תנועות אמיתיות שלשתיהן
  // אסמכתאות לעולם לא ימוזגו. מוטב לפספס מיזוג (כפילות גלויה שאפשר לתקן) מאשר למזג בטעות
  // שתי תנועות כסף אמיתיות — טעות שקטה שקשה לגלות.
  const RESTATE_DAYS = 4;   // 4 ימים כדי לכסות גם סוף שבוע
  const dayGap = (a, b) => {
    const p = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null; };
    const x = p(a), y = p(b);
    return (x == null || y == null) ? 999 : Math.abs(x - y) / 86400000;
  };
  const restatedDup = (t) => (!t.reference) ? null : (companyRows.find(e =>
    e.absAmount === t.absAmount && e.direction === t.direction && !e.reference
    && e.date !== t.date && dayGap(e.date, t.date) <= RESTATE_DAYS) || null);
  let added = 0, backfilled = 0, restated = 0;
  for (const t of parsed) {
    const sig = bankSig(t);
    let ex = bySig.get(sig) || crossDup(t);
    let isRestate = false;
    if (!ex) { ex = restatedDup(t); isRestate = Boolean(ex); }
    if (ex) {
      // תנועה קיימת — נשלים יתרה רצה (balance) ואסמכתא אם חסרות, כדי שעו"ש יתעדכן ולמניעת כפילויות בעתיד
      if (t.balance != null && ex.balance !== t.balance) { ex.balance = t.balance; backfilled++; }
      if (!ex.reference && t.reference) ex.reference = t.reference;
      if (isRestate) {
        // הבנק סגר את התנועה סופית — מעדכנים את השורה הקיימת *במקומה* לערכים הסופיים
        // (תאריך/תיאור/אסמכתא). עדכון-במקום ולא מחיקה+הוספה, כדי שהשיוך לחשבונית, האישור,
        // הקבוצה וההערות שכבר נעשו על השורה הזמנית יישמרו במלואם.
        ex.date = t.date;
        if (t.description) ex.description = t.description;
        if (t.nameHint) ex.nameHint = t.nameHint;
        if (t.memo) ex.memo = t.memo;
        if (t.invoiceNumber && !ex.invoiceNumber) ex.invoiceNumber = t.invoiceNumber;
        ex.sig = bankSig(ex);
        ex.restatedAt = new Date().toISOString();
        restated++;
      }
      continue;
    }
    const rec = {
      id: id('btx'), companyId, sig,
      date: t.date, description: t.description, amount: t.amount, absAmount: t.absAmount,
      direction: t.direction, reference: t.reference, invoiceNumber: t.invoiceNumber,
      nameHint: t.nameHint, memo: t.memo, balance: t.balance ?? null,
      matchStatus: 'unmatched', matchedInvoices: [], suggestions: [],
      importedAt: new Date().toISOString(),
    };
    db.bankTx.push(rec); bySig.set(sig, rec); companyRows.push(rec); added++;
  }
  // ---- ניקוי אוטומטי של תנועות זמניות שהבנק כבר לא מכיר בהן ----
  // קובץ בנק הוא הצהרה מלאה על הטווח שלו. שורה *זמנית* (בלי אסמכתא) שיושבת על תאריך
  // שהקובץ מכסה, ואין לה מקבילה בקובץ — הבנק ביטל או פיצל אותה, והיא תנועת פנטום שמנפחת
  // את הסיכומים. מקרה אמיתי (16.08.26): חיוב אשראי זמני של 15,240.88 פוצל למחרת ל-15,107.68
  // + 133.20, והשורה המקורית נשארה תקועה.
  //
  // שלושה בלמים כדי שלא תימחק תנועה אמיתית:
  //   1) רק שורות ללא אסמכתא (שורה שנסגרה בבנק לעולם לא נמחקת).
  //   2) רק בתוך *טווח התאריכים* של הקובץ — כך שייבוא חלקי לא ימחק ימים שאינם בו.
  //      חשוב: טווח ולא רשימת תאריכים. דף חשבון הוא הצהרה מלאה על תקופה, ויום בלי תנועות
  //      פשוט לא מופיע בו. מקרה אמיתי: תנועה נרשמה זמנית ב-15/08, הבנק העביר אותה ל-16/08,
  //      ובקובץ הבא (11/08–16/08) אין ל-15/08 אף שורה — כלומר הבנק מחק אותה משם.
  //   3) רק שורות ללא עבודה אמיתית עליהן. "עבודה אמיתית" = שיוך למסמך או אישור ידני —
  //      אלה הדברים שאי אפשר לשחזר. סימון "ללא התאמה" (ignored) ושיוך לקבוצה *אינם* חוסמים:
  //      התעלמות היא הצהרה שהשורה לא מעניינת, וקבוצה היא סיווג שנקבע מחדש בקלות.
  const toKey = (d) => { const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}${m[2]}${m[1]}` : null; };
  const fileKeysDates = parsed.map(t => toKey(t.date)).filter(Boolean).sort();
  const fileMin = fileKeysDates[0], fileMax = fileKeysDates[fileKeysDates.length - 1];
  const inFileRange = (d) => { const k = toKey(d); return Boolean(k && fileMin && k >= fileMin && k <= fileMax); };
  const fileKeys = new Set(parsed.map(t => `${t.date}|${t.absAmount}|${t.direction}`));
  const hasWork = (t) => (t.matchedInvoices || []).length > 0
    || t.matchStatus === 'manual' || t.matchStatus === 'approved' || Boolean(String(t.notes || '').trim());
  // מועמדים: שורה ללא אסמכתא, בתוך טווח הקובץ, שאין לה מקבילה בו
  const candidates = companyRows.filter(t => !t.reference && inFileRange(t.date)
    && !fileKeys.has(`${t.date}|${t.absAmount}|${t.direction}`));
  const staleIds = new Set(candidates.filter(t => !hasWork(t)).map(t => t.id));
  // אבחון: שורות שנראו פנטום אך נשמרו בגלל עבודה שנעשתה עליהן — כדי שנדע למה ולא ננחש
  const keptRows = candidates.filter(t => hasWork(t)).map(t => ({
    date: t.date, amount: t.absAmount, direction: t.direction,
    why: (t.matchedInvoices || []).length ? 'משויך למסמך' : (t.matchStatus === 'approved' ? 'אושר ידנית' : (t.matchStatus === 'manual' ? 'שויך ידנית' : 'יש הערה')),
  }));
  let removed = 0;
  if (staleIds.size) {
    db.bankTx = (db.bankTx || []).filter(t => !staleIds.has(t.id));
    removed = staleIds.size;
    console.log(`[bank-import] ${companyId}: הוסרו ${removed} תנועות זמניות שהבנק כבר לא מכיר בהן`);
  }

  applyGroupRules(db, companyId);   // שיוך-אוטומטי לפי שם (מיידית, מתוך nameHint)
  save(db);
  // התאמה מול חשבונית ירוקה (הכנסות/קבלות/הוצאות) רצה ברקע — לא חוסמת את התגובה
  const matchBg = giEnabled(companyId);
  if (matchBg) runBankMatchBg(companyId).catch(() => { });
  json(res, { ok: true, added, backfilled, restated, removed, kept: keptRows, total: parsed.length, matching: matchBg ? 'background' : 'none', accountBalance: acctBal || null });
});

// POST /api/bank/rematch { companyId } — הרצת התאמה אוטומטית מחדש של תנועות זכות+חובה על התנועות הקיימות (בלי העלאה חוזרת).
// חשוב: לא נוגעים בשורות שכבר אושרו/שויכו ידנית/הוסתרו (approved/manual/ignored) — כדי שהרענון לא יבטל אישורים קיימים.
add('POST', /^\/api\/bank\/rematch$/, async (req, res, _p, _q, body) => {
  const companyId = body?.companyId || null;
  const snap = load();
  const txns = (snap.bankTx || []).filter(t => !companyId || t.companyId === companyId);
  if (!txns.length) return json(res, { ok: true, updated: 0, message: 'אין תנועות' });
  const iso = txns.map(t => ddmmyyyyToISO(t.date)).filter(Boolean).sort();
  let invoices = [], receipts = [], expenses = [];
  if (iso.length && giEnabled(companyId)) {
    const from = shiftISODays(iso[0], -75), to = shiftISODays(iso[iso.length - 1], 5);
    await greenInvoice.withCompany(companyId, async () => {
      try { const inc = await greenInvoice.incomeForRange(from, to); invoices = inc.docs || []; } catch { }
      try { receipts = await greenInvoice.receiptsForRange(from, to); } catch { }
      try { expenses = await greenInvoice.expensesInRange(from, to); } catch { }
    });
  }
  try { const _notes = snap.expenseNotes || {}; if (Object.keys(_notes).length) expenses.forEach(e => { if (_notes[e.id]) e.description = _notes[e.id]; }); } catch { }
  const whRate = bizProfile(snap, companyId).withholdingRate || 0;   // ניכוי מס במקור (לזכות)
  const cmatched = attachReceipts(matchCredits(txns, invoices, whRate), receipts);   // התאמת זכות (הכנסות + קבלות)
  const dmap = new Map();
  try { for (const dm of matchDebits(txns, expenses)) dmap.set(dm.i, dm); } catch { }
  const db2 = load();
  const byId = new Map((db2.bankTx || []).map(r => [r.id, r]));
  let updated = 0;
  txns.forEach((t, i) => {
    const row = byId.get(t.id);
    // מדלגים על שורות מאושרות/ידניות/מוסתרות — לא נוגעים בהן בכלל
    if (!row || row.matchStatus === 'manual' || row.matchStatus === 'ignored' || row.matchStatus === 'approved') return;
    if (row.direction === 'credit') {
      const cm = cmatched[i];
      if (cm) { row.matchStatus = cm.matchStatus; row.matchedInvoices = cm.matchedInvoices || []; row.suggestions = cm.suggestions || []; updated++; }
    } else {
      const dm = dmap.get(i);
      if (dm) { row.matchStatus = dm.matchStatus; row.matchedInvoices = dm.matchedInvoices || []; row.suggestions = dm.suggestions || []; updated++; }
    }
  });
  applyGroupRules(db2, companyId);
  save(db2);
  json(res, { ok: true, updated });
});

// GET /api/bank/balance?companyId= — יתרת עו"ש הרשמית האחרונה שנקלטה
add('GET', /^\/api\/bank\/balance$/, (req, res, _p, q) => {
  const db = load();
  // יתרה של החברה המבוקשת בלבד — בלי נפילה חזרה ליתרה של חברה אחרת (למשל אופק לא יראה את היתרה של BPM)
  const cid = q.companyId || null;
  const b = (db.bankBalance || []).find(x => x.companyId === cid) || null;
  json(res, b);
});

// חילוץ קישור צפייה/הורדה מאובייקט חשבונית ירוקה (מסמך או הוצאה)
function extractGiUrl(obj) {
  const u = obj && obj.url;
  if (!u) return null;
  if (typeof u === 'string') return u;
  return u.he || u.origin || u.pdf || null;
}
// השלמת url לחשבונית מותאמת שאין לה קישור (למשל כזו שהועלתה ידנית בבנק) — כדי שתהיה צפייה/הורדה
async function enrichMatchedUrl(inv) {
  if (!inv || inv.url || !inv.id) return false;
  if (/^(exp_|pay_)/.test(String(inv.id))) return false; // מזהה מקומי — אין קובץ בחשבונית ירוקה
  try {
    const obj = inv.kind === 'expense' ? await greenInvoice.getExpense(inv.id) : await greenInvoice.getDocument(inv.id);
    const url = extractGiUrl(obj);
    if (url) { inv.url = url; return true; }
  } catch { }
  return false;
}

// #1 — לכל קבלה (400) שמשויכת לשורת בנק: שולף את חשבונית המס המקורית (300/305) שממנה נגזרה,
// ומקנן אותה תחת הקבלה (inv.sourceInvoice). אם המשתמש בחר גם את חשבונית המקור כשורה נפרדת — מסירים אותה
// כדי לא לספור את אותו הכסף פעמיים בבדיקת כיסוי הסכום.
async function attachSourceInvoices(matched) {
  for (const inv of matched.slice()) {
    if (!inv || Number(inv.type) !== 400 || inv.sourceInvoice || /^(exp_|pay_)/.test(String(inv.id))) continue;
    let ids = [];
    try { const raw = await greenInvoice.getDocument(inv.id); ids = Array.isArray(raw && raw.linkedDocumentIds) ? raw.linkedDocumentIds : []; } catch { continue; }
    for (const sid of ids) {
      try {
        const s = await greenInvoice.getDocument(sid);
        const st = Number(s && s.type);
        if (st === 305 || st === 300) {
          const amount = Number(s.amount ?? s.total ?? s.sum) || 0;
          const url = (s.url && (s.url.he || s.url.origin || s.url.pdf)) || (typeof s.url === 'string' ? s.url : null);
          inv.sourceInvoice = { id: s.id, number: s.number, type: st, amount, clientName: (s.client && s.client.name) || inv.clientName || '', url };
          const dupIdx = matched.findIndex(x => String(x.id) === String(s.id));
          if (dupIdx >= 0) matched.splice(dupIdx, 1);
          break;
        }
      } catch { }
    }
  }
}

// GET /api/bank?companyId=
add('GET', /^\/api\/bank$/, async (req, res, _p, q) => {
  const db = load();
  const _cid = reqCompany(q);
  let list = (db.bankTx || []).filter(t => ownedBy(t, _cid));
  // השלמה חד-פעמית של קישורי צפייה/הורדה לחשבוניות מותאמות שאין להן url (נשמר, כך שלא נטען שוב)
  if (giEnabled(_cid)) {
    let changed = false, budget = 25;
    for (const t of list) {
      if (budget <= 0) break;
      if (t.matchStatus !== 'manual' && t.matchStatus !== 'auto') continue;
      for (const inv of (t.matchedInvoices || [])) {
        if (budget <= 0) break;
        if (inv && !inv.url && inv.id && !/^(exp_|pay_)/.test(String(inv.id))) { budget--; if (await enrichMatchedUrl(inv)) changed = true; }
      }
    }
    if (changed) save(db);
  }
  const key = (d) => (d || '').split('/').reverse().join('');
  list = [...list].sort((a, b) => key(b.date).localeCompare(key(a.date)));
  json(res, list);
});

// PUT /api/bank/:id  { matchStatus?, matchedInvoice? }
add('PUT', /^\/api\/bank\/([^/]+)$/, async (req, res, params, _q, body) => {
  const db = load();
  const t = (db.bankTx || []).find(x => x.id === params[0]);
  if (!t) return json(res, { error: 'לא נמצא' }, 404);
  if (!ownedBy(t, reqCompany(_q, body))) return wrongCompany(res, 'התנועה');
  // כמה מחשבונית מסוימת כבר הוקצה בשורות בנק אחרות (מאושרות/מותאמות) — בסיס לתשלום בפעימות.
  // נספרות רק שורות של אותה חברה — אחרת הקצאה בחברה אחת הייתה חוסמת שיוך בחברה אחרת.
  const allocatedElsewhere = (invId) => {
    let s = 0;
    for (const o of (db.bankTx || [])) {
      if (o.id === t.id || !ownedBy(o, t.companyId || giCompanyId()) || !['manual', 'auto', 'approved'].includes(o.matchStatus)) continue;
      for (const mi of (o.matchedInvoices || [])) if (String(mi.id) === String(invId)) s += (Number(mi.allocated != null ? mi.allocated : mi.amount) || 0);
    }
    return s;
  };
  // חסימת שיוך-כפול — רק אם החשבונית כבר שולמה במלואה בשורות אחרות. אם נשארה יתרה — מותר (תשלום בפעימות).
  if (!body.allowDup && Array.isArray(body.matchedInvoices) && body.matchedInvoices.length) {
    for (const inv of body.matchedInvoices) {
      const amt = Number(inv.amount) || 0; if (amt <= 0) continue;
      const used = allocatedElsewhere(inv.id);
      if (used >= amt - Math.max(3, amt * 0.004)) return json(res, { error: `החשבונית #${inv.number || ''} כבר שולמה במלואה בשורות בנק אחרות (₪${Math.round(used)} מתוך ₪${Math.round(amt)}). כדי לשייך בכל זאת, סמן "אפשר לבחור גם חשבוניות שכבר משויכות".` }, 409);
    }
  }
  // רשת ביטחון למסמך שנמחק ישירות בחשבונית ירוקה: רשימת ההצעות על השורה היא תצלום קפוא
  // מזמן הייבוא/הרענון, ולכן הכפתור ממשיך להופיע. לפני שיוך מוודאים שההוצאה עדיין קיימת.
  // נחסם רק על 404 מפורש — תקלת רשת או שגיאה אחרת לא ימנעו שיוך תקין.
  if (Array.isArray(body.matchedInvoices) && body.matchedInvoices.length && greenInvoice.haveCredentials()) {
    for (const inv of body.matchedInvoices) {
      if (!inv || inv.kind !== 'expense' || !inv.id || /^(exp_|pay_)/.test(String(inv.id))) continue;
      let gone = false;
      try { const r = await greenInvoice.getExpense(inv.id); gone = !r || (!r.id && !r.number); }
      catch (e) { gone = /:\s*404\b/.test(e.message || ''); }
      if (!gone) continue;
      const cleaned = dropDocFromBank(db, inv.id, t.companyId || giCompanyId());
      db.supplierPayables = (db.supplierPayables || []).filter(x => String(x.giExpenseId || '') !== String(inv.id));
      save(db);
      console.log(`[bank-match] ${t.companyId}: הוצאה ${inv.id} #${inv.number || ''} נמחקה מחשבונית ירוקה — נוקתה מ-${cleaned.dropped} הצעות ו-${cleaned.unmatched} שיוכים`);
      return json(res, { error: `ההוצאה #${inv.number || ''} כבר לא קיימת בחשבונית ירוקה — היא נמחקה. ניקיתי אותה מרשימת ההצעות; רענן את המסך.`, stale: true }, 409);
    }
  }
  if (body.group !== undefined) t.group = body.group || null;
  // קבוצות שיוך של החברה. הכנסה ללא קבוצה → משויכת אוטומטית לברירת המחדל "הכנסות עסק".
  // הערה: שיוך מסמך (matchStatus:'manual') מותר גם בלי קבוצה — כדי לא לחסום את שמירת המסמך.
  // דרישת הקבוצה נאכפת בממשק: השורה תיחשב "מכוסה/מאושרת" רק אחרי בחירת קבוצה (הסדר לא משנה).
  const companyGroups = (db.txGroups || []).filter(g => g.companyId === t.companyId);
  if ((body.matchStatus === 'manual' || body.matchStatus === 'approved') && companyGroups.length && !t.group && t.direction === 'credit') {
    const def = companyGroups.find(g => g.isDefaultIncome) || companyGroups.find(g => g.kind === 'income');
    if (def) t.group = def.id;   // הכנסה — ברירת מחדל
  }
  // #1 — קבלה (400) משויכת: משיכת חשבונית המס המקורית וקינון תחתיה (מונע ספירה כפולה)
  if (greenInvoice.haveCredentials() && Array.isArray(body.matchedInvoices) && body.matchedInvoices.length) {
    try { await attachSourceInvoices(body.matchedInvoices); } catch { }
  }
  // #2 + תשלום בפעימות — הקצאה אוטומטית: כל העברה נזקפת ליתרת החשבונית. השורה נסגרת רק אם כל סכום ההעברה הוקצה
  // (או שההעברה = יתרת החשבוניות פחות 5% ניכוי מס — ואז הן נסגרות במלואן). אחרת נשארת לא מתואמת עם חיווי החוסר.
  if ((body.matchStatus === 'manual' || body.matchStatus === 'approved') && Array.isArray(body.matchedInvoices) && body.matchedInvoices.length) {
    const bankAbs = Math.abs(Number(t.absAmount) || 0);
    const whRate = bizProfile(db, t.companyId).withholdingRate || 0;   // שיעור ניכוי מס במקור של החברה
    const whFactor = 1 - whRate;
    // קבלה (400) שיש לה חשבונית מקור (305/300/320) באותה שורה = אותו כסף — לא מקצים לה בנפרד (מונע ספירה כפולה שמעוותת את הסכום שנותר להקצאה)
    const _hasInv = body.matchedInvoices.some(x => x.kind !== 'expense' && [305, 300, 320].includes(Number(x.type)));
    const _allocatable = body.matchedInvoices.filter(inv => !(Number(inv.type) === 400 && inv.kind !== 'expense' && _hasInv));
    const rem = _allocatable.map(inv => ({ inv, r: Math.max(0, (Number(inv.amount) || 0) - allocatedElsewhere(inv.id)) }));
    const totalRem = rem.reduce((s, x) => s + x.r, 0);
    const tol = Math.max(3, bankAbs * 0.004);
    if (whRate > 0 && totalRem > 0 && Math.abs(bankAbs - totalRem * whFactor) <= Math.max(3, totalRem * 0.004)) {
      rem.forEach(x => { x.inv.allocated = +x.r.toFixed(2); });   // ניכוי מס במקור — החשבוניות נסגרות במלואן, הבנק קיבל 95%
    } else {
      let remaining = bankAbs;
      for (const x of rem) { const a = Math.min(x.r, remaining); x.inv.allocated = +a.toFixed(2); remaining = +(remaining - a).toFixed(2); }
      // אם לא מכוסה — לא חוסמים; השיוך נשמר, והשורה תוצג אדומה בממשק (לא מאושרת) עד השלמה או אישור ידני.
    }
  }
  if (body.matchStatus) t.matchStatus = body.matchStatus;
  if (body.matchedInvoices !== undefined) t.matchedInvoices = body.matchedInvoices;
  if (body.notes !== undefined) t.notes = body.notes;
  // השלמת קישור צפייה/הורדה לחשבוניות שהותאמו עכשיו (למשל שהועלו ידנית) שאין להן url
  if (greenInvoice.haveCredentials()) { for (const inv of (t.matchedInvoices || [])) await enrichMatchedUrl(inv); }
  save(db);
  // התאמת תנועת חובה (כסף שיצא) → עדכון "שולם לספק" לפי צבירה: אירועים של חשבונית שכוסתה במלואה בבנק מסומנים
  if (t.direction === 'debit') { try { applyBankSupplierPayments(db, t.companyId || giCompanyId()); } catch { } }
  json(res, { ok: true, tx: t });
});

// GET /api/bank/coverage-audit?companyId= — שורות זכות מאושרות שהמסמכים המשויכים לא מכסים את הסכום שהועבר
add('GET', /^\/api\/bank\/coverage-audit$/, (req, res, _p, q) => {
  const db = load();
  const cid = reqCompany(q);
  const flagged = [];
  for (const t of (db.bankTx || [])) {
    if (!ownedBy(t, cid)) continue;
    if (!['manual', 'approved', 'auto'].includes(t.matchStatus)) continue; // גם זכות (הכנסות) וגם חובה (הוצאות)
    const invs = t.matchedInvoices || [];
    if (!invs.length) continue; // אושר ללא מסמך — לא נכלל
    const allocSum = invs.reduce((s, inv) => s + (Number(inv.allocated != null ? inv.allocated : inv.amount) || 0), 0);
    const bankAbs = Math.abs(Number(t.absAmount) || 0);
    const tol = Math.max(3, bankAbs * 0.004);
    const whFactor = 1 - (bizProfile(db, t.companyId).withholdingRate || 0);
    // בהכנסות מותר גם "פחות ניכוי מס במקור" (לפי שיעור החברה); בהוצאות רק סכום מדויק
    const covered = Math.abs(allocSum - bankAbs) <= tol || (t.direction === 'credit' && whFactor < 1 && Math.abs(allocSum * whFactor - bankAbs) <= tol);
    if (!covered) flagged.push({ id: t.id, date: t.date, dir: t.direction, bankAmount: +bankAbs.toFixed(2), matchedSum: +allocSum.toFixed(2), shortfall: +(bankAbs - allocSum).toFixed(2), name: t.nameHint || t.description || '', numbers: invs.map(i => i.number).filter(Boolean) });
  }
  flagged.sort((a, b) => Math.abs(b.shortfall) - Math.abs(a.shortfall));
  json(res, { flagged, count: flagged.length });
});

// DELETE /api/bank/:id
add('DELETE', /^\/api\/bank\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const t = (db.bankTx || []).find(x => x.id === params[0]);
  if (!t) return json(res, { ok: true });
  if (!ownedBy(t, reqCompany(q))) return wrongCompany(res, 'התנועה');
  db.bankTx = (db.bankTx || []).filter(x => x.id !== params[0]);
  save(db);
  json(res, { ok: true });
});

// DELETE /api/bank  — ניקוי כל התנועות של החברה. חובה companyId (אחרת היינו מוחקים תנועות של כל החברות!)
add('DELETE', /^\/api\/bank$/, (req, res, _p, q) => {
  if (!q.companyId) return json(res, { error: 'חסר מזהה חברה' }, 400);
  const db = load();
  db.bankTx = (db.bankTx || []).filter(t => t.companyId !== q.companyId);
  save(db);
  json(res, { ok: true });
});

// ================= קבוצות שיוך לתנועות בנק (מוזיקה/דיגיטל/שוטפות/אחר) =================
// GET /api/tx-groups?companyId=
add('GET', /^\/api\/tx-groups$/, (req, res, _p, q) => {
  const db = load();
  if (ensureGroupsSeeded(db)) save(db);
  const cid = q.companyId || null;
  json(res, { ok: true, groups: (db.txGroups || []).filter(g => g.companyId === cid) });
});
// POST /api/tx-groups { companyId, name }
add('POST', /^\/api\/tx-groups$/, (req, res, _p, _q, body) => {
  const cid = body?.companyId || null;
  const name = String(body?.name || '').trim();
  if (!cid || !name) return json(res, { error: 'חסר שם קבוצה' }, 400);
  const db = load();
  db.txGroups = db.txGroups || [];
  const g = { id: id('txg'), companyId: cid, name };
  if (['income', 'expense'].includes(body?.kind)) g.kind = body.kind;   // קבוצת הכנסה / הוצאה
  db.txGroups.push(g);
  save(db);
  json(res, { ok: true, group: g });
});
// PUT /api/tx-groups/:id { name }
add('PUT', /^\/api\/tx-groups\/([^/]+)$/, (req, res, params, _q, body) => {
  const db = load();
  const g = (db.txGroups || []).find(x => x.id === params[0]);
  if (!g) return json(res, { error: 'לא נמצא' }, 404);
  if (!ownedBy(g, reqCompany(_q, body))) return wrongCompany(res, 'הקבוצה');
  const name = String(body?.name || '').trim();
  if (name) g.name = name;
  save(db);
  json(res, { ok: true, group: g });
});
// DELETE /api/tx-groups/:id  — לא מוחקים את מוזיקה/דיגיטל (הבית תלוי בהן); מנקים את השיוך מהתנועות
add('DELETE', /^\/api\/tx-groups\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const g = (db.txGroups || []).find(x => x.id === params[0]);
  if (!g) return json(res, { ok: true });
  if (!ownedBy(g, reqCompany(q))) return wrongCompany(res, 'הקבוצה');
  if (g.key === 'music' || g.key === 'digital') return json(res, { error: 'לא ניתן למחוק את קבוצת מוזיקה/דיגיטל' }, 400);
  if (g.isDefaultIncome) return json(res, { error: 'לא ניתן למחוק את קבוצת "הכנסות עסק" (ברירת המחדל להכנסות)' }, 400);
  db.txGroups = (db.txGroups || []).filter(x => x.id !== params[0]);
  for (const t of (db.bankTx || [])) if (t.group === params[0]) t.group = null;
  save(db);
  json(res, { ok: true });
});

// ===== כללי שיוך-אוטומטי לפי שם לקוח =====
// GET /api/tx-group-rules?companyId=
add('GET', /^\/api\/tx-group-rules$/, (req, res, _p, q) => {
  const db = load();
  if (ensureRulesSeeded(db)) save(db);
  json(res, { ok: true, rules: (db.txGroupRules || []).filter(r => r.companyId === (q.companyId || null)) });
});
// POST /api/tx-group-rules { companyId, groupId, name? | keyword? } — מוסיף כלל (לפי שם לקוח או לפי תיאור) ומחיל מיד
add('POST', /^\/api\/tx-group-rules$/, (req, res, _p, _q, body) => {
  const cid = body?.companyId || null, groupId = body?.groupId || null;
  const name = String(body?.name || '').trim(), keyword = String(body?.keyword || '').trim();
  if (!cid || !groupId || (!name && !keyword)) return json(res, { error: 'חסר שם לקוח / מילת-מפתח או קבוצה' }, 400);
  const db = load();
  db.txGroupRules = db.txGroupRules || [];
  const rule = { id: id('txr'), companyId: cid, groupId };
  if (keyword) rule.keyword = keyword; else rule.name = name;
  db.txGroupRules.push(rule);
  const applied = applyGroupRules(db, cid);
  save(db);
  json(res, { ok: true, rule, applied });
});
// DELETE /api/tx-group-rules/:id
add('DELETE', /^\/api\/tx-group-rules\/([^/]+)$/, (req, res, params, q) => {
  const db = load();
  const r = (db.txGroupRules || []).find(x => x.id === params[0]);
  if (!r) return json(res, { ok: true });
  if (!ownedBy(r, reqCompany(q))) return wrongCompany(res, 'הכלל');
  db.txGroupRules = (db.txGroupRules || []).filter(x => x.id !== params[0]);
  save(db);
  json(res, { ok: true });
});
// POST /api/tx-group-rules/apply { companyId } — החלה רטרואקטיבית על תנועות קיימות
add('POST', /^\/api\/tx-group-rules\/apply$/, (req, res, _p, _q, body) => {
  const db = load();
  const applied = applyGroupRules(db, body?.companyId || null);
  save(db);
  json(res, { ok: true, applied });
});

// GET /api/group-summary?companyId=&year=YYYY
// סיכום נטו (ללא מע"מ) לפי קבוצה וחודש: לתנועות משויכות-לקבוצה, לוקחים את הסכום ללא מע"מ של המסמך המשויך.
// תנועה משויכת לקבוצה אך בלי מסמך — נספרת בנפרד (unlinked) ולא נכנסת לנטו.
add('GET', /^\/api\/group-summary$/, async (req, res, _p, q) => {
  const db = load();
  if (ensureGroupsSeeded(db)) save(db);
  const cid = reqCompany(q);
  const year = String(q.year || new Date().getFullYear());
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const netOf = (inv) => {
    if (!inv) return 0;
    if (inv.amountExVat != null && !isNaN(+inv.amountExVat)) return +inv.amountExVat;
    if (inv.amount != null && !isNaN(+inv.amount)) return +inv.amount / 1.18; // גיבוי: חילוץ מע"מ 18%
    return 0;
  };
  const groups = (db.txGroups || []).filter(g => g.companyId === cid);
  const gmap = {};
  for (const g of groups) gmap[g.id] = { income: Array(12).fill(0), expense: Array(12).fill(0), unlinkedExpense: 0 };

  // ===== בסיס מזומן: הכנסות והוצאות לפי תנועות הבנק שהותאמו (manual/approved), לפי חודש התנועה והקבוצה =====
  // כך שהסיכום החודשי, חלונית הפירוט וההוצאות מסתדרים לאותם מספרים בדיוק (סכום הבנק בפועל).
  const defIncomeId = (groups.find(g => g.isDefaultIncome) || {}).id || null;
  const ungrouped = Array(12).fill(0);       // הכנסות ללא קבוצה (חברות בלי קבוצת ברירת מחדל)
  const ungroupedExp = Array(12).fill(0);    // הוצאות ללא קבוצה — מוצגות ב"אחר" כדי שהסכומים יסתדרו עם הפירוט
  let incomeError = null;
  for (const t of (db.bankTx || [])) {
    if (!ownedBy(t, cid)) continue;
    if (t.matchStatus !== 'manual' && t.matchStatus !== 'approved') continue;
    const m = String(t.date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m || m[3] !== year) continue;
    const mi = (+m[2]) - 1;
    const amt = Math.abs(Number(t.absAmount) || 0);
    if (t.direction === 'credit') {
      // הכנסה — אם אין קבוצה, ברירת מחדל "הכנסות עסק" (לחברות עם קבוצת ברירת מחדל)
      const gid = (t.group && gmap[t.group]) ? t.group : defIncomeId;
      if (gid && gmap[gid]) gmap[gid].income[mi] += amt;
      else ungrouped[mi] += amt;
    } else if (t.direction === 'debit') {
      if (t.group && gmap[t.group]) gmap[t.group].expense[mi] += amt;
      else ungroupedExp[mi] += amt;   // הוצאה מאושרת ללא קבוצה — נספרת ב"אחר"
    }
  }

  const mkGroup = (id, name, key, inc, exp, unlinkedExp) => {
    const totalIncome = inc.reduce((a, x) => a + x, 0);
    const totalExpense = exp.reduce((a, x) => a + x, 0);
    return {
      id, name, key: key || null,
      months: inc.map((v, i) => ({ m: i + 1, income: r2(v), expense: r2(exp[i]), profit: r2(v - exp[i]) })),
      totalIncome: r2(totalIncome), totalExpense: r2(totalExpense), totalProfit: r2(totalIncome - totalExpense),
      unlinkedIncome: 0, unlinkedExpense: r2(unlinkedExp || 0),
    };
  };
  const out = groups.map(g => mkGroup(g.id, g.name, g.key, gmap[g.id].income, gmap[g.id].expense, gmap[g.id].unlinkedExpense));
  if (ungrouped.some(x => x)) out.push(mkGroup('ungrouped', 'הכנסות ללא שיוך לקטגוריה', null, ungrouped, Array(12).fill(0), 0));
  if (ungroupedExp.some(x => x)) out.push(mkGroup('ungrouped_exp', 'הוצאות ללא קבוצה', null, Array(12).fill(0), ungroupedExp, 0));
  json(res, { ok: true, year, incomeBasis: 'issued-305-320-gross', incomeError, groups: out, groupsList: groups.map(g => ({ id: g.id, name: g.name })) });
});

// GET /api/month-detail?companyId=&year=YYYY&month=M (1-12)
// פירוט חודשי: כל ההכנסות (זיכויים) מצד אחד וכל ההוצאות (חובה) מצד שני — הכל מתוך התאמות הבנק.
// עמודות: תאריך, סכום, שם עסק, מס' חשבונית מס/מס-קבלה, מס' קבלה, הערות, קבוצה.
add('GET', /^\/api\/month-detail$/, (req, res, _p, q) => {
  const db = load();
  if (ensureGroupsSeeded(db)) save(db);
  const cid = reqCompany(q);
  const year = String(q.year || new Date().getFullYear());
  const month = parseInt(q.month, 10) || 0; // 1-12
  const groups = (db.txGroups || []).filter(g => g.companyId === cid);
  const gname = (gid) => { const g = groups.find(x => x.id === gid); return g ? g.name : ''; };
  const income = [], expense = [];
  for (const t of (db.bankTx || [])) {
    if (!ownedBy(t, cid)) continue;
    const m = String(t.date || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m || m[3] !== year || (+m[2]) !== month) continue;
    if (t.matchStatus !== 'manual' && t.matchStatus !== 'approved') continue;
    const invs = Array.isArray(t.matchedInvoices) ? t.matchedInvoices : [];
    // מסמך מס עיקרי (305/320/300) ומסמך קבלה (400 / receipt מקונן / 320)
    const taxDoc = invs.find(x => [305, 320, 300, '305', '320', '300'].includes(x.type)) || invs[0] || null;
    let receiptNum = null, receiptUrl = null;
    for (const x of invs) {
      if (x.receipt && x.receipt.number != null) { receiptNum = x.receipt.number; receiptUrl = x.receipt.url || null; break; }
      if ([400, 320, '400', '320'].includes(x.type)) { receiptNum = x.number; receiptUrl = x.url || null; break; }
    }
    const name = (invs.find(x => x.clientName && x.clientName !== '—') || {}).clientName || t.nameHint || '';
    // כל המסמכים המשויכים עם URL — לצפייה/הורדה
    const docs = invs.filter(x => x.url).map(x => ({ type: x.type, number: x.number, url: x.url }));
    for (const x of invs) if (x.receipt && x.receipt.url) docs.push({ type: 400, number: x.receipt.number, url: x.receipt.url });
    const row = {
      id: t.id, date: t.date, amount: t.absAmount || 0, name,
      taxNumber: taxDoc ? taxDoc.number : null,
      taxType: taxDoc ? taxDoc.type : null,
      taxUrl: taxDoc ? (taxDoc.url || null) : null,
      receiptNumber: receiptNum, receiptUrl, notes: t.notes || '',
      docs,
      group: t.group || null, groupName: t.group ? gname(t.group) : '',
    };
    (t.direction === 'credit' ? income : expense).push(row);
  }
  const byDate = (a, b) => String(a.date).split('/').reverse().join('').localeCompare(String(b.date).split('/').reverse().join(''));
  income.sort(byDate); expense.sort(byDate);
  json(res, {
    ok: true, year, month,
    income, expense,
    totalIncome: Math.round(income.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100,
    totalExpense: Math.round(expense.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100,
    groups: groups.map(g => ({ id: g.id, name: g.name, kind: g.kind || null })),
  });
});

// ================= התחברות והרשאות =================
// הלשוניות שניתן להקצות למשתמש צפייה — חייב להתאים ל-TAB_LABELS ב-app.js, אחרת בחירה של המנהל
// נמחקת בשקט בשמירה. 'business' (פרטי העסק) אינו כאן בכוונה — הוא להנהלה בלבד.
const VALID_TABS = ['home', 'summary', 'events', 'quotes', 'clients', 'contractors', 'payroll', 'bank', 'vehicles'];
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

// GET /api/health?companyId= — סטטוס חיבורים. חשבונית ירוקה/יומן מדווחים לפי החברה הנבחרת (בידוד).
add('GET', /^\/api\/health$/, (req, res, _p, q) => {
  const cid = q.companyId || null;
  // חשבונית ירוקה + יומן — פר-חברה: לכל חברה המפתחות/היומנים שלה בלבד (בידוד מלא).
  const giConn = cid ? giEnabled(cid) : greenInvoice.haveCredentials();
  const calConn = hasCalendar(cid || giCompanyId());
  json(res, {
    ok: true,
    greenInvoiceConnected: giConn,
    calendarConnected: calConn,
    chatConnected: chatConfigured(),
    whatsapp: getBridgeStatus().status,
  });
});

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
  // no-cache: הדפדפן חייב לאמת מול השרת בכל טעינה — כך שכל עדכון של האתר נטען מיד בלי צורך בריענון קשיח
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache, must-revalidate' });
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

// החברות + ספק חשבונאי לכל אחת. שלושתן חשבונית ירוקה (BPM + משה + אופק), כל אחת עם מפתחות + יומנים + בנק משלה.
// לכל חברה הנתונים שלה בלבד — בידוד מלא (חשבונית ירוקה לפי מפתחות פר-חברה, יומנים לפי iCal פר-חברה, בנק לפי companyId).
const COMPANY_SEED = [
  { id: 'co_bpm', name: 'בי פי אם הגברה ותאורה בע"מ', active: true, accounting: 'greenInvoice' },
  { id: 'co_moshe', name: 'משה כורסיה בע"מ', active: false, accounting: 'greenInvoice' },
  { id: 'co_ofek', name: 'אופק ידעי הגברה ותאורה', active: false, accounting: 'greenInvoice' },
];
// מזהה חברת ה-GI הראשית (ברירת מחדל BPM) — לשם תאימות לאחור בלבד
function giCompanyId() { const c = (load().companies || []).find(x => x.accounting === 'greenInvoice'); return c ? c.id : 'co_bpm'; }

// מזהה חברת אופק — ההעברה האוטומטית של מסמכי הכנסה למייל ההוצאות רלוונטית לה בלבד
const OFEK_COMPANY_ID = 'co_ofek';
// ============ העברה אוטומטית של מסמכי הכנסה של אופק למייל ההוצאות (רו"ח) ============
// אך ורק אצל אופק, ואך ורק לסוגים: 305 חשבונית מס · 320 חשבונית מס-קבלה · 400 קבלה (כולל קבלה שלילית) · 330 חשבונית זיכוי.
// רץ אוטומטית וברקע (fire-and-forget), ללא קשר לשליחת המסמך ללקוח.
const OFEK_INCOME_FWD_TYPES = new Set([305, 320, 400, 330]);
const _OFEK_DOC_NAME = { 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 330: 'חשבונית זיכוי' };
async function forwardOfekIncomeDoc(doc, type) {
  try {
    const cid = (greenInvoice.activeCompany ? greenInvoice.activeCompany() : null) || giCompanyId();
    if (cid !== OFEK_COMPANY_ID) return;                                // רק אופק
    const t = Number(type != null ? type : (doc && (doc.type ?? doc.documentType)));
    if (!OFEK_INCOME_FWD_TYPES.has(t)) return;                         // רק הסוגים שהוגדרו
    if (!doc || !doc.id) return;
    const db = load();
    const acct = String(bizProfile(db, cid).accountantEmail || '').trim();
    if (!acct) return;                                                 // לא הוגדר מייל הוצאות — לא מעבירים
    const creds = companyMailCreds(db, cid);
    if (!mailer.companyMailConfigured(creds) && !mailer.mailerConfigured()) return;
    let url = extractGiUrl(doc);
    if (!url) { try { const full = await greenInvoice.getDocument(doc.id); url = extractGiUrl(full); } catch { } }
    if (!url) return;
    const fr = await fetch(url, { redirect: 'follow' });
    if (!fr.ok) return;
    const buf = Buffer.from(await fr.arrayBuffer());
    const name = _OFEK_DOC_NAME[t] || 'מסמך';
    const num = String(doc.number || doc.id || '').replace(/[^\w.-]/g, '_');
    await mailer.sendMailFrom(creds, {
      to: acct,
      subject: `${name} #${doc.number || ''} — מסמך הכנסה (אופק)`,
      text: `מצורף מסמך הכנסה שהופק במערכת (אופק).\nסוג: ${name}\nמספר: ${doc.number || ''}`,
      attachments: [{ filename: `${name}-${num}.pdf`, content: buf, contentType: 'application/pdf' }],
    });
  } catch { /* ברקע בלבד — לא חוסם ולא משפיע על יצירת המסמך */ }
}
// עוטף את greenInvoice.createDocument: יוצר את המסמך כרגיל, ומעביר אותו אוטומטית ברקע למייל ההוצאות של אופק (אם רלוונטי).
async function createDocFwd(opts) {
  const doc = await greenInvoice['createDocument'](opts);   // קריאה ישירה (bracket) כדי לא להתנגש עם ההחלפה הגלובלית
  try { forwardOfekIncomeDoc(doc, opts && opts.type); } catch { }   // ללא await — רץ ברקע
  return doc;
}
// האם החברה מחוברת לחשבונית ירוקה בפועל (סוג חשבונאי greenInvoice + יש מפתחות משלה)?
function giEnabled(companyId) {
  const c = (load().companies || []).find(x => x.id === companyId);
  return !!(c && c.accounting === 'greenInvoice' && greenInvoice.haveCredentials(companyId));
}
// תשובה ריקה לכל endpoint שנשען על חשבונית ירוקה — עבור חברות שאינן חברת ה-GI (אופק/משה)
function giEmptyFor(pathname) {
  if (pathname === '/api/dashboard') return { income: 0, vat: 0, openInvoices: 0, openInvoicesSum: 0, monthDocs: 0, docs: [], clients: [], errors: {} };
  if (pathname === '/api/clients' || pathname === '/api/suppliers') return [];
  if (pathname === '/api/open-invoices' || pathname === '/api/open-quotes') return { docs: [] };
  if (pathname === '/api/expense-drafts') return { drafts: [] };
  if (pathname === '/api/expenses/quick-search' || pathname === '/api/documents/quick-search') return { items: [] };
  if (/^\/api\/(clients|suppliers)\/[^/]+\/documents$/.test(pathname)) return [];
  // הערה: אנדפוינטי היומן (calendar/match, calendar/events) אינם נחסמים כאן — הם פר-חברה לפי iCal
  // ומטופלים ישירות (מחזירים יומן ריק אם לא הוגדר), כך שיומן עובד גם בלי חיבור חשבונית ירוקה.
  return undefined;
}

// מיגרציות חד-פעמיות בעליית השרת
// קבוצות שיוך ברירת-מחדל למשה כורסיה. ids קבועים כדי ששיוכי תנועות ישרדו.
const MOSHE_DEFAULT_GROUPS = [
  { key: 'music', name: 'מוזיקה' },
  { key: 'digital', name: 'דיגיטל' },
  { key: 'operating', name: 'הוצאות שוטפות' },
  { key: 'other', name: 'אחר' },
];
// קבוצות ברירת-מחדל ל-BPM ואופק — מחולקות להכנסה/הוצאה. הכנסה מסומנת ב-kind:'income', הוצאה ב-'expense'.
// "הכנסות עסק" היא ברירת המחדל לכל תנועת הכנסה (isDefaultIncome).
const INCEXP_DEFAULT_GROUPS = [
  { key: 'income_biz', name: 'הכנסות עסק', kind: 'income', isDefaultIncome: true },
  { key: 'income_refund', name: 'החזר', kind: 'income' },
  { key: 'exp_suppliers', name: 'ספקים', kind: 'expense' },
  { key: 'exp_equipment', name: 'ציוד', kind: 'expense' },
  { key: 'exp_vehicles', name: 'רכבים', kind: 'expense' },
  { key: 'exp_loan', name: 'הלוואה', kind: 'expense' },
  { key: 'exp_bankfees', name: 'עמלות בנקים', kind: 'expense' },
  { key: 'exp_legal', name: 'עו״ד', kind: 'expense' },
];
const INCEXP_GROUP_COMPANIES = ['co_bpm', 'co_ofek'];
function ensureGroupsSeeded(db) {
  db.txGroups = db.txGroups || [];
  let changed = false;
  if (!db.txGroups.some(g => g.companyId === 'co_moshe')) {
    for (const g of MOSHE_DEFAULT_GROUPS) db.txGroups.push({ id: 'txg_' + g.key, companyId: 'co_moshe', name: g.name, key: g.key, builtin: true });
    changed = true;
  }
  for (const cid of INCEXP_GROUP_COMPANIES) {
    if (db.txGroups.some(g => g.companyId === cid)) continue;
    for (const g of INCEXP_DEFAULT_GROUPS) db.txGroups.push({ id: `txg_${cid}_${g.key}`, companyId: cid, name: g.name, key: g.key, kind: g.kind, builtin: true, isDefaultIncome: !!g.isDefaultIncome });
    changed = true;
  }
  return changed;
}
// כלל התחלתי: תנועות של "גלי בראון" משויכות אוטומטית ל"דיגיטל"
function ensureRulesSeeded(db) {
  db.txGroupRules = db.txGroupRules || [];
  if (db.txGroupRules.some(r => r.companyId === 'co_moshe')) return false;
  db.txGroupRules.push({ id: 'txr_gali', companyId: 'co_moshe', name: 'גלי בראון ייצוג וניהול סושיאל בע״מ', groupId: 'txg_digital' });
  return true;
}
// החלת כללי שיוך-אוטומטי: מציב קבוצה על תנועות שאין להן קבוצה. לא נוגע בשיוך קיים.
// שני סוגי כללים: לפי שם לקוח (rule.name, התאמה מטושטשת) או לפי תיאור (rule.keyword, מילה שמתחילה במילת-המפתח).
function applyGroupRules(db, companyId) {
  const rules = (db.txGroupRules || []).filter(r => r.companyId === companyId);
  if (!rules.length) return 0;
  const valid = new Set((db.txGroups || []).filter(g => g.companyId === companyId).map(g => g.id));
  const hit = (rule, t, names) => {
    if (!valid.has(rule.groupId)) return false;
    if (rule.keyword) {
      const kw = String(rule.keyword).trim();
      return !!kw && String(t.description || '').split(/[\s/.,\-]+/).some(w => w.startsWith(kw));
    }
    return names.some(n => nameMatch(n, rule.name));
  };
  let changed = 0;
  for (const t of (db.bankTx || [])) {
    if (companyId && t.companyId !== companyId) continue;
    if (t.group) continue;                       // לא דורסים שיוך קיים
    const names = [t.nameHint, t.description, ...((t.matchedInvoices || []).map(i => i && i.clientName))].filter(Boolean);
    const rule = rules.find(r => hit(r, t, names));
    if (rule) { t.group = rule.groupId; changed++; }
  }
  return changed;
}

function runMigrations() {
  const db = load();
  let changed = false;
  if (ensureGroupsSeeded(db)) { changed = true; console.log('מיגרציה: נזרעו קבוצות שיוך ברירת-מחדל למשה כורסיה'); }
  if (ensureRulesSeeded(db)) { changed = true; console.log('מיגרציה: נזרע כלל שיוך-אוטומטי (גלי בראון → דיגיטל)'); }
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
  db.companies = db.companies || [];
  // ניקוי חד-פעמי של נתוני אופק שנותרו מהניסויים הקודמים — כדי שהחברה תתחיל נקייה לגמרי.
  // מוגן בדגל _ofekDataCleared כך שירוץ פעם אחת בלבד ולא ימחק נתונים אמיתיים שיוזנו בעתיד.
  if (!db._ofekDataCleared) {
    db.bankTx = (db.bankTx || []).filter(t => t.companyId !== 'co_ofek');
    db.events = (db.events || []).filter(e => e.companyId !== 'co_ofek');
    db.supplierPayables = (db.supplierPayables || []).filter(p => (p.companyId || 'co_bpm') !== 'co_ofek');
    db.artistClientMap = (db.artistClientMap || []).filter(m => (m.companyId || 'co_bpm') !== 'co_ofek');
    db.txGroupRules = (db.txGroupRules || []).filter(r => r.companyId !== 'co_ofek');
    if (db.docGroupOverrides) delete db.docGroupOverrides['co_ofek'];
    if (db.calendarAutoAdopt) delete db.calendarAutoAdopt['co_ofek'];
    db._ofekDataCleared = true;
    changed = true;
    console.log('מיגרציה: נוקו נתוני אופק הישנים (חברה נקייה) — פעם אחת בלבד');
  }
  // ניקוי חד-פעמי נוסף: יתרת עו"ש ישנה של אופק (נשמרת בנפרד מהתנועות) — כדי שגם היתרה תתאפס.
  if (!db._ofekBankBalanceCleared) {
    db.bankBalance = (db.bankBalance || []).filter(b => b.companyId !== 'co_ofek');
    db._ofekBankBalanceCleared = true;
    changed = true;
    console.log('מיגרציה: נוקתה יתרת עו"ש ישנה של אופק');
  }
  // ודא שכל החברות (כולל אופק) קיימות ושלכל אחת מוגדר ספק חשבונאי (accounting)
  for (const seed of COMPANY_SEED) {
    let c = db.companies.find(x => x.id === seed.id);
    if (!c) { c = { id: seed.id, name: seed.name, active: seed.active }; db.companies.push(c); changed = true; console.log('מיגרציה: נוספה חברה ' + seed.name); }
    if (c.accounting !== seed.accounting) { c.accounting = seed.accounting; changed = true; }
  }
  // זריעה חד-פעמית של מיפויי אמן/איש-קשר → לקוח לאופק (שם שהמנהל כותב בהודעת הווטסאפ → שם הלקוח בחשבונית ירוקה).
  // מוגן בדגל כדי לא לדרוס עריכות/מחיקות שהמשתמש יעשה מאוחר יותר במסך המיפוי.
  if (!db._ofekArtistMapSeededV1) {
    const OFEK_MAP = [
      ['הפרויקט', 'סינגולד בע״מ'], ['הפרוייקט של רביבו', 'סינגולד בע״מ'],
      ['מאור אדרי', 'מאור אדרי הפקות בע״מ'],
      ['טומי', 'טומי לי הגברה ותאורה בע״מ'],
      ['Bpm', 'בי פי אם הגברה ותאורה בע״מ'], ['בי פי אם', 'בי פי אם הגברה ותאורה בע״מ'],
      ['איציק ריקן', 'איציק ריקן'],
      ['נועם חורב', 'הליקון כנען בע״מ'],
      ['אריאל אזולאי', 'אודם קישורים עסקיים בע״מ'],
      ['נטלי פרץ', 'פרץ נטלי'],
      ['יניב בן משיח', 'יניב בן משיח הפקות בע״מ'],
    ];
    db.artistClientMap = db.artistClientMap || [];
    for (const [artist, clientName] of OFEK_MAP) {
      const exists = db.artistClientMap.some(m => (m.companyId || 'co_bpm') === 'co_ofek' && normName(m.artist) === normName(artist));
      if (!exists) db.artistClientMap.push({ artist, clientName, companyId: 'co_ofek' });
    }
    db._ofekArtistMapSeededV1 = true;
    changed = true;
    console.log('מיגרציה: נזרעו מיפויי אמן→לקוח לאופק');
  }
  if (changed) save(db);
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
        const allowedCos = Array.isArray(authUser.companies) ? authUser.companies : [];
        const comp = q.companyId || null;
        if (comp && allowedCos.length && !allowedCos.includes(comp)) {
          return json(res, { error: 'אין הרשאה לעסק זה' }, 403);
        }
        // בקשה ללא companyId — נועלים אותה לעסק המורשה הראשון. בלי זה הבקשה נופלת לחברת
        // ברירת המחדל (או, בראוטים ישנים, ל"כל החברות") ומשתמש צפייה היה רואה נתונים של עסק אחר.
        if (!comp && allowedCos.length) q.companyId = allowedCos[0];
      }
    }
    req.user = authUser;
    // בידוד חברות: נתוני חשבונית ירוקה שייכים לחברה שאליה החיבור שייך. חברה שאינה מחוברת ל-GI → ריק.
    if (req.method === 'GET' && q.companyId && !giEnabled(q.companyId)) {
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
      // כל הבקשה רצה בהקשר החברה הנבחרת — כך שקריאות חשבונית ירוקה משתמשות במפתחות/מטמון של אותה חברה בלבד.
      // הקשר החברה נלקח מה-query, ואם חסר — מגוף הבקשה (הגנה לכתיבות שלא צירפו companyId ל-URL).
      const _cid = q.companyId || (body && body.companyId) || undefined;
      // סנכרון ההערה הקבועה למסמכים (docRemark) של החברה מה-DB — כך שתוזרק לכל מסמך שנוצר, גם בלי כניסה מראש לפרטי העסק ואחרי ריסטארט
      try { const _c = _cid || giCompanyId(); const _pr = (load().businessProfiles || {})[_c]; greenInvoice.setCompanyRemark(_c, (_pr && _pr.docRemark != null) ? _pr.docRemark : defaultDocRemark(_c)); } catch { }
      try { await greenInvoice.withCompany(_cid, () => route.handler(req, res, params, q, body)); }
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
  hydrateConnCreds();         // טוען מפתחות חיבורים פר-חברה שהוזנו באתר (בסיס הנתונים) לזיכרון
  console.log(`מערכת BPM רצה על http://localhost:${PORT}`);
  startWhatsappBridge(async (text) => { try { const wc = process.env.WHATSAPP_COMPANY || 'co_bpm'; await greenInvoice.withCompany(wc, () => ingestText(text, wc)); } catch {} })
    .then(r => { if (r && !r.ok) console.log('ווטסאפ:', r.reason); });
  try { scheduleNightlyMailScan();
  scheduleDailyBackup();
  scheduleDailyReport(); } catch (e) { console.error('תזמון סריקת מייל נכשל:', e.message); } // סריקת מייל לילית אוטומטית לכל החברות
});
