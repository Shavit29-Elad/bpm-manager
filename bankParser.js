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

// ----- "אקסל" של בנק לאומי (גם הוא טבלת HTML עם סיומת xls) -----
// המבנה שונה ממזרחי ולכן הפרסר שלו החזיר רשימה ריקה: אצל מזרחי התאריך בעמודה 0
// וזכות/חובה ב-3/4; אצל לאומי שתי עמודות מקדימות (סניף, חשבון), התאריך ב-2,
// וחובה/זכות ב-5/6. שם הצד השני יושב בעמודה 8 ("העברה אל: ..." / "העברה מאת: ...")
// והוא מה שמאפשר להתאים תנועה ללקוח או לספק.
const LEUMI_COLS = { branch: 0, account: 1, date: 2, desc: 3, ref: 4, debit: 5, credit: 6, balance: 7, memo: 8 };
function isLeumiHtml(text) {
  return /בנק\s*לאומי/.test(text) || /תנועות\s*עו["'׳]?ש/.test(text);
}
export function parseLeumiExcel(htmlText) {
  const rows = [...String(htmlText).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const txns = [];
  for (const r of rows) {
    const c = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => decodeCell(m[1]));
    if (c.length < 8) continue;
    if (!/^\d{2}\/\d{2}\/\d{2,4}$/.test(c[LEUMI_COLS.date] || '')) continue;   // שורת נתונים בלבד
    const debit = parseAmt(c[LEUMI_COLS.debit]);
    const credit = parseAmt(c[LEUMI_COLS.credit]);
    let amount = null, direction = null;
    if (credit) { amount = Math.abs(credit); direction = 'credit'; }
    else if (debit) { amount = -Math.abs(debit); direction = 'debit'; }
    else continue;                                                             // שורה בלי סכום
    const description = clean(c[LEUMI_COLS.desc] || '');
    const memo = clean(c[LEUMI_COLS.memo] || '');
    const fullText = `${description} | ${memo}`;
    const t = {
      date: normDate(c[LEUMI_COLS.date]), description, amount, absAmount: Math.abs(amount), direction,
      balance: parseAmt(c[LEUMI_COLS.balance]),
      reference: (c[LEUMI_COLS.ref] || '').replace(/\D/g, '') || null,
      memo,
    };
    t.invoiceNumber = extractInvoiceNumber(fullText);
    t.counterparty = leumiCounterparty(memo) || extractCounterparty(fullText);
    t.nameHint = nameHintFrom(t.counterparty, description);
    const fx = parseFxMemo(memo);
    if (fx) t.fx = fx;   // הכסף הגיע ממט"ח — הסכום בבנק לא יהיה זהה לחשבונית
    txns.push(t);
  }
  return txns;
}
// המרת מט"ח: לאומי כותב בשורה את כל הפרטים —
//   "המרה מ: 1980.00  דולר,שע"ח:3.1275  בניכוי עמלה בסך 18.32 ש"ח"
// מכאן אפשר לשחזר את הסכום לפני העמלה, ולהבין למה הסכום שנכנס לבנק אינו זהה
// לסכום שבחשבונית: החשבונית הופקה בשקלים לפי שער אחד, והכסף הגיע בשער אחר.
export function parseFxMemo(memo) {
  const s = String(memo || '');
  const m = s.match(/המרה\s*מ\s*:?\s*([\d,.]+)\s*([^\s,،]+)\s*,?\s*שע["'׳]?ח\s*:?\s*([\d.]+)/);
  if (!m) return null;
  const amount = parseFloat(String(m[1]).replace(/,/g, ''));
  const rate = parseFloat(m[3]);
  if (!(amount > 0) || !(rate > 0)) return null;
  const fm = s.match(/עמלה\s*בסך\s*([\d,.]+)/);
  const fee = fm ? parseFloat(String(fm[1]).replace(/,/g, '')) : 0;
  return { currency: String(m[2]).trim(), amount, rate, fee: fee || 0,
    gross: Math.round(amount * rate * 100) / 100 };
}

// לאומי כותב את הצד השני בעמודת הפרטים: "העברה אל: <שם> <מספר חשבון> תשלום",
// "העברה מאת: <שם> <מספר חשבון>". השם נקטע אצלם, ולכן נלקח כפי שהוא.
function leumiCounterparty(memo) {
  if (!memo) return null;
  const m = memo.match(/העברה\s*(?:אל|מאת|ל|מ)\s*:\s*(.+?)(?:\s+\d[\d-]{4,}|\s*\||$)/);
  if (!m) return null;
  const name = clean(m[1]).replace(/\s+(תשלום|העברה|זיכוי)\s*$/, '').trim();
  return name && name.length > 1 ? name : null;
}

// ============================================================================
// פורמט "רשת" (grid) — קובץ xlsx אמיתי (למשל בנק דיסקונט). הדפדפן קורא את ה-xlsx
// עם SheetJS וממיר למערך שורות (כל שורה = מערך תאים כמחרוזות), ושולח עם הסימן #BANKGRID#.
// כאן מזהים אוטומטית את שורת-הכותרת ואת מיקום העמודות, ותומכים בשני מבנים:
//   • עמודת סכום חתומה אחת ("₪ זכות/חובה": שלילי=חובה/יוצא, חיובי=זכות/נכנס) — דיסקונט.
//   • עמודות זכות + חובה נפרדות (חיוביות) — כמו מזרחי.
// ============================================================================
const GRID_SENTINEL = '#BANKGRID#';

function gridPayload(text) {
  const s = String(text || '');
  if (!s.startsWith(GRID_SENTINEL)) return null;
  try { const g = JSON.parse(s.slice(GRID_SENTINEL.length)); return Array.isArray(g) ? g : null; }
  catch { return null; }
}

// פירוק סכום חתום: תומך במינוס מוביל/נגרר, בסוגריים (שלילי), ובמפרידי-אלפים.
function parseSignedAmt(s) {
  let t = String(s == null ? '' : s).replace(BIDI, '').trim();
  if (!t) return null;
  const neg = /^-/.test(t) || /-\s*$/.test(t) || /^\(.*\)$/.test(t);
  t = t.replace(/[^\d.]/g, '');
  if (!t || t === '.') return null;
  const n = parseFloat(t);
  if (isNaN(n)) return null;
  return neg ? -Math.abs(n) : Math.abs(n);
}

const p2 = (x) => String(x).padStart(2, '0');
// זיהוי סדר התאריכים בקובץ (dd/mm מול mm/dd) לפי שורות חד-משמעיות (יום>12 או חודש>12).
// כך מטפלים גם בקבצים שבהם הדפדפן החזיר תאריך בפורמט אמריקאי, וגם בתאריכים דו-משמעיים כמו 03/01.
function detectDateOrder(rawDates) {
  let dmy = 0, mdy = 0;
  for (const s of rawDates) {
    const m = String(s || '').match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  return mdy > dmy ? 'mdy' : 'dmy';   // ברירת מחדל: dd/mm
}
function normDateOrdered(raw, order) {
  const m = String(raw || '').match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!m) return null;
  let dd, mm;
  if (order === 'mdy') { mm = +m[1]; dd = +m[2]; } else { dd = +m[1]; mm = +m[2]; }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${p2(dd)}/${p2(mm)}/${y}`;
}
const toSortISO = (ddmmyyyy) => { const m = String(ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

function headerText(cell) { return String(cell || '').replace(BIDI, '').replace(/\s+/g, ' ').trim(); }
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = (rows[i] || []).map(headerText);
    const hasDate = cells.some(c => /תאריך/.test(c));
    const hasDesc = cells.some(c => /תיאור|פעולה|פירוט/.test(c));
    const hasAmt = cells.some(c => /זכות|חובה|סכום/.test(c));
    if (hasDate && hasDesc && hasAmt) return i;
  }
  return -1;
}
function mapColumns(rows, hi) {
  const H = (rows[hi] || []).map(headerText);
  const find = (re) => H.findIndex(c => re.test(c));
  const dateCol = find(/תאריך/);                    // עמודת "תאריך" (לא "יום ערך")
  const descCol = find(/תיאור|פעולה|פירוט/);
  let signedCol = H.findIndex(c => /זכות/.test(c) && /חובה/.test(c));   // "זכות/חובה" באותו תא
  const creditCol = signedCol >= 0 ? -1 : find(/זכות/);
  const debitCol = signedCol >= 0 ? -1 : find(/חובה/);
  if (signedCol < 0 && creditCol < 0 && debitCol < 0) signedCol = find(/סכום/);
  const balCol = find(/יתרה/);
  const refCol = find(/אסמכת|אסמ'|reference/i);
  return { dateCol, descCol, signedCol, creditCol, debitCol, balCol, refCol };
}

// חילוץ שם הצד-הנגדי מתוך תיאור תנועה של דיסקונט (השם מוטמע בתיאור, אין שדה נפרד).
function trimName(s) {
  // הערה: \b של JS לא עובד על אותיות עבריות, לכן משתמשים ב-(?:\s.*)?$ במקום גבול-מילה.
  return clean(s)
    .replace(/\s+[בל]סניף(?:\s.*)?$/, '')     // "... בסניף 10-905" / "... לסניף 11-103"
    .replace(/\s*-\s*$/, '')
    .replace(/\s+\d{1,3}-\d{2,4}\s*$/, '')
    .trim() || null;
}
function discountCounterparty(desc) {
  const d = clean(desc);
  let m = d.match(/^העברה\s+מ(.+)$/); if (m) return trimName(m[1]);            // העברה נכנסת
  m = d.match(/^הו["'׳]?ק\s+ל(.+)$/); if (m) return trimName(m[1]);             // הוראת קבע יוצאת
  m = d.match(/^הע(?:ברה)?\.?\s+ל(.+)$/); if (m) return trimName(m[1]);         // העברה יוצאת
  m = d.match(/^(.+?)\s+(?:חיוב|זיכוי)$/); if (m) return trimName(m[1]);        // "<שם> חיוב/זיכוי"
  return null;
}

export function parseGridStatement(rows) {
  const hi = findHeaderRow(rows);
  if (hi < 0) return [];
  const col = mapColumns(rows, hi);
  if (col.dateCol < 0 || col.descCol < 0) return [];
  const order = detectDateOrder(rows.slice(hi + 1).map(r => (r || [])[col.dateCol]));
  const txns = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const cells = (rows[i] || []).map(c => String(c == null ? '' : c));
    const date = normDateOrdered(cells[col.dateCol], order);
    if (!date) continue;                                   // רק שורות נתונים
    let amount = null;
    if (col.signedCol >= 0) amount = parseSignedAmt(cells[col.signedCol]);
    else {
      const cr = parseSignedAmt(cells[col.creditCol]);
      const db = parseSignedAmt(cells[col.debitCol]);
      if (cr) amount = Math.abs(cr); else if (db) amount = -Math.abs(db);
    }
    if (amount == null || amount === 0) continue;          // מדלגים על שורות ריקות/סיכום
    const description = clean(cells[col.descCol] || '');
    const balance = col.balCol >= 0 ? parseSignedAmt(cells[col.balCol]) : null;
    let reference = col.refCol >= 0 ? String(cells[col.refCol] || '').replace(BIDI, '').replace(/\s+/g, '').trim() : '';
    reference = reference || null;
    const t = {
      date, description, amount, absAmount: Math.abs(amount),
      direction: amount < 0 ? 'debit' : 'credit',          // זיכוי=נכנס, חיוב=יוצא
      balance, reference, memo: '',
    };
    t.invoiceNumber = extractInvoiceNumber(description);
    t.counterparty = discountCounterparty(description);
    t.nameHint = t.counterparty || nameHintFrom(null, description);
    txns.push(t);
  }
  return txns;
}

// יתרת עו"ש מתוך קובץ הרשת: יתרת התנועה בעלת התאריך האחרון (בדיסקונט התנועות ממוינות מהחדש לישן).
function gridAccountBalance(rows) {
  const hi = findHeaderRow(rows);
  if (hi < 0) return null;
  const col = mapColumns(rows, hi);
  if (col.dateCol < 0 || col.balCol < 0) return null;
  const order = detectDateOrder(rows.slice(hi + 1).map(r => (r || [])[col.dateCol]));
  let best = null;
  for (let i = hi + 1; i < rows.length; i++) {
    const cells = (rows[i] || []).map(c => String(c == null ? '' : c));
    const date = normDateOrdered(cells[col.dateCol], order);
    if (!date) continue;
    const bal = parseSignedAmt(cells[col.balCol]);
    if (bal == null) continue;
    const iso = toSortISO(date);
    if (!best || iso > best.iso) best = { iso, balance: bal, date };
  }
  return best ? { balance: best.balance, date: best.date, time: null } : null;
}

// חילוץ יתרת החשבון הרשמית מכותרת הקובץ: "יתרה בחשבון: 391,252.69 לתאריך - 16/07/26 14:38"
// זו היתרה הקובעת (עו"ש) — מדויקת יותר מהיתרה שבשורת התנועה האחרונה (שלרוב ריקה).
export function extractAccountBalance(text) {
  const grid = gridPayload(text);
  if (grid) return gridAccountBalance(grid);
  const flat = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(BIDI, '').replace(/\s+/g, ' ');
  // תומך בגרסאות שונות של הכותרת + מספר עם/בלי עשרוני ומינוס מוביל/נגרר
  let m = flat.match(/(?:יתרה\s*(?:ב|ה)?חשבון|יתרה\s*משוערכת|היתרה\s*בחשבון)\s*:?\s*(-?[\d,]+(?:\.\d{1,2})?-?)/);
  // לאומי כותב "יתרה: 20,980.42 ₪" בלבד. דורשים את סימן השקל שאחרי המספר, אחרת
  // המילה "יתרה" בתוך שורת תנועה הייתה נתפסת כיתרת החשבון.
  if (!m) m = flat.match(/יתרה\s*:?\s*(-?[\d,]+(?:\.\d{1,2})?-?)\s*(?:₪|ש["'׳]?ח)/);
  if (!m) return null;
  let raw = m[1].trim();
  const neg = raw.startsWith('-') || raw.endsWith('-');
  const balance = (neg ? -1 : 1) * parseFloat(raw.replace(/[^\d.]/g, ''));
  if (isNaN(balance)) return null;
  // תאריך היתרה: אצל לאומי הוא מופיע *לפני* שורת היתרה ומופרד בנקודות
  const dm = flat.slice(m.index).match(/לתאריך\s*-?\s*(\d{2}\/\d{2}\/\d{2,4})(?:\s+(\d{2}:\d{2}))?/)
    || flat.match(/נכון\s*לתאריך\s*:?\s*(\d{2}[./]\d{2}[./]\d{2,4})/);
  const date = dm ? normDate(String(dm[1]).replace(/\./g, '/')) : null;
  const time = dm && dm[2] ? dm[2] : null;
  return { balance, date, time };
}

// זיהוי אוטומטי: רשת xlsx (דיסקונט) → parseGridStatement · טבלת HTML (מזרחי) → parseMizrahiExcel · אחרת הדבקה
export function parseBank(text) {
  const grid = gridPayload(text);
  if (grid) return parseGridStatement(grid);
  if (/<tr[\s>]/i.test(text) || /<table/i.test(text)) {
    // שני הבנקים מייצאים HTML עם סיומת xls, במבנה עמודות שונה. הזיהוי לפי סימן
    // מובהק, ואם הוא חסר — לפי מה שבאמת הצליח להיקרא, כדי שקובץ לא ייקלט ריק.
    if (isLeumiHtml(text)) { const l = parseLeumiExcel(text); if (l.length) return l; }
    const m = parseMizrahiExcel(text);
    if (m.length) return m;
    return parseLeumiExcel(text);
  }
  return parseMizrahi(text);
}

export default { parseMizrahi, parseMizrahiExcel, parseLeumiExcel, parseFxMemo, parseGridStatement, parseBank, extractAccountBalance };
