// lib/greenInvoice.js
// מחבר ל-API של חשבונית ירוקה (Green Invoice REST API v1).
// מסמכים: https://www.greeninvoice.co.il/api-docs
//
// אימות: POST /account/token עם { id, secret } -> מחזיר JWT ל-30 דקות.
// כל שאר הקריאות עם Authorization: Bearer <token>.
//
// המפתחות נטענים ממשתני סביבה - לא נשמרים בקוד:
//   GREENINVOICE_API_KEY_ID
//   GREENINVOICE_API_SECRET

const BASE = process.env.GREENINVOICE_BASE || 'https://api.greeninvoice.co.il/api/v1';

let cachedToken = null;
let tokenExpiry = 0;

function haveCredentials() {
  return Boolean(process.env.GREENINVOICE_API_KEY_ID && process.env.GREENINVOICE_API_SECRET);
}

// איפוס טוקן מטמון (למשל אחרי שינוי מפתחות מהממשק)
function resetToken() { cachedToken = null; tokenExpiry = 0; try { clearDataCache(); } catch {} }

// בדיקת חיבור אמיתית: מנסה להשיג טוקן מול חשבונית ירוקה
async function verify() {
  if (!haveCredentials()) return { ok: false, error: 'לא הוזנו מפתחות' };
  try { resetToken(); await getToken(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

async function getToken() {
  if (!haveCredentials()) {
    throw new Error('חסרים מפתחות חשבונית ירוקה (GREENINVOICE_API_KEY_ID / GREENINVOICE_API_SECRET)');
  }
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const res = await fetch(`${BASE}/account/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: process.env.GREENINVOICE_API_KEY_ID,
      secret: process.env.GREENINVOICE_API_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`שגיאת אימות חשבונית ירוקה: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.token;
  tokenExpiry = Date.now() + 25 * 60 * 1000; // ~25 דקות שמרני
  return cachedToken;
}

async function api(pathName, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`חשבונית ירוקה ${method} ${pathName}: ${res.status} ${text}`);
  return json;
}

// ===== מטמון קריאה (מונע דפדוף חוזר על אלפי מסמכים בכל לחיצה) =====
const _dataCache = new Map();       // key -> { at, val (Promise) }
const DATA_TTL = 3 * 60 * 1000;     // 3 דקות
function cached(key, fn, ttl = DATA_TTL) {
  const hit = _dataCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const p = Promise.resolve().then(fn);
  _dataCache.set(key, { at: Date.now(), val: p });
  p.catch(() => { if (_dataCache.get(key)?.val === p) _dataCache.delete(key); }); // בכשל — לא לשמור
  return p;
}
export function clearDataCache() { _dataCache.clear(); }

// סוגי מסמכים בחשבונית ירוקה (type) — לפי דוקומנטציית מורנינג/חשבונית ירוקה:
//   10=הצעת מחיר, 100=הזמנה, 300=חשבון עסקה (עסקה), 305=חשבונית מס,
//   320=חשבונית מס/קבלה, 330=חשבונית זיכוי, 400=קבלה
export const DOC_TYPES = { PRICE_QUOTE: 10, PROFORMA: 300, INVOICE: 305, INVOICE_RECEIPT: 320, RECEIPT: 400 };
// סוגים שמחייבים מערך תשלום (payment) ביצירה
const PAYMENT_REQUIRED = new Set([320, 400, 405]);

// בונה גוף מסמך. items = [{ description, quantity, price }].
// client = { id? , name, taxId?, emails? } — אם יש id משתמשים בו (נמנע כפילות לקוח).
function documentBody({ client, items, type, remarks, description, dueDate, date, payment, sendEmail, email }) {
  const total = items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
  const body = {
    type,
    lang: 'he',
    currency: 'ILS',
    date: date || new Date().toISOString().slice(0, 10),
    client: client?.id
      ? { id: client.id }
      : { name: client?.name, taxId: client?.taxId, add: true, emails: client?.emails || [] },
    income: items.map(it => {
      const line = {
        description: it.description,
        quantity: Number(it.quantity) || 1,
        price: Number(it.price) || 0,
        currency: 'ILS',
        vatType: 0, // 0 = חייב מע"מ (המע"מ מתווסף מעל המחיר)
      };
      if (it.catalogNum) line.catalogNum = String(it.catalogNum); // מק"ט (לא חובה)
      return line;
    }),
  };
  // שליחת מייל ללקוח רק אם המשתמש ביקש במפורש (ברירת מחדל: לא נשלח)
  if (sendEmail && email) body.emails = [String(email).trim()];
  if (description) body.description = description;   // כותרת/נושא המסמך
  if (remarks) body.remarks = remarks;              // הערה בתחתית
  if (dueDate) body.dueDate = dueDate;
  // מסמכים מסוג קבלה/מס-קבלה מחייבים תיעוד תשלום
  if (PAYMENT_REQUIRED.has(type)) {
    body.payment = payment && payment.length ? payment
      : [{ date: body.date, type: 4 /* העברה בנקאית */, price: total, currency: 'ILS' }];
  }
  return body;
}

// יצירת מסמך גנרי (עסקה/מס/מס-קבלה/קבלה) והחזרת גרסה ממופה
export async function createDocument(opts) {
  const raw = await api('/documents', { method: 'POST', body: documentBody(opts) });
  clearDataCache();
  const url = (raw.url && (raw.url.he || raw.url.origin || raw.url.pdf)) || (typeof raw.url === 'string' ? raw.url : null);
  return { id: raw.id, number: raw.number, type: raw.type, url, raw };
}

// תאימות לאחור — הפקת חשבונית מס (או סוג אחר עם type)
export async function createInvoice({ client, items, type = DOC_TYPES.INVOICE, remarks, description, dueDate, payment }) {
  return createDocument({ client, items, type, remarks, description, dueDate, payment });
}

// חיפוש מסמכים בטווח תאריכים (למעקב תשלומים/התאמות)
export async function searchDocuments({ fromDate, toDate, page = 1, pageSize = 100 } = {}) {
  return api('/documents/search', {
    method: 'POST',
    body: { fromDate, toDate, page, pageSize, sort: 'documentDate' },
  });
}

// הפקת קבלה כנגד חשבונית ששולמה
export async function createReceipt({ client, items, remarks }) {
  return createInvoice({ client, items, type: DOC_TYPES.RECEIPT, remarks });
}

// ===== נתונים לדף הבית =====
const num = (v) => (Number(v) || 0);
function lastDay(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

// מיפוי מסמך לתצוגה, כולל פירוק מע"מ (הסכום בחשבונית ירוקה כולל מע"מ)
function mapDoc(d) {
  const amount = num(d.amount ?? d.total ?? d.sum); // כולל מע"מ
  const vat = d.vat != null ? num(d.vat) : amount - amount / 1.18; // 18% אם לא סופק
  return {
    id: d.id, number: d.number, type: d.type, date: d.documentDate,
    amount,
    amountIncVat: amount,
    amountExVat: amount - vat,
    vat,
    clientName: d.client?.name || d.clientName || d.client_name || '—',
    url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null),
    amountDue: d.amountDue,
  };
}

// כל המסמכים בטווח תאריכים (עם דפדוף), לפי סוגים
async function documentsInRange(fromDate, toDate, types) {
  const all = [];
  let page = 1;
  for (let i = 0; i < 20; i++) { // עד ~2000 מסמכים
    const res = await api('/documents/search', {
      method: 'POST',
      body: { fromDate, toDate, page, pageSize: 100, type: types, sort: 'documentDate' },
    });
    const items = res.items || [];
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

// הכנסה בטווח מחשבוניות מס (305) + מס/קבלה (320), צפי מע"מ + פירוט
export async function incomeForRange(fromDate, toDate, types = [305, 320]) {
  return cached(`income:${fromDate}:${toDate}:${types.join(',')}`, async () => {
    const items = await documentsInRange(fromDate, toDate, types);
    const docs = items.map(mapDoc);
    const income = docs.reduce((s, d) => s + d.amountIncVat, 0);
    const vat = docs.reduce((s, d) => s + d.vat, 0);
    return { income, vat, count: docs.length, docs };
  });
}

// תאימות לאחור — חודש בודד
export async function monthlyIncome(month) {
  return incomeForRange(`${month}-01`, lastDay(month));
}

// קבלות (סוג 400) בטווח — לצורך קישור קבלה לחשבונית מס בהתאמות בנק
export async function receiptsForRange(fromDate, toDate) {
  return cached(`receipts:${fromDate}:${toDate}`, async () => {
    const items = await documentsInRange(fromDate, toDate, [400]);
    return items.map(mapDoc);
  });
}

// כל המסמכים של לקוח מסוים (כל הסוגים, כל התאריכים)
export async function clientDocuments(clientId) {
  return cached(`clientDocs:${clientId}`, async () => {
    const all = [];
    let page = 1;
    for (let i = 0; i < 10; i++) { // עד ~1000 מסמכים
      const res = await api('/documents/search', {
        method: 'POST',
        body: { clientId, page, pageSize: 100, sort: 'documentDate' },
      });
      const items = res.items || [];
      all.push(...items);
      if (items.length < 100) break;
      page++;
    }
    // סינון הגנתי למקרה שה-API לא סינן לפי לקוח
    const filtered = all.filter(d => !d.client || !d.client.id || d.client.id === clientId);
    return (filtered.length ? filtered : all).map(mapDoc);
  });
}

// כמות חשבוניות מס פתוחות (לא שולמו במלואן)
export async function openInvoicesCount() {
  return cached('openInvoices', async () => {
    const res = await api('/documents/search', {
      method: 'POST',
      body: { page: 1, pageSize: 100, type: [305], sort: 'documentDate' },
    });
    const items = res.items || [];
    return items.filter(d => {
      if (d.amountDue != null) return num(d.amountDue) > 0.01;
      if (d.paid != null) return !d.paid;
      if (d.paymentStatus != null) return num(d.paymentStatus) === 0;
      return false;
    }).length;
  });
}

// מסמכים פתוחים לתצוגת "חשבוניות פתוחות" בדף הבית (כמו "חיובים קרובים" בחשבונית ירוקה).
// מחזיר חשבון עסקה (300) + חשבונית מס (305) שעדיין פתוחים, ממופים לתצוגה.
export async function openDocuments({ months = 18 } = {}) {
  return cached(`openDocs:${months}`, async () => {
    const to = new Date();
    const from = new Date(); from.setMonth(from.getMonth() - months);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    const items = await documentsInRange(fromDate, toDate, [300, 305]);
    const isOpen = (d) => {
      if (Number(d.type) === 305) { // חשבונית מס — פתוחה אם נותר סכום לתשלום
        if (d.amountDue != null) return num(d.amountDue) > 0.01;
        if (d.paid != null) return !d.paid;
        if (d.paymentStatus != null) return num(d.paymentStatus) < 2;
        return true;
      }
      // חשבון עסקה — פתוח כל עוד לא נסגר/הומר לחשבונית
      if (d.status != null) return num(d.status) === 0;
      if (d.paid != null) return !d.paid;
      return true;
    };
    return items.filter(isOpen).map(d => ({
      ...mapDoc(d), status: d.status ?? null, paid: d.paid ?? null, paymentStatus: d.paymentStatus ?? null,
    }));
  });
}

// רשימת לקוחות (ממורנינג / חשבונית ירוקה)
export async function listClients() {
  return cached('clients', async () => {
    const res = await api('/clients/search', { method: 'POST', body: { page: 1, pageSize: 200 } });
    return (res.items || []).map(c => ({ id: c.id, name: c.name })).filter(c => c.name);
  });
}

// רשימת ספקים מחשבונית ירוקה (לשיוך קבלנים)
export async function listSuppliers() {
  return cached('suppliers', async () => {
    const res = await api('/suppliers/search', { method: 'POST', body: { page: 1, pageSize: 200 } });
    return (res.items || []).map(s => ({ id: s.id, name: s.name })).filter(s => s.name);
  });
}

// בונה גוף בקשה ליצירת לקוח/ספק — שדות: שם, ח.פ/ע.מ/ת"ז, איש קשר, טלפון
function contactBody({ name, taxId, contactPerson, phone, emails }) {
  const body = { name: String(name || '').trim(), active: true };
  if (taxId) body.taxId = String(taxId).trim();
  if (phone) body.phone = String(phone).trim();
  if (Array.isArray(emails) && emails.filter(Boolean).length) body.emails = emails.filter(Boolean);
  if (contactPerson) body.remarks = `איש קשר: ${String(contactPerson).trim()}`;
  return body;
}
// יצירת לקוח חדש בחשבונית ירוקה
export async function createClient(data) {
  const r = await api('/clients', { method: 'POST', body: contactBody(data) });
  clearDataCache();
  return r;
}
// יצירת ספק חדש בחשבונית ירוקה
export async function createSupplier(data) {
  const r = await api('/suppliers', { method: 'POST', body: contactBody(data) });
  clearDataCache();
  return r;
}

export const greenInvoice = { haveCredentials, resetToken, verify, createInvoice, createDocument, createReceipt, createClient, createSupplier, searchDocuments, monthlyIncome, incomeForRange, receiptsForRange, openInvoicesCount, openDocuments, listClients, listSuppliers, clientDocuments, DOC_TYPES };
export default greenInvoice;
