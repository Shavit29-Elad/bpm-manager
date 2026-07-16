// bankMatch.js — התאמת תנועות בנק (זיכויים) לחשבוניות הכנסה מחשבונית ירוקה.
// לכל תנועה מחשבים ציון מול כל חשבונית: מספר חשבונית > סכום > שם > קרבת תאריך.

function normName(s) {
  return String(s || '')
    .replace(/בע["'׳]?מ/g, '')       // בע"מ
    .replace(/\(.*?\)/g, '')          // סוגריים
    .replace(/[.,"'׳\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function nameMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y || x.length < 2 || y.length < 2) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // חפיפת מילים משמעותיות
  const wx = x.split(' ').filter(w => w.length >= 2);
  const wy = y.split(' ').filter(w => w.length >= 2);
  const common = wx.filter(w => wy.includes(w));
  return common.length >= 2 || (common.length === 1 && (wx.length === 1 || wy.length === 1));
}
function parseDate(s) {
  if (!s) return null;
  let m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);       // YYYY-MM-DD
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{2,4})/);        // DD/MM/YY(YY)
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  return null;
}
function daysBetween(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return 999;
  return Math.abs((da - db) / 86400000);
}

// ציון התאמה בין תנועה (זיכוי) לחשבונית
export function scoreMatch(tx, inv) {
  let score = 0; const reasons = [];
  if (tx.invoiceNumber && inv.number != null && String(inv.number) === String(tx.invoiceNumber)) {
    score += 100; reasons.push('מספר חשבונית');
  }
  if (tx.absAmount != null && inv.amountIncVat != null && Math.abs(tx.absAmount - inv.amountIncVat) < 1) {
    score += 50; reasons.push('סכום זהה');
  }
  if (tx.nameHint && inv.clientName && nameMatch(tx.nameHint, inv.clientName)) {
    score += 40; reasons.push('שם לקוח');
  }
  const dd = daysBetween(tx.date, inv.date);
  if (dd <= 7) score += 12; else if (dd <= 30) score += 6;
  return { score, reasons, days: dd };
}

const toSug = (inv, s) => ({ id: inv.id, number: inv.number, clientName: inv.clientName, amount: inv.amountIncVat, date: inv.date, url: inv.url || null, score: s.score, reasons: s.reasons });

// מתאים רשימת תנועות מול רשימת חשבוניות. הקצאה חמדנית — חשבונית לא מותאמת פעמיים.
export function matchCredits(txns, invoices) {
  const credits = txns.filter(t => t.direction === 'credit');
  // כל צמדי (תנועה, חשבונית) עם ציון, לפי ציון יורד
  const pairs = [];
  credits.forEach((tx, ti) => {
    invoices.forEach(inv => {
      const s = scoreMatch(tx, inv);
      if (s.score > 0) pairs.push({ ti, inv, ...s });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const txMatch = {};        // ti -> chosen pair
  const usedInv = new Set();
  for (const p of pairs) {
    if (txMatch[p.ti] || usedInv.has(p.inv.id)) continue;
    if (p.score >= 50) { txMatch[p.ti] = p; usedInv.add(p.inv.id); }
  }
  // בונים תוצאה לכל תנועה (כולל חיובים שמדלגים)
  let ci = -1;
  return txns.map(tx => {
    if (tx.direction !== 'credit') return { ...tx, matchStatus: 'skip' };
    ci++;
    const chosen = txMatch[ci];
    // הצעות משמעותיות בלבד (סכום/שם/מספר — לא רק קרבת תאריך)
    const sugg = invoices.map(inv => ({ inv, ...scoreMatch(tx, inv) }))
      .filter(s => s.score >= 40 && !usedInv.has(s.inv.id))
      .sort((a, b) => b.score - a.score).slice(0, 4).map(s => toSug(s.inv, s));
    if (chosen) return { ...tx, matchStatus: 'auto', matchedInvoice: toSug(chosen.inv, chosen), suggestions: sugg };
    return { ...tx, matchStatus: 'unmatched', matchedInvoice: null, suggestions: sugg };
  });
}

export default { scoreMatch, matchCredits };
