// lib/paperless.js
// מחבר ל-API של Paperless (paperless.tax) — משמש את חברת אופק (במקום חשבונית ירוקה של BPM).
// תיעוד (Swagger): https://pl-apis-prod-il.azurewebsites.net/swagger/ui
//
// הזדהות: מפתח חיבור (טוקן) שנשלח ב-header בשם X-API-KEY.
// הטוקן נטען ממשתנה סביבה — לא נשמר בקוד:  PAPERLESS_TOKEN
//
// ה-API כולל שתי פעולות בלבד:
//   PUT /api/documents/search  — חיפוש מסמכים (הכנסה/הוצאה) לפי תאריך/סכום/לקוח/סטטוס
//   PUT /api/invoices/create   — הפקת מסמך (חשבון עסקה / חשבונית מס / מס-קבלה / קבלה / זיכוי / הצעת מחיר...)

// כתובת ה-API האמיתית (אותה לכל משתמשי paperless). ניתן לעקוף עם PAPERLESS_API_BASE אם אי פעם תשתנה.
const BASE = process.env.PAPERLESS_API_BASE || 'https://pl-apis-prod-il.azurewebsites.net';

function token() { return process.env.PAPERLESS_TOKEN || ''; }
function haveCredentials() { return Boolean(token()); }

// סוגי מסמך להפקה (iType ב-invoices/create)
const DOC_TYPE = { BILL: 0, INVOICE: 1, INVOICE_RECEIPT: 2, RECEIPT: 3, REFUND: 4, ORDER: 5, PROPOSAL: 6, SELF: 7, TRUMA: 8, DEPOSIT: 9, SHIPPING: 10 };
// שמות סוגי מסמך בעברית (לתצוגה)
const DOC_TYPE_HE = { 0: 'חשבון עסקה', 1: 'חשבונית מס', 2: 'חשבונית מס-קבלה', 3: 'קבלה', 4: 'זיכוי', 5: 'הזמנה', 6: 'הצעת מחיר', 7: 'חשבונית עצמית', 8: 'תרומה', 9: 'פיקדון', 10: 'תעודת משלוח' };
// סוגי תשלום (iType ב-payments)
const PAY_TYPE = { CHECK: 1, TRANSFER: 2, CREDIT: 3, CASH: 4, APP: 5, WITHHOLDING: 6, OTHER: 8, MASAV: 9 };
// קודי שגיאה מה-API
const ERR = { 1: 'מפתח לא תקין', 2: 'סוג מפתח לא תקין', 3: 'עוסק לא קיים', 4: 'מפתח לא קיים', 5: 'בקשות רבות מדי', 6: 'לקוח לא קיים', 7: 'הלקוח אינו יכול להיות השולח', 8: 'מזהה מוצר לא קיים', 9: 'בקבלה יש לציין תשלומים', 10: 'סכום תשלום לא תקין' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// קריאה גנרית ל-API (כל הפעולות הן PUT עם גוף JSON). ניסיון חוזר אוטומטי על שגיאות שרת זמניות (503/502/504/429).
async function api(pathName, body, attempt = 0) {
  if (!haveCredentials()) throw new Error('פייפרלס לא מחובר (חסר PAPERLESS_TOKEN)');
  const res = await fetch(`${BASE}${pathName}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': token() },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const code = data && typeof data === 'object' ? data.iCode : null;
    // שגיאה זמנית — ננסה שוב עד 4 פעמים עם המתנה גוברת:
    //   502/503/504/429 = Azure מתעורר/עומס.  iCode 5 = "בקשות רבות מדי" (מגיע כ-400) — נחכה יותר.
    const throttled = code === 5;
    if (([502, 503, 504, 429].includes(res.status) || throttled) && attempt < 4) {
      await sleep((throttled ? 1600 : 800) * (attempt + 1));
      return api(pathName, body, attempt + 1);
    }
    // גוף שגיאה: { iCode, message }
    const msg = (data && data.message) || ERR[code] || `שגיאת פייפרלס ${res.status}`;
    const e = new Error(msg); e.code = code; e.status = res.status; throw e;
  }
  return data;
}

// המרת תאריך ל-ISO שה-API מצפה לו (date-time)
function toApiDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00:00';
  return s;
}

// ---- חיפוש מסמכים ----
// opts: { docType(0=הכל,1=הוצאה,2=הכנסה), from, to, amountMin, amountMax, clientId, status(0=הכל,1=פתוחות,2=סגורות), docNumber, invoiceTypes[] }
async function searchDocuments(opts = {}) {
  const body = {
    iDocType: opts.docType != null ? opts.docType : 0,
    sDocNumber: opts.docNumber || null,
    dtStart: toApiDate(opts.from),
    dtEnd: toApiDate(opts.to),
    iAmountStart: opts.amountMin != null ? opts.amountMin : null,
    iAmountEnd: opts.amountMax != null ? opts.amountMax : null,
    aInvoiceTypes: opts.invoiceTypes || null,
    sClientID: opts.clientId || null,
    iStatus: opts.status != null ? opts.status : 0,
  };
  const rows = await api('/api/documents/search', body);
  const arr = Array.isArray(rows) ? rows : [];
  return opts.raw ? arr : arr.map(mapDoc);   // raw=true → שורות גולמיות (לאבחון בלבד)
}

// גזירת תאריך מסמך — ה-API אינו מחזיר שדה תאריך.
//   1) ממספר ההקצאה (sTaxConfirm) 8 הספרות הראשונות = YYYYMMDD (תאריך מדויק).
//   2) אחרת מנתיב ה-URL "/documents/YYMM/" = שנה-חודש (מדויק לחודש).
function deriveDate(d) {
  const tc = String(d.sTaxConfirm || '');
  if (/^\d{8}/.test(tc)) {
    const y = tc.slice(0, 4), m = tc.slice(4, 6), day = tc.slice(6, 8);
    if (+m >= 1 && +m <= 12 && +day >= 1 && +day <= 31) return `${y}-${m}-${day}`;
  }
  const seg = String(d.sURL || '').match(/\/documents\/(\d{2})(\d{2})\//);
  if (seg && +seg[2] >= 1 && +seg[2] <= 12) return `20${seg[1]}-${seg[2]}-01`;
  return null;
}

// נרמול מסמך מתוצאת החיפוש.
// שים לב לחוסר עקביות ב-API (אומת מול מסמכים אמיתיים):
//   iAmount100 — כבר בשקלים (למשל 4720 = ₪4,720, אומת מול חשבונית #30231).
//   iVAT100    — באגורות! חייב חלוקה ב-100 (למשל 144000 = ₪1,440 מע"מ על חשבונית ₪9,440).
function mapDoc(d) {
  const amount = Number(d.iAmount100) || 0;
  const vat = +(((Number(d.iVAT100) || 0) / 100).toFixed(2));
  return {
    id: d.sDocumentID,
    number: d.sDocNumber,
    url: d.sURL || null,
    date: deriveDate(d),                 // תאריך גזור (מספר הקצאה / נתיב URL) — ה-API לא מחזיר תאריך
    amount,                              // כולל מע"מ
    vat,
    amountExVat: +(amount - vat).toFixed(2),  // ללא מע"מ
    taxConfirm: d.sTaxConfirm || null,   // מספר הקצאה
    clientId: d.sClientID || null,
    clientName: d.sClientName || '',
    closed: !!d.bClosed,
  };
}

// חשבוניות הכנסה פתוחות (טרם שולמו) — חשבונית עסקה (0) + חשבונית מס (1) בלבד.
// משתמשים בסינון הסטטוס של ה-API עצמו (iStatus=1) ולא בשדה bClosed, כדי להתאים למונה של פייפרלס.
// טווח רחב (ברירת מחדל 3 שנים אחורה) כי מסמכים פתוחים עשויים להיות ישנים; חיפוש ללא טווח מחזיר 500.
async function openInvoices(from, to) {
  const t = to || new Date().toISOString().slice(0, 10);
  const f = from || ((Number(t.slice(0, 4)) - 3) + t.slice(4));
  return searchDocuments({ docType: 2, from: f, to: t, status: 1, invoiceTypes: [0, 1] });
}
// הכנסות בטווח תאריכים
async function incomeForRange(from, to) { return searchDocuments({ docType: 2, from, to }); }
// הוצאות בטווח תאריכים
async function expensesForRange(from, to) { return searchDocuments({ docType: 1, from, to }); }

// ---- הפקת מסמך ----
// opts: { type(iType), preview(bool), remark, extraTitle, basedOnDocId, client:{paperlessId,number,name,email,mobile,address,externalId}, items:[{productId,name,count,price}], payments:[{type,amount,due,app,creditType,cardSuffix,bank,branch,account,check,payments}] }
async function createDocument(opts = {}) {
  const body = {
    type: {
      iType: opts.type != null ? opts.type : DOC_TYPE.INVOICE_RECEIPT,
      bIsPreview: !!opts.preview,
      sRemark: opts.remark || null,
      sExtraTitle: opts.extraTitle || null,
      sBasedOnDocID: opts.basedOnDocId || null,
    },
    client: opts.client ? {
      sPaperlessID: opts.client.paperlessId || null,
      sNumber: opts.client.number || null,
      sName: opts.client.name || null,
      sEmail: opts.client.email || null,
      sMobile: opts.client.mobile || null,
      sAddress: opts.client.address || null,
      sExternalID: opts.client.externalId || null,
    } : null,
    items: (opts.items || []).map(it => ({
      sProductID: it.productId || null,
      sProductName: it.name || null,
      dCount: Number(it.count) || 1,
      dPrice: Number(it.price) || 0,   // מחיר יחידה לפני מע"מ
    })),
    payments: (opts.payments || []).map(p => ({
      iType: p.type != null ? p.type : PAY_TYPE.TRANSFER,
      dAmount: Number(p.amount) || 0,  // כולל מע"מ
      iApp: p.app != null ? p.app : 0,
      dtDue: toApiDate(p.due) || '0001-01-01T00:00:00',
      iPayments: p.payments != null ? p.payments : 0,
      sBank: p.bank || null,
      sBranch: p.branch || null,
      sAccount: p.account || null,
      sCheck: p.check || null,
      iCreditType: p.creditType != null ? p.creditType : 1,
      sCardSuffix: p.cardSuffix || null,
    })),
  };
  const out = await api('/api/invoices/create', body);
  const arr = Array.isArray(out) ? out : [out];
  return arr.map(o => ({
    url: o.sURL || null,
    downloadUrl: o.sDownloadPageURL || null,
    number: o.sInvoiceNumber || null,
    taxConfirm: o.sTaxConfirm || null,   // מספר הקצאה
    id: o.sDocumentID || null,
    clientId: o.sClientID || null,
  }));
}

// בדיקת חיבור אמיתית: חיפוש קצר (טווח קטן) — אם המפתח תקין מקבלים 200, אחרת 400 עם קוד שגיאה.
async function verify() {
  if (!haveCredentials()) return { ok: false, error: 'לא הוזן טוקן פייפרלס' };
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    await searchDocuments({ docType: 0, from, to: now });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default {
  haveCredentials, verify,
  searchDocuments, openInvoices, incomeForRange, expensesForRange,
  createDocument,
  DOC_TYPE, DOC_TYPE_HE, PAY_TYPE, BASE,
};
