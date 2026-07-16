// bankParser.js — מנתח תנועות בנק שהודבקו מאתר בנק מזרחי (התצוגה המפורטת).
// מחזיר לכל תנועה: תאריך, תיאור, סכום, כיוון (זיכוי/חיוב), אסמכתא, מהות (memo),
// ומפיק מתוך המהות: מספר חשבונית ושם הצד השני — לצורך התאמה לחשבוניות.

// תווי כיווניות (RTL/LTR control) שצריך לנקות
const BIDI = /[‎‏‪‫‬‭‮⁦⁧⁨⁩]/g;
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{2,4})\b/;
const AMOUNT_LINE = /^-?[\d,]+\.\d{2}$/;      // שורה שהיא סכום/יתרה בלבד
const INT_LINE = /^\d{1,12}$/;                // שורה שהיא אסמכתא (מספר שלם)

function clean(s) {
  return String(s || '').replace(BIDI, '').replace(/ /g, ' ').replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanKeepTabs(s) {
  return String(s || '').replace(BIDI, '').replace(/ /g, ' ').trim();
}

// חילוץ מספר חשבונית מטקסט ("ח.מס 60053", "חש 50419", "ח.מ.ס 60145")
function extractInvoiceNumber(text) {
  const norm = text.replace(/['׳"]/g, '');
  let m = norm.match(/ח\.?\s*מ\.?\s*ס?\.?\s*(\d{3,7})/);   // ח.מס / ח.מ.ס / ח מ ס
  if (m) return m[1];
  m = norm.match(/(?:^|[\s|:])חש\s*(\d{3,7})/);              // חש 50419 (לא "חשבון")
  if (m) return m[1];
  m = norm.match(/חשבונית\s*מס\s*(\d{3,7})/);
  if (m) return m[1];
  return null;
}

// חילוץ שם הצד השני (מעביר/מוטב/לקוח/בעל חשבון)
function extractCounterparty(text) {
  let m = text.match(/שם מעביר\s*:?\s*([^|]+?)(?:\s*\||$)/);
  if (m) return clean(m[1]);
  m = text.match(/שם לקוח\s*:?\s*([^|]+?)(?:\s*\||$)/);
  if (m) return clean(m[1]);
  m = text.match(/שם מוטב\s*:?\s*([^|]+?)(?:\s*\||$)/);
  if (m) return clean(m[1]);
  m = text.match(/חשבון\s*:?\s*\d+\s*-\s*([^|]+?)(?:\s*\||$)/);
  if (m) return clean(m[1]);
  return null;
}

// שם לצורך התאמה: מהמהות אם קיים, אחרת מהתיאור (אם אינו פעולה גנרית)
const GENERIC_DESC = /^(העברה|זיכוי|פרעון|פירעון|ביצוע|הוראת קבע|ויזה|מ\s*\.?\s*ע\s*\.?\s*מ|מס הכנסה|עמלת?|מימון|הרשאה|בנק |פמה|אחים יעקב|העברת יומן|א\.ק|הפקדת שיק|הפקדה|ריבית|משיכת)/;
function nameHintFrom(counterparty, description) {
  if (counterparty) return counterparty;
  const d = description.replace(/\s*\([יפסמ]\)\s*$/, '').replace(/\s*-\s*\d+\s*$/, '').trim();
  if (d && !GENERIC_DESC.test(d)) return d;
  return null;
}

export function parseMizrahi(text) {
  const lines = String(text).split(/\r?\n/).map(cleanKeepTabs)
    .filter(l => l && l !== 'תנועות אחרונות' && !/^\s*$/.test(l));
  const txns = [];
  let cur = null;
  const finalizeAndPush = () => { if (cur) { finalize(cur); txns.push(cur); } };

  for (const raw of lines) {
    const line = raw;
    const dm = line.match(DATE_RE);
    if (dm) {
      finalizeAndPush();
      const desc = clean(line.replace(DATE_RE, ''));
      const yr = dm[3].length === 2 ? '20' + dm[3] : dm[3];
      cur = { date: `${dm[1]}/${dm[2]}/${yr}`, description: desc, _lines: [] };
    } else if (cur) {
      cur._lines.push(clean(line));
    }
  }
  finalizeAndPush();
  return txns;
}

function finalize(t) {
  const L = t._lines;
  // סכום ויתרה: שורות עם עשרוני. הראשונה = סכום, אם צמודה אחריה עוד אחת = יתרה
  const decIdx = [];
  L.forEach((l, i) => { if (AMOUNT_LINE.test(l)) decIdx.push(i); });
  let amount = null, balance = null, amtIdx = -1;
  if (decIdx.length) {
    amtIdx = decIdx[0];
    amount = parseFloat(L[amtIdx].replace(/,/g, ''));
    if (decIdx.length >= 2 && decIdx[1] === amtIdx + 1) balance = parseFloat(L[decIdx[1]].replace(/,/g, ''));
  }
  // אסמכתא: המספר השלם הראשון אחרי הסכום
  let reference = null;
  for (let i = amtIdx + 1; i < L.length; i++) { if (INT_LINE.test(L[i])) { reference = L[i]; break; } }
  // מהות: שורות שאינן סכום/מספר בלבד
  const memoLines = L.filter(l => !AMOUNT_LINE.test(l) && !INT_LINE.test(l));
  const memo = memoLines.join(' | ');
  const fullText = `${t.description} | ${memo}`;

  t.amount = amount;
  t.direction = amount != null && amount < 0 ? 'debit' : 'credit'; // זיכוי=נכנס, חיוב=יוצא
  t.absAmount = amount != null ? Math.abs(amount) : null;
  t.balance = balance;
  t.reference = reference;
  t.memo = memo;
  t.invoiceNumber = extractInvoiceNumber(fullText);
  t.counterparty = extractCounterparty(fullText);
  t.nameHint = nameHintFrom(t.counterparty, t.description);
  delete t._lines;
}

// ----- קובץ "אקסל" של מזרחי (בפועל טבלת HTML) -----
function decodeCell(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(BIDI, '').replace(/\s+/g, ' ').trim();
}
function parseAmt(s) {
  const t = String(s == null ? '' : s).replace(/[^\d.\-]/g, '');
  if (!t || t === '-' || t === '.') return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}
function normDate(d) { const m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{2,4})/); if (!m) return d; const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${m[1]}/${m[2]}/${y}`; }

export function parseMizrahiExcel(htmlText) {
  const rows = [...String(htmlText).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const txns = [];
  for (const r of rows) {
    const c = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => decodeCell(m[1]));
    if (c.length < 6) continue;
    if (!/^\d{2}\/\d{2}\/\d{2,4}$/.test(c[0])) continue;    // שורת נתונים בלבד
    const credit = parseAmt(c[3]);   // זכות
    const debit = parseAmt(c[4]);    // חובה
    let amount = null, direction = null;
    if (credit) { amount = Math.abs(credit); direction = 'credit'; }
    else if (debit) { amount = -Math.abs(debit); direction = 'debit'; }
    else continue;
    const description = clean(c[2] || '');
    const t = {
      date: normDate(c[0]), description, amount, absAmount: Math.abs(amount), direction,
      balance: parseAmt(c[5]), reference: (c[6] || '').replace(/\D/g, '') || null, memo: '',
    };
    t.invoiceNumber = extractInvoiceNumber(description);
    t.counterparty = null;
    t.nameHint = nameHintFrom(null, description);
    txns.push(t);
  }
  return txns;
}

// זיהוי אוטומטי: אם זה טבלת HTML (קובץ אקסל של מזרחי) — פרסר אקסל, אחרת פרסר הדבקה
export function parseBank(text) {
  if (/<tr[\s>]/i.test(text) || /<table/i.test(text)) return parseMizrahiExcel(text);
  return parseMizrahi(text);
}

export default { parseMizrahi, parseMizrahiExcel, parseBank };
