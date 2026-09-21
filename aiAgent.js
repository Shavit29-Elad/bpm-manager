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

import { load, companyEvents } from './store.js';
import { greenInvoice } from './greenInvoice.js';
import { trackUsage } from './chat.js';

// פונקציות שחיות ב-server.js (שליחת מייל, חישובי דף הבית) מוזרקות מבחוץ כדי
// שלא ייווצר import מעגלי: server.js מייבא את הקובץ הזה, לא להפך.
let host = {};
export function registerAgentHost(fns) { host = { ...host, ...fns }; }

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
    name: 'create_quote',
    description: 'הפקת הצעת מחיר בחשבונית ירוקה. המחירים הם ללא מע״מ — חשבונית ירוקה מוסיפה מע״מ מעליהם. לא שולח ללקוח: לשליחה יש כלי נפרד. להפיק רק אחרי שברור מי הלקוח, מה השורות ומה הסכום.',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string', description: 'מזהה לקוח קיים מ-find_client. עדיף על clientName.' },
        clientName: { type: 'string', description: 'שם לקוח חדש, כשאין מזהה.' },
        items: {
          type: 'array',
          description: 'שורות ההצעה.',
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
        description: { type: 'string', description: 'נושא המסמך — למשל "הגברה ותאורה · 03.11.26 · היכל מנורה".' },
        remarks: { type: 'string', description: 'הערה בתחתית המסמך. אופציונלי.' },
      },
      required: ['items'],
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

const WRITE_TOOLS = new Set(['create_quote', 'send_document']);

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

  async create_quote(a) {
    const items = (a.items || []).filter(it => it && it.description && Number(it.price) > 0);
    if (!items.length) return { error: 'אין שורות תקינות להצעה — צריך תיאור ומחיר גדול מאפס.' };
    if (!a.clientId && !String(a.clientName || '').trim()) return { error: 'חסר לקוח — clientId או clientName.' };
    const doc = await greenInvoice.createDocument({
      type: 10,
      client: a.clientId ? { id: a.clientId } : { name: String(a.clientName).trim() },
      items: items.map(it => ({ description: it.description, price: Number(it.price), quantity: Number(it.quantity) || 1 })),
      description: a.description || undefined,
      remarks: a.remarks || null,
    });
    const total = items.reduce((s, it) => s + Number(it.price) * (Number(it.quantity) || 1), 0);
    return { ok: true, docId: doc.id, number: doc.number, totalExVat: total, url: doc.url || null };
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

function systemPrompt({ companyName, today, allowWrites }) {
  return `אתה העוזר האישי של בעל העסק "${companyName}". אתה מדבר איתו בווטסאפ, בעברית, קצר וענייני — לא פסקאות.

היום ${today}.

מה שחשוב לדעת:
· כל הסכומים במערכת הם **ללא מע״מ**, אלא אם נאמר אחרת. חשבונית ירוקה מוסיפה מע״מ מעל.
· אתה רואה **רק** את הנתונים של ${companyName}. אם נשאלת על עסק אחר — אמור שצריך להחליף עסק.
· אל תמציא מספרים. אם אין לך נתון — הפעל כלי או אמור שאין.
· לפני הפקת מסמך, ודא שברור מי הלקוח, מה השורות ומה הסכום. בספק — שאל שאלה אחת קצרה במקום לנחש.
· הצעת מחיר היא **ללא מע״מ** בשורות. אם הוא נקב בסכום "כולל מע״מ" — חלק ב-1.18 ואמור לו מה עשית.
· אחרי הפקת מסמך, דווח מספר מסמך וסכום. אל תשלח ללקוח אלא אם ביקש במפורש.
${allowWrites ? '' : '· אתה במצב קריאה בלבד — אינך יכול להפיק או לשלוח מסמכים. אם הוא מבקש, אמור זאת.\n'}
· חשבונית מס וחשבונית מס-קבלה אינן נוצרות דרכך. אם הוא מבקש — הפנה אותו לאתר.`;
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
  });
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

export default { runAgent, AGENT_TOOLS, registerAgentHost };
