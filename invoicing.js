// lib/invoicing.js
// לוגיקת חיוב: איסוף אירועים לפי לקוח, בניית שורות חשבונית לפי הפורמט של BPM,
// וכותרת/נושא למסמך. פורמט שורה נלמד מחשבונית אמיתית (חשבונית מס 50419):
//   "{שירות} {DD.MM.YY} - {מיקום}"   למשל: "הגברה 01.06.26 - הניומה חיפה"
// לכל אירוע עד 3 שורות: הגברה (price), סאונד (priceSound), נוסף (priceExtras).

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function monthKey(iso) { return iso ? iso.slice(0, 7) : 'unknown'; } // yyyy-mm
function ddmyDots(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${(y || '').slice(2)}`;
}
const num = (v) => Number(v) || 0;

// סכום מסך לד = מחיר למ' × כמות מ'
function ledTotal(ev) { return num(ev.ledPricePerMeter) * num(ev.ledMeters); }
// סכום כולל של אירוע = הגברה + תאורה + סאונד + בקליין + מסך לד + תוספות (עם נפילה ל-price בלבד)
export function eventTotal(ev) {
  const parts = num(ev.price) + num(ev.priceLighting) + num(ev.priceSound) + num(ev.priceBackline) + ledTotal(ev) + num(ev.priceExtras);
  return parts || num(ev.price);
}
function isBilled(ev) { return Boolean(ev.invoiceId) || ev.invoiceStatus === 'invoiced'; }
// אירוע שלא צריך להוציא עליו חשבונית (סומן ידנית, או לקוח "ללא - שולם")
export function isNoInvoice(ev) {
  if (ev.noInvoice) return true;
  const c = (ev.clientName || ev.client || '').trim();
  return /ללא\s*-?\s*שול[םמ]/.test(c);
}

// בונה שורות חשבונית מאירוע יחיד לפי הפורמט הנלמד
export function eventInvoiceLines(ev) {
  const date = ddmyDots(ev.date || ev.dateRaw);
  const loc = (ev.location || ev.artist || '').trim();
  const suffix = `${date}${loc ? ' - ' + loc : ''}`.trim();
  const line = (label, price, qty = 1) => ({ description: `${label} ${suffix}`.trim(), quantity: qty, price: num(price), eventId: ev.id });
  const lines = [];
  if (num(ev.price)) lines.push(line('הגברה', ev.price));
  if (num(ev.priceLighting)) lines.push(line('תאורה', ev.priceLighting));
  if (num(ev.priceSound)) lines.push(line('סאונד', ev.priceSound));
  if (num(ev.priceBackline)) lines.push(line('בקליין', ev.priceBackline));
  // מסך לד — כמות מטרים × מחיר ליחידה (מוצג בחשבונית ככמות × מחיר יחידה)
  const ledQty = num(ev.ledMeters), ledUnit = num(ev.ledPricePerMeter);
  if (ledQty && ledUnit) lines.push(line('מסך לד', ledUnit, ledQty));
  if (num(ev.priceExtras)) lines.push(line('תוספות', ev.priceExtras));
  if (!lines.length && eventTotal(ev)) lines.push(line('הגברה', eventTotal(ev)));
  return lines;
}

// שורות חשבונית מרשימת אירועים
export function invoiceItemsFromEvents(events) {
  return (events || []).flatMap(eventInvoiceLines);
}

// כותרת/נושא ברירת מחדל למסמך: "הגברה - {אמן/ים} - {חודש} {yy}"
export function subjectForEvents(events) {
  const artists = [...new Set((events || []).map(e => (e.artist || '').trim()).filter(Boolean))];
  const dates = (events || []).map(e => e.date || e.dateRaw).filter(Boolean).sort();
  let monthLabel = '';
  if (dates.length) {
    const mid = dates[Math.floor(dates.length / 2)].slice(0, 7).split('-');
    monthLabel = `${HE_MONTHS[+mid[1] - 1] || ''} ${(mid[0] || '').slice(2)}`.trim();
  }
  return ['הגברה', artists.join(', '), monthLabel].filter(Boolean).join(' - ');
}

// קיבוץ כל האירועים לפי לקוח (כולל מחויבים, מסומנים) — למסך בחירת אירועים והפקה
export function eventsByClient(events) {
  const groups = {};
  for (const ev of events || []) {
    if (isNoInvoice(ev)) continue; // אירועים שלא צריך להוציא עליהם חשבונית — לא מוצגים לחיוב
    const client = (ev.clientName || ev.client || 'ללא לקוח').trim();
    if (!groups[client]) groups[client] = { client, clientId: ev.clientId || null, events: [], total: 0, unbilledTotal: 0, unbilledCount: 0, unpaidTotal: 0, unpaidCount: 0 };
    const g = groups[client];
    if (ev.clientId && !g.clientId) g.clientId = ev.clientId;
    const t = eventTotal(ev);
    const billed = isBilled(ev);
    const linkedDocs = Array.isArray(ev.linkedDocs) ? ev.linkedDocs : [];
    // "שולם/הושלם" רק כשיש מסמך מסוג קבלה או מס-קבלה (320/400) — עסקה/מס בלבד = חויב אך פתוח
    const paid = linkedDocs.some(d => [320, 400].includes(Number(d.type))) || [320, 400].includes(Number(ev.invoiceType));
    g.events.push({
      id: ev.id, date: ev.date || ev.dateRaw || null, artist: ev.artist || '', location: ev.location || '',
      price: num(ev.price), priceLighting: num(ev.priceLighting), priceSound: num(ev.priceSound), priceBackline: num(ev.priceBackline), ledMeters: num(ev.ledMeters), ledPricePerMeter: num(ev.ledPricePerMeter), priceExtras: num(ev.priceExtras), total: t,
      billed, paid, invoiceId: ev.invoiceId || null, invoiceNumber: ev.invoiceNumber || null, invoiceType: ev.invoiceType || null,
      linkedDocs,
    });
    g.total += t;
    if (!billed) { g.unbilledTotal += t; g.unbilledCount++; }
    if (!paid) { g.unpaidTotal += t; g.unpaidCount++; }
  }
  for (const g of Object.values(groups)) g.events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return Object.values(groups).sort((a, b) => b.unpaidTotal - a.unpaidTotal || a.client.localeCompare(b.client));
}

// ---- תאימות לאחור: קיבוץ לפי לקוח+חודש (המסך הישן של "חיוב") ----
export function groupForInvoicing(events) {
  const groups = {};
  for (const ev of events || []) {
    if (isBilled(ev)) continue;
    const client = (ev.clientName || ev.client || ev.artist || 'לא ידוע').trim();
    const key = `${client}__${monthKey(ev.date)}`;
    if (!groups[key]) groups[key] = { client, month: monthKey(ev.date), events: [], total: 0 };
    groups[key].events.push(ev);
    groups[key].total += eventTotal(ev);
  }
  return Object.values(groups).sort((a, b) => b.month.localeCompare(a.month));
}
export function invoiceItemsFromGroup(group) { return invoiceItemsFromEvents(group.events); }

// קבלנים: כמה משלמים לכל קבלן, ומעקב תשלום לפי אירוע (שולם / לא שולם)
export function contractorPayables(events) {
  const byContractor = {};
  for (const ev of events || []) {
    const details = ev.contractorDetails || [];
    for (let i = 0; i < details.length; i++) {
      const c = details[i];
      const name = (c.name || '').trim();
      if (!name) continue;
      if (c.handled) continue; // סומן "טופל" — יורד מרשימת הפתוחים
      if (!byContractor[name]) byContractor[name] = { name, total: 0, paidTotal: 0, unpaidTotal: 0, events: [] };
      const amt = Number(c.amount) || 0;
      const paid = Boolean(c.paid);
      const g = byContractor[name];
      g.total += amt;
      if (paid) g.paidTotal += amt; else g.unpaidTotal += amt;
      g.events.push({ eventId: ev.id, index: i, date: ev.date || ev.dateRaw || null, artist: ev.artist || '', location: ev.location || '', amount: amt, paid, paidInvoice: c.paidInvoice || null, paidExpenseUrl: c.paidExpenseUrl || null });
    }
  }
  for (const g of Object.values(byContractor)) g.events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return Object.values(byContractor).sort((a, b) => b.unpaidTotal - a.unpaidTotal || a.name.localeCompare(b.name, 'he'));
}

export default {
  eventTotal, eventInvoiceLines, invoiceItemsFromEvents, subjectForEvents, eventsByClient,
  groupForInvoicing, invoiceItemsFromGroup, contractorPayables,
};
