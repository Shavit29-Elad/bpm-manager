// bankMatch.js — התאמת תנועות בנק (זיכויים) לחשבוניות הכנסה מחשבונית ירוקה.
// תומך ב: התאמה מדויקת, התאמה עם ניכוי מס במקור 5% (סכום נמוך ב-5%),
// והתאמה של תנועה אחת למספר חשבוניות (צירוף שסכומן = ההעברה).

const WH = 0.95;            // ניכוי מס במקור 5% → מתקבל 95% מהחשבונית
const tol = (base) => Math.max(3, base * 0.004);

function normName(s) {
  return String(s || '')
    .replace(/בע["'׳]?מ/g, '').replace(/\(.*?\)/g, '')
    .replace(/[.,"'׳\-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y || x.length < 2 || y.length < 2) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wx = x.split(' ').filter(w => w.length >= 2);
  const wy = y.split(' ').filter(w => w.length >= 2);
  const common = wx.filter(w => wy.includes(w));
  return common.length >= 2 || (common.length === 1 && (wx.length === 1 || wy.length === 1));
}
function parseDate(s) {
  if (!s) return null;
  let m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(y, +m[2] - 1, +m[1]); }
  return null;
}
function daysBetween(a, b) { const da = parseDate(a), db = parseDate(b); return (!da || !db) ? 999 : Math.abs((da - db) / 86400000); }

// סוג התאמת סכום בין תנועה לחשבונית בודדת: 'exact' | 'wh' (פחות 5%) | null
function amountKind(bank, invAmt) {
  if (bank == null || invAmt == null) return null;
  if (Math.abs(bank - invAmt) <= tol(invAmt)) return 'exact';
  if (Math.abs(bank - invAmt * WH) <= tol(invAmt)) return 'wh';
  return null;
}

export function scoreMatch(tx, inv) {
  let score = 0; const reasons = [];
  if (tx.invoiceNumber && inv.number != null && String(inv.number) === String(tx.invoiceNumber)) { score += 100; reasons.push('מספר חשבונית'); }
  const ak = amountKind(tx.absAmount, inv.amountIncVat);
  if (ak === 'exact') { score += 50; reasons.push('סכום זהה'); }
  else if (ak === 'wh') { score += 45; reasons.push('סכום פחות 5% (ניכוי מס)'); }
  if (tx.nameHint && inv.clientName && nameMatch(tx.nameHint, inv.clientName)) { score += 40; reasons.push('שם לקוח'); }
  const dd = daysBetween(tx.date, inv.date);
  if (dd <= 7) score += 12; else if (dd <= 30) score += 6;
  return { score, reasons, amountKind: ak };
}

const toInv = (inv, extra = {}) => ({ id: inv.id, number: inv.number, type: inv.type, clientName: inv.clientName, amount: inv.amountIncVat, date: inv.date, url: inv.url || null, ...extra });

// מציאת צירוף חשבוניות (2..4) שסכומן ≈ target
function findCombo(target, invs) {
  const pool = invs.slice().filter(i => i.amountIncVat > 0).sort((a, b) => b.amountIncVat - a.amountIncVat).slice(0, 16);
  const t = tol(target); let best = null;
  (function dfs(start, chosen, sum) {
    if (best) return;
    if (chosen.length >= 2 && Math.abs(sum - target) <= t) { best = chosen.slice(); return; }
    if (chosen.length >= 4) return;
    for (let i = start; i < pool.length; i++) {
      if (sum + pool[i].amountIncVat - target > t) continue;   // גלישה
      chosen.push(pool[i]); dfs(i + 1, chosen, sum + pool[i].amountIncVat); chosen.pop();
      if (best) return;
    }
  })(0, [], 0);
  return best;
}

// מתאים תנועות מול חשבוניות. חשבונית לא מותאמת פעמיים. תומך בצירוף חשבוניות.
export function matchCredits(txns, invoices) {
  const usedInv = new Set();
  const result = new Map();   // index -> {matchStatus, matchedInvoices, suggestions}
  const credits = [];
  txns.forEach((t, i) => { if (t.direction === 'credit') credits.push({ t, i }); });

  // שלב 1: התאמות בודדות חמדניות. חובה הסכמה על סכום (מדויק/5%) או מספר חשבונית — לא שם בלבד.
  const pairs = [];
  credits.forEach(({ t, i }) => invoices.forEach(inv => {
    const s = scoreMatch(t, inv);
    const strong = s.amountKind !== null || s.reasons.includes('מספר חשבונית');
    if (strong && s.score >= 45) pairs.push({ i, inv, ...s });
  }));
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (result.has(p.i) || usedInv.has(p.inv.id)) continue;
    result.set(p.i, { matchStatus: 'auto', matchedInvoices: [toInv(p.inv, { reasons: p.reasons })], suggestions: [] });
    usedInv.add(p.inv.id);
  }

  // שלב 2: צירוף חשבוניות לתנועות שנשארו (לפי שם לקוח)
  for (const { t, i } of credits) {
    if (result.has(i) || !t.nameHint) continue;
    const cand = invoices.filter(inv => !usedInv.has(inv.id) && inv.clientName && nameMatch(t.nameHint, inv.clientName));
    if (cand.length < 2) continue;
    let combo = findCombo(t.absAmount, cand);
    let reason = 'צירוף חשבוניות';
    if (!combo) { combo = findCombo(t.absAmount / WH, cand); reason = 'צירוף חשבוניות פחות 5%'; }
    if (combo) {
      combo.forEach(inv => usedInv.add(inv.id));
      result.set(i, { matchStatus: 'auto', matchedInvoices: combo.map(inv => toInv(inv, { reasons: [reason] })), suggestions: [] });
    }
  }

  // בונים פלט לכל התנועות
  return txns.map((t, i) => {
    if (t.direction !== 'credit') return { ...t, matchStatus: 'skip' };
    const r = result.get(i);
    if (r) return { ...t, ...r };
    // הצעות: חשבוניות בודדות עם ציון משמעותי שעדיין פנויות
    const sugg = invoices.map(inv => ({ inv, ...scoreMatch(t, inv) }))
      .filter(s => s.score >= 40 && !usedInv.has(s.inv.id))
      .sort((a, b) => b.score - a.score).slice(0, 5).map(s => toInv(s.inv, { reasons: s.reasons, score: s.score }));
    return { ...t, matchStatus: 'unmatched', matchedInvoices: [], suggestions: sugg };
  });
}

// ===== צד ההוצאות: התאמת תנועות חובה לחשבוניות ספקים (הוצאות מחשבונית ירוקה) =====
function scoreExpense(tx, exp) {
  let score = 0; const reasons = [];
  if (tx.invoiceNumber && exp.number != null && String(exp.number) === String(tx.invoiceNumber)) { score += 100; reasons.push('מספר חשבונית'); }
  // בהוצאות (חשבוניות ספק) אין ניכוי מס במקור — התאמה אוטומטית רק לפי סכום זהה (+ תאריך), לא פחות 5%
  const exact = amountKind(tx.absAmount, exp.amountIncVat) === 'exact';
  if (exact) { score += 50; reasons.push('סכום זהה'); }
  if (tx.nameHint && exp.supplierName && nameMatch(tx.nameHint, exp.supplierName)) { score += 40; reasons.push('שם ספק'); }
  const dd = daysBetween(tx.date, exp.date);
  if (dd <= 7) score += 12; else if (dd <= 30) score += 6;
  return { score, reasons, amountKind: exact ? 'exact' : null };
}
const toExp = (e, extra = {}) => ({ id: e.id, number: e.number, type: e.type, clientName: e.supplierName || '—', amount: e.amountIncVat ?? e.amount, date: e.date, url: e.url || null, kind: 'expense', description: e.description || e.category || '', ...extra });

// מחזיר מערך של { i, matchStatus, matchedInvoices, suggestions } עבור אינדקסי תנועות החובה בלבד
export function matchDebits(txns, expenses) {
  const used = new Set(); const result = new Map();
  const debits = []; txns.forEach((t, i) => { if (t.direction === 'debit') debits.push({ t, i }); });
  const pairs = [];
  debits.forEach(({ t, i }) => (expenses || []).forEach(exp => {
    const s = scoreExpense(t, exp);
    const strong = s.amountKind !== null || s.reasons.includes('מספר חשבונית');
    if (strong && s.score >= 45) pairs.push({ i, exp, ...s });
  }));
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (result.has(p.i) || used.has(p.exp.id)) continue;
    result.set(p.i, { matchStatus: 'auto', matchedInvoices: [toExp(p.exp, { reasons: p.reasons })], suggestions: [] });
    used.add(p.exp.id);
  }
  const out = [];
  for (const { t, i } of debits) {
    const r = result.get(i);
    if (r) { out.push({ i, ...r }); continue; }
    const sugg = (expenses || []).map(exp => ({ exp, ...scoreExpense(t, exp) }))
      .filter(s => s.score >= 40 && !used.has(s.exp.id))
      .sort((a, b) => b.score - a.score).slice(0, 5).map(s => toExp(s.exp, { reasons: s.reasons, score: s.score }));
    out.push({ i, matchStatus: 'unmatched', matchedInvoices: [], suggestions: sugg });
  }
  return out;
}

// קישור קבלה (סוג 400) לכל חשבונית מס (סוג 305) לפי לקוח+סכום
export function attachReceipts(matched, receipts) {
  if (!receipts || !receipts.length) return matched;
  for (const t of matched) {
    for (const inv of (t.matchedInvoices || [])) {
      if (inv.type === 320 || inv.type === '320') continue;    // מס-קבלה — כולל קבלה
      const rec = receipts.find(r => nameMatch(inv.clientName, r.clientName) && Math.abs((r.amountIncVat ?? r.amount) - inv.amount) <= tol(inv.amount));
      if (rec) inv.receipt = { number: rec.number, url: rec.url || null, amount: rec.amountIncVat ?? rec.amount };
    }
  }
  return matched;
}

export default { scoreMatch, matchCredits, matchDebits, attachReceipts };
