// aiAgent.js — סוכן AI עם כלים.
//
// בניגוד ל-chat.js, שמחזיר טקסט בלבד, כאן המודל יכול להפעיל פעולות אמיתיות
// במערכת: לחפש אירועים, לבדוק מי לא שילם, להפיק הצעת מחיר ולשלוח מסמך ללקוח.
// הלולאה היא tool-use של Anthropic: המודל מבקש כלי → אנחנו מריצים → מחזירים
// תוצאה → הוא ממשיך, עד שהוא עונה בטקסט.
//
// שני עקרונות שמנחים את הקובץ:
//   1. **בידוד חברה.** כל כלי מקבל companyId ואינו יכול לראות נתוני חברה אחרת.
//      אין כאן "כל החברות" — בדיוק כמו בראוטים של server.js.
//   2. **פעולות כותבות דורשות הרשאה מפורשת.** allowWrites=false הופך את הסוכן
//      לקריאה בלבד. מסמך מס (305/320) אינו נוצר כאן כלל — רק הצעת מחיר,
//      שאינה מסמך מס וניתן לסגור אותה.

import { load, save, id as newId, companyEvents } from './store.js';
import { greenInvoice } from './greenInvoice.js';
import { trackUsage } from './chat.js';
import { invoiceItemsFromEvents, subjectForEvents } from './invoicing.js';

// פונקציות שחיות ב-server.js (שליחת מייל, חישובי דף הבית) מוזרקות מבחוץ כדי
// שלא ייווצר import מעגלי: server.js מייבא את הקובץ הזה, לא להפך.
let host = {};
export function registerAgentHost(fns) { host = { ...host, ...fns }; }

// ================= זיכרון =================
// הסוכן אינו לומד מעצמו — Claude אינו מתאמן על השיחות, וכל שיחה מתחילה נקייה.
// מה שהופך אותו למי שמכיר את העסק הוא הזיכרון כאן: עובדות והעדפות שנשמרות
// במסד ונטענות להנחיות בכל שיחה. שתי דרכים להיכנס לזיכרון:
//   · הסוכן קורא ל-remember תוך כדי שיחה (כשנאמר "תזכור ש..." או כשעלתה העדפה).
//   · מעבר רפלקציה זול אחרי כל תור (learnFromTurn), שמחלץ מה שנלמד גם כשלא נאמר
//     "תזכור" — זה מה שגורם לו להשתפר מעצם השימוש.
// הכל גלוי למשתמש וניתן למחיקה. זיכרון שקרי גרוע מאין זיכרון.
const MEM_MAX = 80;            // תקרה לחברה — מעבר לזה ההנחיות תופחות ומתומחרות בכל סיבוב
const MEM_TEXT_MAX = 300;

export function memoryOf(companyId) {
  const all = load().agentMemory || {};
  return [...(all[companyId] || []), ...(all.__all || [])];
}

function memWrite(companyId, fn) {
  const db = load();
  db.agentMemory = db.agentMemory || {};
  const key = companyId || '__all';
  db.agentMemory[key] = fn(db.agentMemory[key] || []);
  save(db);
  return db.agentMemory[key];
}

const memNorm = (s) => String(s || '').toLowerCase().replace(/["'׳״.,\-–—]/g, '').replace(/\s+/g, ' ').trim();

// שמירה עם דדופ: פריט שדומה מאוד לקיים מחליף אותו במקום להצטבר לידו.
// בלי זה תיקון חוזר על אותו נושא היה יוצר שני זיכרונות סותרים.
export function rememberFact(companyId, { text, kind = 'fact', scope = 'company', source = 'agent' }) {
  const t = String(text || '').trim().slice(0, MEM_TEXT_MAX);
  if (t.length < 4) return { error: 'הזיכרון קצר מדי.' };
  const key = scope === 'all' ? '__all' : companyId;
  let saved = null, replaced = false;
  memWrite(key, (list) => {
    const n = memNorm(t);
    const iSame = list.findIndex(m => memNorm(m.text) === n);
    if (iSame >= 0) { list[iSame].at = new Date().toISOString(); saved = list[iSame]; replaced = true; return list; }
    // אותו נושא בניסוח אחר: חפיפה גבוהה של מילים משמעותיות
    const words = new Set(n.split(' ').filter(w => w.length > 2));
    const iNear = list.findIndex(m => {
      const w2 = new Set(memNorm(m.text).split(' ').filter(w => w.length > 2));
      if (!words.size || !w2.size) return false;
      let hit = 0; for (const w of words) if (w2.has(w)) hit++;
      return hit / Math.max(words.size, w2.size) >= 0.75;
    });
    saved = { id: newId('mem'), text: t, kind, source, at: new Date().toISOString() };
    if (iNear >= 0) { list[iNear] = saved; replaced = true; return list; }
    list.push(saved);
    return list.slice(-MEM_MAX);   // הישן ביותר נושר כשמתמלא
  });
  return { ok: true, id: saved && saved.id, replaced };
}

export function forgetFact(companyId, idOrText) {
  const needle = memNorm(idOrText);
  let removed = 0;
  for (const key of [companyId, '__all']) {
    memWrite(key, (list) => {
      const keep = list.filter(m => m.id !== idOrText && !memNorm(m.text).includes(needle));
      removed += list.length - keep.length;
      return keep;
    });
  }
  return removed ? { ok: true, removed } : { error: 'לא נמצא זיכרון מתאים.' };
}

const ymd = (d) => String(d || '').slice(0, 10);
const num = (n) => (n == null || n === '' ? null : Number(n));
const DOC_NAME = { 10: 'הצעת מחיר', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה', 330: 'זיכוי' };

// ---- הכלים כפי שהמודל רואה אותם ----
// התיאורים בעברית בכוונה: ההודעות מהמשתמש בעברית, וכך המודל בוחר כלי מדויק יותר.
export const AGENT_TOOLS = [
  {
    name: 'search_events',
    description: 'חיפוש אירועים של העסק. מחזיר רשימה מתומצתת. להשתמש כדי לענות על "מה יש לי בשבוע הבא", "אילו אירועים של לקוח X", "מה לא חויב".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'תאריך התחלה YYYY-MM-DD (כולל). אופציונלי.' },
        to: { type: 'string', description: 'תאריך סיום YYYY-MM-DD (כולל). אופציונלי.' },
        query: { type: 'string', description: 'טקסט חופשי — שם זמר, לקוח, מיקום או קבלן. אופציונלי.' },
        status: { type: 'string', enum: ['all', 'unbilled', 'unpaid'], description: 'unbilled = טרם הופקה חשבונית. unpaid = חויב אך טרם שולם. ברירת מחדל all.' },
        limit: { type: 'number', description: 'כמה תוצאות להחזיר. ברירת מחדל 25, מקסימום 60.' },
      },
    },
  },
  {
    name: 'event_details',
    description: 'כל הפרטים של אירוע אחד: תמחור מפורט, קבלנים וכמה מהם שולמו, עובדים, ומסמכי החיוב המקושרים. להשתמש אחרי search_events כשצריך לרדת לפרטים.',
    input_schema: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'מזהה האירוע כפי שחזר מ-search_events.' } },
      required: ['eventId'],
    },
  },
  {
    name: 'open_documents',
    description: 'מסמכים פתוחים בחשבונית ירוקה — חשבונות עסקה וחשבוניות מס שטרם נסגרו, כלומר הכנסה שטרם התקבלה. להשתמש עבור "מי חייב לי כסף".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_client',
    description: 'חיפוש לקוח בחשבונית ירוקה לפי שם. מחזיר מזהה, שם ומייל. להשתמש לפני הפקת מסמך, כדי להפיק ללקוח קיים ולא ליצור כפילות.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'שם הלקוח או חלק ממנו.' } },
      required: ['query'],
    },
  },
  {
    name: 'preview_quote',
    description: 'תצוגה מקדימה של הצעת מחיר — מייצר PDF לצפייה **בלי ליצור מסמך** בחשבונית ירוקה ובלי לתפוס מספר. זה הכלי המועדף כשהמשתמש מבקש "תראה לי" / "תצוגה מקדימה" / "לפני שמפיקים". מקבל את אותם שדות כמו create_quote.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'מזהה לקוח קיים מ-find_client.' },
        clientName: { type: 'string', description: 'שם לקוח, כשאין מזהה.' },
        eventId: { type: 'string', description: 'מזהה אירוע — השורות ייבנו אוטומטית מהתמחור שלו (הגברה, תאורה, סאונד, בקליין, לד, תוספות). במקרה כזה items מיותר.' },
        items: {
          type: 'array',
          description: 'שורות ידניות. לא נדרש אם ניתן eventId.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'תיאור השורה, בעברית.' },
              price: { type: 'number', description: 'מחיר ליחידה, ללא מע״מ.' },
              quantity: { type: 'number', description: 'כמות. ברירת מחדל 1.' },
            },
            required: ['description', 'price'],
          },
        },
        date: { type: 'string', description: 'תאריך המסמך YYYY-MM-DD. ברירת מחדל היום.' },
        description: { type: 'string', description: 'נושא המסמך. אם ניתן eventId ולא צוין — ייבנה מהאירוע.' },
        remarks: { type: 'string', description: 'הערה בתחתית המסמך. אופציונלי.' },
      },
    },
  },
  {
    name: 'create_quote',
    description: 'הפקת הצעת מחיר אמיתית בחשבונית ירוקה — תופסת מספר מסמך. המחירים ללא מע״מ; חשבונית ירוקה מוסיפה מע״מ מעליהם. לא שולח ללקוח (לשליחה יש כלי נפרד). אם המשתמש ביקש לראות קודם — השתמש ב-preview_quote.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'מזהה לקוח קיים מ-find_client. עדיף על clientName.' },
        clientName: { type: 'string', description: 'שם לקוח חדש, כשאין מזהה.' },
        eventId: { type: 'string', description: 'מזהה אירוע — השורות ייבנו אוטומטית מהתמחור שלו. במקרה כזה items מיותר.' },
        items: {
          type: 'array',
          description: 'שורות ידניות. לא נדרש אם ניתן eventId.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'תיאור השורה, בעברית.' },
              price: { type: 'number', description: 'מחיר ליחידה, ללא מע״מ.' },
              quantity: { type: 'number', description: 'כמות. ברירת מחדל 1.' },
            },
            required: ['description', 'price'],
          },
        },
        date: { type: 'string', description: 'תאריך המסמך YYYY-MM-DD. ברירת מחדל היום.' },
        description: { type: 'string', description: 'נושא המסמך — למשל "הגברה - אבי גואטה - ספטמבר 26".' },
        remarks: { type: 'string', description: 'הערה בתחתית המסמך. אופציונלי.' },
      },
    },
  },
  {
    name: 'remember',
    description: 'שמירת משהו לזיכרון הקבוע, כך שיהיה לך גם בשיחות הבאות. להשתמש כשהמשתמש אומר "תזכור ש...", כשהוא מתקן אותך, או כשעולה העדפה קבועה (מחיר סטנדרטי, ניסוח שהוא אוהב, לקוח שמתנהג אחרת). לשמור עובדה אחת קצרה וברורה בכל קריאה — לא סיכום של שיחה.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'העובדה, בניסוח שיהיה מובן גם בעוד חודש. למשל "המחיר הסטנדרטי להגברה בחתונה הוא 12,000 ללא מע״מ".' },
        kind: { type: 'string', enum: ['fact', 'preference', 'correction'], description: 'fact = עובדה על העסק/לקוח. preference = איך הוא אוהב שתעבוד. correction = תיקון לטעות שעשית.' },
        scope: { type: 'string', enum: ['company', 'all'], description: 'company = רק לעסק הנוכחי (ברירת מחדל). all = נכון לכל העסקים, למשל סגנון הדיבור שלו.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'forget',
    description: 'מחיקת פריט מהזיכרון הקבוע. להשתמש כשהמשתמש אומר "תשכח ש..." או כשמשהו שזכרת התברר כשגוי.',
    input_schema: {
      type: 'object',
      properties: { match: { type: 'string', description: 'מזהה הזיכרון או טקסט שמופיע בו.' } },
      required: ['match'],
    },
  },
  {
    name: 'send_document',
    description: 'שליחת מסמך קיים במייל ללקוח, מתיבת הדואר של העסק. להשתמש רק אחרי שהמשתמש ביקש במפורש לשלוח.',
    input_schema: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: 'מזהה המסמך (כפי שחזר מ-create_quote).' },
        email: { type: 'string', description: 'כתובת המייל של הלקוח.' },
        email2: { type: 'string', description: 'כתובת נוספת. אופציונלי.' },
      },
      required: ['docId', 'email'],
    },
  },
];

// preview_quote אינו כאן בכוונה: הוא אינו יוצר מסמך ואינו תופס מספר, ולכן
// גם משתמש צפייה יכול לראות איך הצעה תיראה.
// remember/forget כן — הזיכרון משותף, ומשתמש צפייה שמלמד את הסוכן משנה את
// ההתנהגות שלו אצל הבעלים.
const WRITE_TOOLS = new Set(['create_quote', 'send_document', 'remember', 'forget']);

// ---- מימוש הכלים ----
// כל כלי מחזיר אובייקט שמוחזר למודל כ-JSON. שומרים אותם קטנים: כל טוקן מיותר
// כאן חוזר בכל סיבוב של הלולאה ומתומחר שוב.

const evGross = (e) => (Number(e.price) || 0) + (Number(e.priceLighting) || 0) + (Number(e.priceSound) || 0)
  + (Number(e.priceBackline) || 0) + ((Number(e.ledPricePerMeter) || 0) * ((Number(e.ledMeters) || 0) || ((Number(e.ledPricePerMeter) || 0) ? 1 : 0)))
  + (Number(e.priceExtras) || 0);
const activeDocs = (e) => (Array.isArray(e.linkedDocs) ? e.linkedDocs : []).filter(d => !d.credited && !d.credit && !d.converted);
const isBilled = (e) => activeDocs(e).some(d => [300, 305, 320].includes(Number(d.type))) || e.invoiceStatus === 'invoiced';
const isPaid = (e) => Boolean(e.clientPaid) || activeDocs(e).some(d => [320, 400].includes(Number(d.type)));

function evMatches(e, q) {
  const hay = [e.artist, e.clientName, e.location, ...(e.contractors || []), ...(e.employees || [])].join(' ').toLowerCase();
  return hay.includes(String(q).toLowerCase());
}

// בניית גוף ההצעה — משותף לתצוגה המקדימה ולהפקה, כדי ששניהם לא יתפצלו.
// מה שראית בתצוגה המקדימה הוא בדיוק מה שיופק.
function buildQuote(a, { companyId }) {
  let items = (a.items || []).filter(it => it && it.description && Number(it.price) > 0)
    .map(it => ({ description: String(it.description), price: Number(it.price), quantity: Number(it.quantity) || 1 }));
  let description = a.description || null;
  let clientId = a.clientId || null, clientName = String(a.clientName || '').trim();
  // אירוע → שורות. אותו פורמט שורה של מסך החיוב, ולא ניסוח שהמודל ימציא.
  if (a.eventId) {
    const ev = companyEvents(load(), companyId).find(e => e.id === a.eventId);
    if (!ev) return { error: 'לא נמצא אירוע עם המזהה הזה בעסק הזה.' };
    if (!items.length) items = invoiceItemsFromEvents([ev]).map(it => ({ description: it.description, price: it.price, quantity: it.quantity }));
    if (!description) description = subjectForEvents([ev]);
    if (!clientId && !clientName) { clientId = ev.clientId || null; clientName = (ev.clientName || '').trim(); }
  }
  if (!items.length) return { error: 'אין שורות תקינות להצעה — צריך תיאור ומחיר גדול מאפס, או eventId עם תמחור.' };
  if (!clientId && !clientName) return { error: 'חסר לקוח — clientId, clientName או eventId עם לקוח משויך.' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? a.date : new Date().toISOString().slice(0, 10);
  return {
    total: Math.round(items.reduce((s, it) => s + it.price * it.quantity, 0) * 100) / 100,
    clientLabel: clientName || null,
    opts: { type: 10, client: clientId ? { id: clientId } : { name: clientName }, items, date,
      description: description || undefined, remarks: a.remarks || null },
  };
}

const EXEC = {
  async search_events(a, { companyId }) {
    const db = load();
    let list = companyEvents(db, companyId).filter(e => e.confirmed);
    if (a.from) list = list.filter(e => ymd(e.date || e.dateRaw) >= a.from);
    if (a.to) list = list.filter(e => ymd(e.date || e.dateRaw) <= a.to);
    if (a.query) list = list.filter(e => evMatches(e, a.query));
    if (a.status === 'unbilled') list = list.filter(e => !isBilled(e) && !e.noInvoice);
    if (a.status === 'unpaid') list = list.filter(e => isBilled(e) && !isPaid(e));
    list.sort((x, y) => ymd(x.date || x.dateRaw).localeCompare(ymd(y.date || y.dateRaw)));
    const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 60);
    return {
      total: list.length,
      events: list.slice(0, limit).map(e => ({
        id: e.id, date: ymd(e.date || e.dateRaw), artist: e.artist || null, location: e.location || null,
        client: e.clientName || null, priceExVat: evGross(e) || null,
        billed: isBilled(e), paid: isPaid(e),
      })),
    };
  },

  async event_details(a, { companyId }) {
    const ev = companyEvents(load(), companyId).find(e => e.id === a.eventId);
    if (!ev) return { error: 'לא נמצא אירוע עם המזהה הזה בעסק הזה.' };
    return {
      id: ev.id, date: ymd(ev.date || ev.dateRaw), artist: ev.artist || null, location: ev.location || null,
      client: ev.clientName || null,
      pricing: {
        performance: num(ev.price), lighting: num(ev.priceLighting), sound: num(ev.priceSound),
        backline: num(ev.priceBackline), ledPricePerMeter: num(ev.ledPricePerMeter), ledMeters: num(ev.ledMeters),
        extras: num(ev.priceExtras), totalExVat: evGross(ev),
      },
      contractors: (ev.contractorDetails || []).map(c => ({ name: c.name, amount: num(c.amount), paid: Boolean(c.paid) })),
      employees: (ev.employeeDetails || []).map(w => ({ name: w.name, factor: num(w.factor), bonus: num(w.bonus), note: w.note || null })),
      documents: (ev.linkedDocs || []).map(d => ({
        id: d.id, number: d.number ?? null, type: DOC_NAME[Number(d.type)] || String(d.type),
        converted: Boolean(d.converted), credited: Boolean(d.credited),
      })),
      billed: isBilled(ev), paid: isPaid(ev), noInvoice: Boolean(ev.noInvoice),
    };
  },

  async open_documents() {
    const list = await greenInvoice.openDocuments();
    return {
      total: (list || []).length,
      documents: (list || []).slice(0, 40).map(d => ({
        number: d.number, type: DOC_NAME[Number(d.type)] || String(d.type), date: ymd(d.date),
        client: d.clientName, amountIncVat: d.amount, amountDue: d.amountDue,
      })),
    };
  },

  async find_client(a) {
    const all = await greenInvoice.listClients();
    const q = String(a.query || '').toLowerCase();
    const hit = (all || []).filter(c => String(c.name || '').toLowerCase().includes(q));
    return {
      total: hit.length,
      clients: hit.slice(0, 10).map(c => ({ id: c.id, name: c.name, email: (c.emails && c.emails[0]) || c.email || null })),
    };
  },

  async preview_quote(a, ctx) {
    const built = buildQuote(a, ctx);
    if (built.error) return built;
    let pdf;
    try { pdf = await greenInvoice.previewDocument(built.opts); }
    catch (e) { return { error: 'התצוגה המקדימה נכשלה: ' + String(e.message).slice(0, 200) }; }
    if (!pdf || !pdf.pdfBase64) return { error: 'חשבונית ירוקה לא החזירה PDF לתצוגה מקדימה.' };
    // ה-PDF נשמר ומוחזר כקישור. הוא לא נכנס לתשובת הכלי: base64 של מסמך שלם
    // היה תופח את ההקשר בכל סיבוב של הלולאה ומתומחר שוב ושוב.
    if (!host.saveAgentFile) return { error: 'שמירת התצוגה המקדימה אינה זמינה.' };
    const url = await host.saveAgentFile(ctx.companyId, {
      filename: `הצעת מחיר - ${built.clientLabel || 'טיוטה'}.pdf`, mime: 'application/pdf', base64: pdf.pdfBase64,
    });
    return { ok: true, preview: true, previewUrl: url, totalExVat: built.total, date: built.opts.date,
      lines: built.opts.items.map(it => `${it.description} · ${it.quantity}×${it.price}`),
      note: 'זו תצוגה מקדימה בלבד — לא נוצר מסמך ולא נתפס מספר.' };
  },

  async create_quote(a, ctx) {
    const built = buildQuote(a, ctx);
    if (built.error) return built;
    const doc = await greenInvoice.createDocument(built.opts);
    return { ok: true, docId: doc.id, number: doc.number, totalExVat: built.total,
      date: built.opts.date, url: doc.url || null };
  },

  async remember(a, { companyId }) {
    const r = rememberFact(companyId, { text: a.text, kind: a.kind || 'fact', scope: a.scope === 'all' ? 'all' : 'company', source: 'agent' });
    return r.error ? r : { ok: true, remembered: String(a.text).trim().slice(0, MEM_TEXT_MAX), updated: Boolean(r.replaced) };
  },

  async forget(a, { companyId }) {
    return forgetFact(companyId, String(a.match || '').trim());
  },

  async send_document(a, { companyId }) {
    if (!host.mailDocToClient) return { error: 'שליחת מייל אינה זמינה כרגע.' };
    // שולפים את המסמך כדי שנושא המייל יישא סוג ומספר. בלי זה הוא יוצא "מסמך" בלבד —
    // בדיוק התקלה שתוקנה כבר פעם אחת במיילים של אופק.
    let doc = { id: a.docId };
    try {
      const raw = await greenInvoice.getDocument(a.docId);
      if (raw && raw.id) doc = { id: raw.id, number: raw.number, type: raw.type, clientName: raw.client && raw.client.name };
    } catch { /* בלי הפרטים עדיין אפשר לשלוח */ }
    const r = await host.mailDocToClient(companyId, doc, [a.email, a.email2],
      { type: doc.type, clientName: doc.clientName || '' });
    if (!r || !r.sent) return { error: (r && r.error) || 'השליחה נכשלה.' };
    return { ok: true, sentTo: r.to || [a.email, a.email2].filter(Boolean), document: doc.number ?? null };
  },
};

// ---- הלולאה ----
const MAX_ROUNDS = 8;   // גדר בטיחות: מודל שנתקע בלולאת כלים לא ישרוף תקציב

const MEM_KIND_HE = { fact: 'עובדה', preference: 'העדפה', correction: 'תיקון' };
function memoryBlock(companyId) {
  const list = memoryOf(companyId);
  if (!list.length) return '';
  return `\n\n**מה שלמדת עד היום על העסק הזה ועל מי שאתה עובד אצלו.** זה גובר על
הנחות כלליות, ואם משהו כאן סותר את מה שנראה לך הגיוני — מה שכאן נכון:
${list.map(m => `· [${MEM_KIND_HE[m.kind] || 'עובדה'}] ${m.text}`).join('\n')}`;
}

function systemPrompt({ companyName, today, allowWrites }) {
  return `אתה העוזר האישי של בעל העסק "${companyName}" — חברת הפקות, הגברה ותאורה.

היום ${today}.

**איך לדבר.** כמו עוזר אנושי מנוסה שמכיר את העסק: עברית טבעית וזורמת, גוף ראשון,
בלי רובוטיות ובלי "אני מודל שפה". קצר — משפט או שניים, כמו בווטסאפ — אבל לא יבש
ולא בנוסח טופס. אל תחזור על מה שהוא כתב ואל תפתח ב"בוודאי" או "בשמחה".
כשאתה מדווח על פעולה, אמור בפשטות מה עשית ומה יצא.

**הבן אותו גם כשהוא לא מדייק.** הוא כותב מהר, מהטלפון, בקיצורים:
· תאריכים: "10.09.26" / "10.9" / "מחר" / "בשבוע הבא" — כולם תקינים. שנה חסרה = השנה הנוכחית.
· שמות עסקים: "בי פי אם" = BPM. "אופק" / "משה" = שאר העסקים.
· סכומים: "15 אלף" = 15,000. "5.5" בהקשר של מחיר = 5,500.
· פעלים: "תוציא" / "תכין" / "תעשה לי" = הפק. "תראה לי" / "תעביר אליי" = תצוגה מקדימה.
אל תבקש ממנו לנסח מחדש — תבין, ואם באמת לא ברור, שאל על הפרט האחד שחסר.

מה שחשוב לדעת:
· כל הסכומים במערכת הם **ללא מע״מ**, אלא אם נאמר אחרת. חשבונית ירוקה מוסיפה מע״מ מעל.
· אתה רואה **רק** את הנתונים של ${companyName}. אם נשאלת על עסק אחר — אמור שצריך להחליף עסק.
· אל תמציא מספרים. אם אין לך נתון — הפעל כלי או אמור שאין.

**כשחסר מידע — תשאל.** לעולם אל תמציא ואל תוותר על הבקשה. קודם נסה להשלים לבד
מהמערכת (למשל: המשתמש נקב בתאריך אירוע → חפש את האירוע ומשם קח לקוח ותמחור;
נקב בשם לקוח → find_client). רק מה שבאמת אי אפשר להסיק — שאל עליו, בשאלה אחת
קצרה, וכשאפשר הצע ברירת מחדל ("אשתמש ב-X אם לא תגיד אחרת"). אם חסרים כמה פרטים,
שאל עליהם יחד ברשימה קצרה ולא אחד-אחד.
· כלי שמחזיר error עם פרט חסר — זו לא תקלה. קרא מה חסר, השלם או שאל, ונסה שוב.
· "תראה לי" / "תצוגה מקדימה" / "לפני שמפיקים" → preview_quote, לא create_quote.

**לפני create_quote — הכלל המחמיר.** הפקה תופסת מספר מסמך ואי אפשר לבטל אותה
בלחיצה. לכן ארבעת הפרטים — לקוח, שורות, סכום, תאריך — חייבים להיות **נתונים
מהמשתמש או שנשלפו מהמערכת**. פרט שאתה רק מניח או משלים מהיגיון — אל תפיק, שאל.
מוטב לשאול שאלה מיותרת מלהפיק מסמך שגוי.
· הצעת מחיר היא **ללא מע״מ** בשורות. אם הוא נקב בסכום "כולל מע״מ" — חלק ב-1.18 ואמור לו מה עשית.
· אחרי הפקת מסמך, דווח מספר מסמך וסכום. אל תשלח ללקוח אלא אם ביקש במפורש.
${allowWrites ? '' : '· אתה במצב קריאה בלבד — אינך יכול להפיק או לשלוח מסמכים. אם הוא מבקש, אמור זאת.\n'}
· חשבונית מס וחשבונית מס-קבלה אינן נוצרות דרכך. אם הוא מבקש — הפנה אותו לאתר.

**תלמד תוך כדי עבודה.** אתה לא זוכר שיחות קודמות מלבד מה ששמור בזיכרון, ולכן
הפעל remember בכל פעם שעולה משהו שיועיל לך גם בעוד חודש: מחיר סטנדרטי, איך הוא
מנסח, מה לקוח מסוים דורש, טעות שעשית ואיך היא נראית נכון. אל תחכה ל"תזכור ש..." —
אם הוא תיקן אותך, זה תיקון ששווה לשמור. עובדה אחת לכל קריאה, קצרה ומובנת.
אל תשמור פרטים חד-פעמיים (סכום של אירוע מסוים, תאריך של בקשה אחת) — רק מה שחוזר.`;
}

// messages: [{role:'user'|'assistant', content:string}] — היסטוריית השיחה
// מחזיר { reply, steps:[{tool, input, output}], usage }
export async function runAgent({ companyId, companyName, messages, allowWrites = false, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('הסוכן לא מוגדר — חסר ANTHROPIC_API_KEY');
  const tools = AGENT_TOOLS.filter(t => allowWrites || !WRITE_TOOLS.has(t.name));
  const system = systemPrompt({
    companyName: companyName || companyId,
    today: new Date().toISOString().slice(0, 10),
    allowWrites,
  }) + memoryBlock(companyId);
  // ההקשר הקבוע (הנחיות + הגדרות הכלים) חוזר זהה בכל סיבוב — שווה מטמון
  const sysBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const convo = messages.map(m => ({ role: m.role, content: m.content }));
  const steps = [];
  const mdl = model || process.env.AGENT_MODEL || 'claude-sonnet-5';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: mdl, max_tokens: 2000, system: sysBlocks, tools, messages: convo }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`שגיאת סוכן (${res.status}): ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהסוכן'); }
    trackUsage('agent', mdl, data.usage);

    const blocks = data.content || [];
    const calls = blocks.filter(b => b.type === 'tool_use');
    if (!calls.length) {
      const reply = blocks.map(b => b.text).filter(Boolean).join('').trim();
      return { reply: reply || '(אין תשובה)', steps };
    }

    convo.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) {
      let out;
      try {
        const fn = EXEC[c.name];
        if (!fn) out = { error: 'כלי לא מוכר' };
        else if (WRITE_TOOLS.has(c.name) && !allowWrites) out = { error: 'אין הרשאה לפעולה זו' };
        else out = await fn(c.input || {}, { companyId });
      } catch (e) {
        // שגיאת כלי חוזרת למודל כטקסט ולא מפילה את השיחה — הוא יכול לתקן ולנסות שוב
        out = { error: String((e && e.message) || e).slice(0, 300) };
      }
      steps.push({ tool: c.name, input: c.input || {}, output: out });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'לא הצלחתי לסיים את הבקשה — היא דרשה יותר מדי צעדים. נסה לפרק אותה.', steps };
}

// ================= רפלקציה: לימוד בלי שביקשו =================
// הכלי remember תופס רק מה שהסוכן שם לב אליו תוך כדי תשובה. המעבר הזה רץ
// *אחרי* שהתשובה כבר נשלחה, קורא את התור האחרון בעיניים של "מה למדנו כאן",
// ושומר. זה מה שגורם לו להשתפר מעצם השימוש ולא רק כשאומרים לו "תזכור".
//
// שלוש בחירות מכוונות:
//   · Haiku ולא Sonnet — זו משימת חילוץ קצרה שרצה בכל תור. פי 3 זול יותר.
//   · רץ ברקע ולא חוסם את התשובה. כישלון שלו לא מורגש ואינו מפיל כלום.
//   · שמרני בכוונה: עדיף להחמיץ לקח מלשמור זיכרון שגוי, כי זיכרון שגוי
//     ישפיע על כל שיחה עתידית ואף אחד לא יבין למה.
const REFLECT_SYSTEM = `אתה מחלץ לקחים משיחה בין בעל עסק (הפקות, הגברה ותאורה) לעוזר שלו.
החזר JSON בלבד: {"learn":[{"text":"...","kind":"fact|preference|correction","scope":"company|all"}]}

שמור רק מה שיעזור לעוזר **בשיחה אחרת, בעוד חודש**:
· העדפה קבועה — איך הוא רוצה שדברים ייעשו, איך הוא מנסח, מה הוא לא אוהב.
· עובדה שחוזרת — מחיר סטנדרטי, כינוי של לקוח, איך לקוח מסוים עובד, מי הקבלן הקבוע.
· תיקון — העוזר טעה והמשתמש תיקן. שמור את הנוסח הנכון.

אל תשמור:
· פרט חד-פעמי (סכום של אירוע מסוים, תאריך של בקשה, מספר מסמך שהופק).
· מה שכבר מופיע ברשימת "ידוע כבר" למטה.
· ניחוש. אם לא נאמר במפורש — אל תשמור.
· את תוכן השאלה או התשובה כסיכום. רק לקח.

ברוב התורים אין מה ללמוד. במקרה כזה החזר {"learn":[]} — זו התשובה הנכונה והשכיחה.`;

export async function learnFromTurn({ companyId, userText, assistantText }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !userText || !assistantText) return { learned: [] };
  const known = memoryOf(companyId).map(m => '· ' + m.text).join('\n') || '(ריק)';
  const model = process.env.AGENT_REFLECT_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = `ידוע כבר:\n${known}\n\n---\nהמשתמש: ${String(userText).slice(0, 2000)}\nהעוזר: ${String(assistantText).slice(0, 2000)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 400, system: REFLECT_SYSTEM, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) return { learned: [] };
  const data = await res.json().catch(() => null);
  if (!data) return { learned: [] };
  trackUsage('agent-reflect', model, data.usage);
  const text = (data.content || []).map(c => c.text).filter(Boolean).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { learned: [] };
  let parsed; try { parsed = JSON.parse(m[0]); } catch { return { learned: [] }; }
  const learned = [];
  for (const it of (parsed.learn || []).slice(0, 3)) {   // תקרה לתור: חילוץ שמתלהב לא יציף את הזיכרון
    if (!it || !it.text) continue;
    const r = rememberFact(companyId, { text: it.text, kind: it.kind || 'fact', scope: it.scope === 'all' ? 'all' : 'company', source: 'reflect' });
    if (r.ok) learned.push(it.text);
  }
  if (learned.length) console.log(`[agent] ${companyId}: נלמדו ${learned.length} — ${learned.join(' | ').slice(0, 200)}`);
  return { learned };
}

export default { runAgent, AGENT_TOOLS, registerAgentHost, learnFromTurn, memoryOf, rememberFact, forgetFact };
