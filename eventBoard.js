// eventBoard.js
// לוח האירועים של משה כורסיה. שונה משאר החברות: לכל אירוע רשימת תפקידים קבועה
// (נגנים, טכנאים, לוגיסטיקה), לכל תפקיד ספק ומחיר, והמסך מסכם הכנסות מול הוצאות
// לפי חודש ולפי אירוע.
//
// שורות ההוצאה נשמרות ב-contractorDetails של האירוע — אותו מבנה שבו משתמשים
// "ספקים לתשלום" והתאמות הבנק. כך שורה שנוספת כאן נכנסת למעקב התשלומים הקיים
// בלי כפילות נתונים ובלי מסך נפרד שצריך לסנכרן.

export const VAT_RATE = 0.18;

// 14 התפקידים הקבועים. הסדר הוא סדר התצוגה.
export const BOARD_ROLES = [
  'מנהלת הצגה', 'קלידן', 'מתופף', 'גיטריסט', 'בסיסט', 'סאונדמן', 'בקליינר',
  'תאורן', 'פרומטר', 'הגברה', 'הסעה', 'חדר חזרות', 'קופה קטנה', 'הוצאות נוספות',
];
const ROLE_SET = new Set(BOARD_ROLES);
export const isFixedRole = (role) => ROLE_SET.has(String(role || '').trim());

// מסמכי הספק המותרים לשורה, לפי סוג העוסק. עוסק פטור אינו מוציא חשבונית מס,
// ולכן המסמך היחיד שלו הוא קבלה. עוסק מורשה: חשבון עסקה, ואחריו חשבונית מס
// או חשבונית מס-קבלה.
export const SUP_DOC_TYPES_LICENSED = [300, 305, 320];
export const SUP_DOC_TYPES_EXEMPT = [400];
export const SUP_DOC_NAMES = { 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 400: 'קבלה' };
export const supDocTypesFor = (row) => (row && row.vatExempt) ? SUP_DOC_TYPES_EXEMPT : SUP_DOC_TYPES_LICENSED;

const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// סכומי שורה אחת. המספר שמוזן בשדה המחיר מתפרש לפי שני הסימונים שלצדו:
//   ברירת מחדל  — המחיר ללא מע"מ, והכולל מחושב ממנו.
//   "כולל מע״מ" — המחיר הוא הסכום הסופי, והמע"מ מחולץ ממנו אחורה.
//   "פטור"      — אין מע"מ כלל, והמחיר הוא גם הסופי. גובר על "כולל מע״מ",
//                 כי לעוסק פטור אין מע"מ לחלץ.
// (השדה נשמר בשם priceExVat מטעמי תאימות; הוא תמיד המספר שהוזן בפועל.)
export function rowTotals(row) {
  const entered = num(row && row.priceExVat);
  if (!entered) return { ex: 0, inc: 0, vat: 0 };
  if (row && row.vatExempt) return { ex: r2(entered), inc: r2(entered), vat: 0 };
  if (row && row.priceIncVat) {
    const ex = r2(entered / (1 + VAT_RATE));
    return { ex, inc: r2(entered), vat: r2(entered - ex) };
  }
  const inc = r2(entered * (1 + VAT_RATE));
  return { ex: r2(entered), inc, vat: r2(inc - entered) };
}

// שורות הלוח של אירוע: התפקידים הקבועים תמיד, ואחריהם שורות חופשיות שנוספו.
export function boardRows(ev) {
  const details = Array.isArray(ev && ev.contractorDetails) ? ev.contractorDetails : [];
  const byRole = new Map();
  const extras = [];
  details.forEach((d, index) => {
    const role = String((d && d.role) || '').trim();
    const row = { ...d, index, role, docs: Array.isArray(d && d.docs) ? d.docs : [], ...rowTotals(d) };
    if (isFixedRole(role) && !byRole.has(role)) byRole.set(role, row);
    else if (role) extras.push(row);
  });
  const fixed = BOARD_ROLES.map(role => byRole.get(role)
    || { role, index: -1, name: '', priceExVat: null, vatExempt: false, priceIncVat: false, note: '', docs: [], ex: 0, inc: 0, vat: 0 });
  return { fixed, extras, all: [...fixed, ...extras] };
}

// סיכום אירוע: הכנסה (המחיר ללקוח, ללא מע"מ), הוצאות (סכום השורות) ורווח.
// ההוצאה נמדדת כולל מע"מ — זה הכסף שיוצא בפועל — ולצדה גם ללא מע"מ, למי
// שמסתכל על הרווח לפני החזר התשומות.
export function eventTotals(ev) {
  const rows = boardRows(ev).all.filter(r => r.ex > 0);
  const expenseEx = r2(rows.reduce((s, r) => s + r.ex, 0));
  const expenseInc = r2(rows.reduce((s, r) => s + r.inc, 0));
  const incomeEx = r2(num(ev && ev.price));
  return {
    incomeEx, incomeInc: r2(incomeEx * (1 + VAT_RATE)),
    expenseEx, expenseInc,
    profitEx: r2(incomeEx - expenseEx),
    filledRows: rows.length,
    unpaidRows: rows.filter(r => !r.paid).length,
  };
}

// קיבוץ לפי חודש, מהחדש לישן. כל חודש נושא את סיכומיו ואת האירועים שבו.
export function boardByMonth(events, year) {
  const y = String(year || '').trim();
  const byMonth = new Map();
  for (const ev of (events || [])) {
    const iso = String(ev.date || ev.dateRaw || '').slice(0, 10);
    if (!iso) continue;
    if (y && iso.slice(0, 4) !== y) continue;
    const key = iso.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { month: key, events: [], incomeEx: 0, expenseEx: 0, expenseInc: 0, profitEx: 0 });
    const g = byMonth.get(key);
    const t = eventTotals(ev);
    g.events.push({ id: ev.id, date: iso, artist: ev.artist || '', location: ev.location || '',
      clientId: ev.clientId || null, clientName: ev.clientName || '',
      price: ev.price ?? null, notes: ev.boardNotes || '',
      linkedDocs: (ev.linkedDocs || []).map(d => ({ id: d.id, number: d.number ?? null, type: Number(d.type),
        uploaded: !!d.uploaded, converted: !!d.converted, credit: !!(d.credit || Number(d.type) === 330) })),
      rows: boardRows(ev).all, totals: t });
    g.incomeEx = r2(g.incomeEx + t.incomeEx);
    g.expenseEx = r2(g.expenseEx + t.expenseEx);
    g.expenseInc = r2(g.expenseInc + t.expenseInc);
    g.profitEx = r2(g.incomeEx - g.expenseEx);
  }
  const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  for (const m of months) m.events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totals = months.reduce((acc, m) => ({
    incomeEx: r2(acc.incomeEx + m.incomeEx), expenseEx: r2(acc.expenseEx + m.expenseEx),
    expenseInc: r2(acc.expenseInc + m.expenseInc), profitEx: r2(acc.profitEx + m.profitEx),
    events: acc.events + m.events.length,
  }), { incomeEx: 0, expenseEx: 0, expenseInc: 0, profitEx: 0, events: 0 });
  return { months, totals };
}

// נרמול שורות שהגיעו מהטופס למבנה contractorDetails. שדות המעקב הקיימים
// (paid, paidPayableId וכו') נשמרים מהשורה הקודמת ולא נמחקים בעריכה.
export function normalizeRows(rows, prev = []) {
  const prevByRole = new Map();
  for (const p of (prev || [])) { const r = String((p && p.role) || '').trim(); if (r && !prevByRole.has(r)) prevByRole.set(r, p); }
  const out = [];
  for (const r of (rows || [])) {
    const role = String((r && r.role) || '').trim();
    const name = String((r && r.name) || '').trim();
    const ex = num(r && r.priceExVat);
    if (!role) continue;
    if (!name && !ex && !String((r && r.note) || '').trim()) continue;   // שורה ריקה לגמרי — לא נשמרת
    const old = prevByRole.get(role) || {};
    const vatExempt = Boolean(r && r.vatExempt);
    const priceIncVat = !vatExempt && Boolean(r && r.priceIncVat);   // פטור גובר
    const t = rowTotals({ priceExVat: ex, vatExempt, priceIncVat });
    out.push({
      ...old,
      role, name,
      priceExVat: ex || null,
      vatExempt, priceIncVat,
      note: String((r && r.note) || '').trim(),
      amount: t.inc,                      // הסכום שמשולם בפועל — עליו עובד מעקב הספקים
      supplierId: (r && r.supplierId) || old.supplierId || null,
      docs: Array.isArray(old.docs) ? old.docs : [],   // מסמכי הספק — נשמרים בעריכה

    });
  }
  return out;
}

export default { VAT_RATE, BOARD_ROLES, isFixedRole, SUP_DOC_NAMES, supDocTypesFor, rowTotals, boardRows, eventTotals, boardByMonth, normalizeRows };
