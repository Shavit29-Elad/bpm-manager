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
function resetToken() { cachedToken = null; tokenExpiry = 0; }

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

// סוגי מסמכים בחשבונית ירוקה (type): 305=חשבונית מס, 320=חשבונית מס/קבלה, 400=קבלה, 300=הצעת מחיר...
export const DOC_TYPES = { INVOICE: 305, INVOICE_RECEIPT: 320, RECEIPT: 400, PRICE_QUOTE: 300 };

// הפקת חשבונית. items = [{ description, quantity, price }], client = { name, taxId?, emails? }
export async function createInvoice({ client, items, type = DOC_TYPES.INVOICE, remarks, dueDate }) {
  const body = {
    type,
    client: { name: client.name, taxId: client.taxId, add: true, emails: client.emails || [] },
    income: items.map(it => ({
      description: it.description,
      quantity: it.quantity ?? 1,
      price: it.price,
      vatType: 0, // 0=חייב מעמ
    })),
    remarks,
    dueDate,
    lang: 'he',
    currency: 'ILS',
  };
  return api('/documents', { method: 'POST', body });
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

// מיפוי מסמך לתצוגה
function mapDoc(d) {
  return {
    id: d.id, number: d.number, type: d.type, date: d.documentDate,
    amount: num(d.amount ?? d.total ?? d.sum),
    clientName: d.client?.name || d.clientName || d.client_name || '—',
    url: (d.url && (d.url.he || d.url.origin || d.url.pdf)) || (typeof d.url === 'string' ? d.url : null),
    amountDue: d.amountDue,
  };
}

// הכנסה חודשית מחשבוניות מס (305) + מס/קבלה (320), וצפי מע"מ + פירוט המסמכים
export async function monthlyIncome(month) {
  const fromDate = `${month}-01`, toDate = lastDay(month);
  const res = await api('/documents/search', {
    method: 'POST',
    body: { fromDate, toDate, page: 1, pageSize: 100, type: [305, 320], sort: 'documentDate' },
  });
  const items = res.items || [];
  let income = 0, vat = 0;
  for (const d of items) {
    const amt = num(d.amount ?? d.total ?? d.sum);
    income += amt;
    vat += (d.vat != null ? num(d.vat) : amt - amt / 1.18); // מע"מ 18% אם לא סופק
  }
  return { income, vat, count: items.length, docs: items.map(mapDoc) };
}

// כל המסמכים של לקוח מסוים (כל הסוגים, כל התאריכים)
export async function clientDocuments(clientId) {
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
}

// כמות חשבוניות מס פתוחות (לא שולמו במלואן)
export async function openInvoicesCount() {
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
}

// רשימת לקוחות (ממורנינג / חשבונית ירוקה)
export async function listClients() {
  const res = await api('/clients/search', { method: 'POST', body: { page: 1, pageSize: 200 } });
  return (res.items || []).map(c => ({ id: c.id, name: c.name })).filter(c => c.name);
}

export const greenInvoice = { haveCredentials, resetToken, verify, createInvoice, createReceipt, searchDocuments, monthlyIncome, openInvoicesCount, listClients, clientDocuments, DOC_TYPES };
export default greenInvoice;
