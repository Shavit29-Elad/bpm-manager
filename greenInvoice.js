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
function documentBody({ client, items, type, remarks, description, dueDate, date, payment, sendEmail, email, linkedDocumentIds, linkType }) {
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
  // מסמך המשך — קישור למסמך מקור (למשל הצעת מחיר → חשבונית)
  if (Array.isArray(linkedDocumentIds) && linkedDocumentIds.length) body.linkedDocumentIds = linkedDocumentIds;
  // linkType: "link" (קישור) או "cancel" (ביטול — לזיכוי/קבלה שלילית)
  if (linkType) body.linkType = linkType;
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

// תצוגה מקדימה מעוצבת של מסמך לפני הפקה (POST /documents/preview) — לא יוצר מסמך אמיתי.
// מחזיר { pdfBase64 } אם התקבל PDF, אחרת { url } / { raw }.
export async function previewDocument(opts) {
  const token = await getToken();
  const res = await fetch(`${BASE}/documents/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(documentBody(opts)),
  });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`חשבונית ירוקה POST /documents/preview: ${res.status} ${t.slice(0, 300)}`); }
  if (ct.includes('application/pdf') || ct.includes('octet-stream')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { pdfBase64: buf.toString('base64') };
  }
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const url = (data.url && (data.url.he || data.url.origin || data.url.pdf)) || (typeof data.url === 'string' ? data.url : null);
  const file = data.file || data.pdf || data.base64 || null;
  return { url, pdfBase64: file, raw: data };
}

// תאימות לאחור — הפקת חשבונית מס (או סוג אחר עם type)
export async function createInvoice({ client, items, type = DOC_TYPES.INVOICE, remarks, description, dueDate, payment }) {
  return createDocument({ client, items, type, remarks, description, dueDate, payment });
}

// חיפוש מהיר של מסמכים לפי מספר או טקסט מהתיאור (לשורת החיפוש בלקוחות)
export async function quickSearchDocuments(term) {
  const q = String(term || '').trim();
  if (q.length < 2) return [];
  const byId = new Map();
  const collect = (items) => { for (const d of (items || [])) if (d && d.id) byId.set(d.id, d); };
  // לפי תיאור (חיפוש טקסט)
  try {
    const r = await api('/documents/search', { method: 'POST', body: { description: q, page: 1, pageSize: 40, sort: 'documentDate' } });
    collect(r.items);
  } catch { /* ממשיכים */ }
  // לפי מספר מסמך (אם מספרי)
  if (/^\d+$/.test(q)) {
    try {
      const r = await api('/documents/search', { method: 'POST', body: { number: Number(q), page: 1, pageSize: 40, sort: 'documentDate' } });
      collect(r.items);
    } catch { /* ממשיכים */ }
  }
  return [...byId.values()].slice(0, 25).map(d => ({
    id: d.id, number: d.number, type: d.type, date: d.documentDate,
    description: d.description || d.remarks || '',
    clientName: d.client?.name || d.clientName || '—',
    clientId: d.client?.id || null,
    amount: d.amount,
    url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null),
  }));
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
    status: d.status, // 0=פתוח, 1=סגור, 2=סומן ידנית כסגור, 3=מבטל מסמך אחר, 4=מבוטל
    description: d.description || d.remarks || '',
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
    // סך כל החיובים הפתוחים = חשבון עסקה (300) + חשבונית מס (305) עם status 0 — כמו "חיובים קרובים" בחשבונית ירוקה
    const docs = await openDocuments();
    return docs.length;
  });
}

// מסמכים פתוחים לתצוגת "חשבוניות פתוחות" בדף הבית (כמו "חיובים קרובים" בחשבונית ירוקה).
// בחשבונית ירוקה status===0 = פתוח, status===1 = סגור (שולם/הומר), 2/4 = מבוטל/אחר.
export async function openDocuments({ months = 24 } = {}) {
  return cached(`openDocs:${months}`, async () => {
    const to = new Date();
    const from = new Date(); from.setMonth(from.getMonth() - months);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    const items = await documentsInRange(fromDate, toDate, [300, 305]);
    return items.filter(d => Number(d.status) === 0).map(d => {
      const amount = num(d.amount ?? d.total ?? d.sum);
      const openAmt = d.amountOpened != null ? num(d.amountOpened)
        : (d.amountDueVat != null ? num(d.amountDueVat) : amount);
      return {
        id: d.id, number: d.number, type: d.type, date: d.documentDate,
        clientName: d.client?.name || d.clientName || '—',
        description: d.description || '',
        amount, amountDue: openAmt, status: d.status,
        url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null),
      };
    });
  });
}

// הצעות מחיר פתוחות (type 10, status 0)
export async function openQuotes({ months = 36 } = {}) {
  return cached(`openQuotes:${months}`, async () => {
    const to = new Date(); const from = new Date(); from.setMonth(from.getMonth() - months);
    const items = await documentsInRange(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), [10]);
    return items.filter(d => Number(d.status) === 0).map(d => {
      const amount = num(d.amount ?? d.total ?? d.sum);
      return { id: d.id, number: d.number, type: d.type, date: d.documentDate, clientName: d.client?.name || d.clientName || '—', description: d.description || '', amount, status: d.status, url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null) };
    });
  });
}
// מסמך מלא לפי מזהה
export async function getDocument(id) { return api(`/documents/${encodeURIComponent(id)}`); }
// סגירת מסמך (למשל הצעת מחיר שכבר לא רלוונטית) — status → 2 (סגור ידנית)
export async function closeDocument(id) { const r = await api(`/documents/${encodeURIComponent(id)}/close`, { method: 'POST' }); clearDataCache(); return r; }
// פתיחה מחדש של מסמך סגור
export async function openDocument(id) { const r = await api(`/documents/${encodeURIComponent(id)}/open`, { method: 'POST' }); clearDataCache(); return r; }

// התאריך של המסמך האחרון שהופק (לכל הסוגים, או לסוג מסוים) — להגבלת בורר התאריך בקליטה
export async function latestDocumentDate(type = null) {
  const today = new Date();
  const from = new Date(today.getTime() - 400 * 864e5).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const body = { fromDate: from, toDate: to, page: 1, pageSize: 100, sort: 'documentDate' };
  if (type) body.type = Array.isArray(type) ? type : [type];
  const res = await api('/documents/search', { method: 'POST', body });
  const items = res.items || [];
  let max = null;
  for (const d of items) { const dt = d.documentDate; if (dt && (!max || dt > max)) max = dt; }
  return max; // 'YYYY-MM-DD' או null
}

// מיפוי מסמך הוצאה (ספק/קבלן)
function mapExpense(e) {
  const amount = num(e.amount ?? e.total ?? e.sum);
  return {
    id: e.id,
    number: e.number ?? e.documentNumber ?? e.reference ?? e.ref ?? '',
    type: e.type ?? e.documentType ?? e.expenseType ?? null,
    date: e.documentDate ?? e.date ?? e.paymentDate ?? null,
    supplierName: e.supplier?.name || e.supplierName || '—',
    supplierId: e.supplier?.id || e.supplierId || null,
    amount, amountIncVat: amount,
    amountExVat: e.amountExcludeVat != null ? num(e.amountExcludeVat) : amount,
    category: e.category?.name || e.categoryName || e.description || '',
    url: (e.url && (e.url.he || e.url.origin || e.url.pdf)) || (typeof e.url === 'string' ? e.url : null),
  };
}
// ===== הוצאות (קבלנים/ספקים) =====
// שלב 1: מקבל פרטי העלאה חתומים (S3 presigned) — טיוטת הוצאה חדשה שתעבור OCR
// הערה: נקודת הקצה יושבת על שרת נפרד (apigw) ולא על BASE הרגיל!
const FILE_UPLOAD_BASE = process.env.GREENINVOICE_FILE_UPLOAD_BASE || 'https://apigw.greeninvoice.co.il';
export async function getExpenseFileUploadUrl(existingId) {
  const token = await getToken();
  const payload = existingId ? { id: existingId, source: 5, state: 'expense' } : { source: 5 };
  const data = encodeURIComponent(JSON.stringify(payload));
  const url = `${FILE_UPLOAD_BASE}/file-upload/v1/url?context=expense&data=${data}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`חשבונית ירוקה GET /file-upload/v1/url: ${res.status} ${text}`);
  return json;
}
// שלב 2: מעלה את הקובץ ל-S3. שולחים את כל שדות ה-fields ואז את file אחרון (חובה!)
export async function uploadExpenseFile(fileBase64, fileName, mime, existingId) {
  const info = await getExpenseFileUploadUrl(existingId);
  const url = info?.url || info?.uploadUrl;
  const fields = info?.fields || {};
  if (!url) throw new Error('לא התקבל כתובת העלאה מחשבונית ירוקה');
  const buffer = Buffer.from(fileBase64, 'base64');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v)); // כל השדות תחילה
  form.append('file', new Blob([buffer], { type: mime || 'application/pdf' }), fileName || 'expense.pdf'); // file אחרון!
  const res = await fetch(url, { method: 'POST', body: form });
  if (res.status !== 204 && !res.ok) throw new Error(`העלאת הקובץ נכשלה: ${res.status} ${await res.text().catch(() => '')}`);
  clearDataCache();
  return { ok: true };
}
export async function getExpense(id) { return api(`/expenses/${encodeURIComponent(id)}`); }
export async function getSupplier(id) { return api(`/suppliers/${encodeURIComponent(id)}`); }
export async function expenseStatuses() { return api('/expenses/statuses'); }
// רשימת סיווגים חשבונאיים (סיווגי הוצאה) — מנסה כמה נתיבים אפשריים ומחזיר את הראשון שמצליח
export async function listAccountingClassifications() {
  return cached('acctClassifications', async () => {
    const norm = (arr) => (Array.isArray(arr) ? arr : (arr?.items || arr?.data || []))
      .map(c => ({ ...(c && typeof c === 'object' ? c : {}), id: c.id ?? c.value ?? c.classificationId, name: c.name || c.description || c.label || c.title || c.he || c.text || c.categoryName || String(c.id ?? '') }))
      .filter(c => c.id != null);
    // ניסיון GET בכמה נתיבים
    for (const path of ['/accounting/classifications', '/expenses/classifications', '/accounting/classification']) {
      try { const r = await api(path); const items = norm(r); if (items.length) return items; } catch { }
    }
    // ניסיון POST search
    for (const path of ['/accounting/classifications/search', '/expenses/classifications/search']) {
      try { const r = await api(path, { method: 'POST', body: { page: 1, pageSize: 100 } }); const items = norm(r); if (items.length) return items; } catch { }
    }
    return [];
  });
}
// אבחון: מנסה כמה נתיבים ומחזיר דגימה גולמית כדי לזהות את הנתיב הנכון לשמות סיווגים
export async function debugClassifications() {
  const out = [];
  const gets = ['/accounting/classifications', '/expenses/classifications', '/accounting/classification', '/incomes/classifications', '/accounting/categories'];
  for (const p of gets) {
    try { const r = await api(p); const arr = Array.isArray(r) ? r : (r?.items || r?.data || []); out.push({ path: p, method: 'GET', ok: true, count: arr.length, sample: arr.slice(0, 2) }); }
    catch (e) { out.push({ path: p, method: 'GET', ok: false, error: String(e.message).slice(0, 120) }); }
  }
  const posts = ['/accounting/classifications/search', '/expenses/classifications/search'];
  for (const p of posts) {
    try { const r = await api(p, { method: 'POST', body: { page: 1, pageSize: 10 } }); const arr = Array.isArray(r) ? r : (r?.items || r?.data || []); out.push({ path: p, method: 'POST', ok: true, count: arr.length, sample: arr.slice(0, 2) }); }
    catch (e) { out.push({ path: p, method: 'POST', ok: false, error: String(e.message).slice(0, 120) }); }
  }
  return out;
}
// עדכון ספק קיים (למשל הגדרת סיווג חשבונאי ברירת מחדל)
export async function updateSupplier(id, data) {
  const body = {};
  if (data.accountingClassificationId) body.accountingClassificationId = data.accountingClassificationId;
  if (data.name) body.name = data.name;
  const r = await api(`/suppliers/${encodeURIComponent(id)}`, { method: 'PUT', body });
  clearDataCache();
  return r;
}
export async function createExpense(body) { const r = await api('/expenses', { method: 'POST', body }); clearDataCache(); return r; }
export async function deleteExpense(id) { const r = await api(`/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' }); clearDataCache(); return r; }

// ===== טיוטות הוצאה (מה שהעלינו וממתין ל-OCR/אישור) =====
const DRAFT_STATUS = { 10: 'ממתין לאישור', 50: 'נכשל', 200: 'נדחה' };
function mapDraft(d) {
  const e = d.expense || {};
  const sup = e.supplier || {};
  return {
    id: d.id,
    status: Number(d.status),
    statusText: DRAFT_STATUS[Number(d.status)] || `סטטוס ${d.status}`,
    url: d.url || null,                              // קישור לצפייה בקובץ שהועלה
    creationDate: d.creationDate || null,
    description: e.description || '',
    supplierId: sup.id || e.supplierId || null,
    supplierName: sup.name || '',
    supplierTaxId: sup.taxId || null,
    documentType: e.documentType || null,
    number: e.number || '',
    date: e.date ? String(e.date).slice(0, 10) : '',
    reportingDate: e.reportingDate ? String(e.reportingDate).slice(0, 10) : '',
    currency: e.currency || 'ILS',
    paymentType: e.paymentType || null,
    amount: e.amount ?? null,                         // כולל מע"מ
    amountExcludeVat: e.amountExcludeVat ?? null,
    vat: e.vat ?? null,
    accountingClassificationId: e.accountingClassification?.id || e.accountingClassificationId || null,
    raw: e,
  };
}
// רשימת טיוטות ההוצאה (מדפדף על כל העמודים)
export async function expenseDrafts() {
  return cached('expenseDrafts', async () => {
    const all = [];
    for (let page = 1; page <= 15; page++) {
      const res = await api('/expenses/drafts/search', { method: 'POST', body: { page, pageSize: 100 } });
      const items = res.items || [];
      all.push(...items);
      if (items.length < 100) break;
    }
    return all.map(mapDraft);
  });
}
// שליפת טיוטה בודדת (מתוך החיפוש) לפי מזהה
export async function getExpenseDraft(id) {
  const drafts = await expenseDrafts();
  return drafts.find(d => String(d.id) === String(id)) || null;
}
// ניסיון למחוק טיוטה (ייתכן שלא נתמך ב-API — המבצע מטפל בשגיאה)
export async function deleteExpenseDraft(id) {
  const r = await api(`/expenses/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  clearDataCache();
  return r;
}

// כל מסמכי ההוצאה של ספק מסוים (מקבלן)
export async function supplierExpenses(supplierId) {
  return cached(`supExp:${supplierId}`, async () => {
    const all = [];
    for (let page = 1; page <= 15; page++) {
      const res = await api('/expenses/search', { method: 'POST', body: { supplierId, page, pageSize: 100, sort: 'documentDate' } });
      const items = res.items || [];
      all.push(...items);
      if (items.length < 100) break;
    }
    const mapped = all.map(mapExpense);
    const filtered = mapped.filter(x => !x.supplierId || x.supplierId === supplierId);
    return filtered.length ? filtered : mapped;
  });
}

// זמני — לומד את שדות הסטטוס האמיתיים מהמסמכים כדי לקבוע פתוח/סגור
export async function debugDocStatus() {
  const to = new Date();
  const from = new Date(); from.setMonth(from.getMonth() - 18);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);
  const out = {};
  for (const type of [300, 305]) {
    const items = await documentsInRange(fromDate, toDate, [type]);
    const statusHist = {};
    for (const d of items) { const k = JSON.stringify(d.status); statusHist[k] = (statusHist[k] || 0) + 1; }
    out[type] = {
      total: items.length,
      statusHist,
      sampleKeys: items[0] ? Object.keys(items[0]) : [],
      samples: items.slice(0, 4).map(d => ({ number: d.number, status: d.status, paid: d.paid, paymentStatus: d.paymentStatus, amount: d.amount, amountDue: d.amountDue, cancelled: d.cancelled, open: d.open })),
    };
  }
  return out;
}

// שליפת כל העמודים מ-endpoint חיפוש (לקוחות/ספקים) — עד שמגיעים לסוף
async function searchAllPages(pathName, extraBody = {}) {
  const all = [];
  for (let page = 1; page <= 40; page++) { // עד ~8000 רשומות
    const res = await api(pathName, { method: 'POST', body: { page, pageSize: 200, ...extraBody } });
    const items = res.items || [];
    all.push(...items);
    if (items.length < 200) break;
  }
  return all;
}

// רשימת לקוחות (כל העמודים)
export async function listClients() {
  return cached('clients', async () => {
    const items = await searchAllPages('/clients/search');
    return items.map(c => ({ id: c.id, name: c.name, email: (Array.isArray(c.emails) && c.emails[0]) || c.email || null })).filter(c => c.name);
  });
}

// רשימת ספקים מחשבונית ירוקה (כל העמודים) — כולל פרטי קשר
export async function listSuppliers() {
  return cached('suppliers', async () => {
    const items = await searchAllPages('/suppliers/search');
    return items.map(s => ({ id: s.id, name: s.name, taxId: s.taxId || null, phone: s.phone || null, emails: s.emails || [], accountingClassificationId: s.accountingClassificationId || s.accountingClassification?.id || null })).filter(s => s.name);
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

export const greenInvoice = { haveCredentials, resetToken, verify, createInvoice, createDocument, previewDocument, createReceipt, createClient, createSupplier, searchDocuments, monthlyIncome, incomeForRange, receiptsForRange, openInvoicesCount, openDocuments, openQuotes, getDocument, closeDocument, openDocument, latestDocumentDate, quickSearchDocuments, listClients, listSuppliers, clientDocuments, supplierExpenses, getExpenseFileUploadUrl, uploadExpenseFile, getExpense, getSupplier, expenseStatuses, listAccountingClassifications, debugClassifications, updateSupplier, createExpense, deleteExpense, expenseDrafts, getExpenseDraft, deleteExpenseDraft, clearDataCache, DOC_TYPES };
export default greenInvoice;
