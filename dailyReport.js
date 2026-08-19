// dailyReport.js — סיכום יומי פר-חברה, נשלח לתיבת אותה חברה ב-07:00.
//
// העיקרון: המייל מכיל **רק דברים שדורשים פעולה**. מייל שמדווח "הכל בסדר" נהיה
// רעש ומפסיקים לפתוח אותו — ולכן כשאין שום פריט, לא נשלח מייל בכלל.
//
// בניית הטקסט מופרדת מאיסוף הנתונים (buildReport מקבל נתונים ומחזיר מחרוזת),
// כדי שאפשר יהיה לבדוק את הניסוח בלי גישה לחשבונית ירוקה או לבסיס הנתונים.

const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const ddmy = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ''); };
const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('he-IL')} ₪`;
const MAX_ROWS = 8;   // מעבר לזה מקבצים, אחרת המייל נהיה בלתי קריא

// כמה ימים מהפקת המסמך עד שהוא נחשב "מתעכב". ניתן לשינוי בפרטי העסק.
export const DEFAULT_OVERDUE_DAYS = 45;

const daysSince = (iso) => {
  const t = Date.parse(String(iso || '').slice(0, 10));
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

// חודש האירוע נסגר? מתריעים על אירוע שלא חויב רק אחרי שעברנו את החודש שלו —
// באמצע החודש אין טעם לרדוף אחרי אירועים שעוד לא הגיע זמן לחייב.
export function monthClosed(evDate, now = new Date()) {
  const m = String(evDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return false;
  return (Number(m[1]) * 12 + Number(m[2])) < (now.getFullYear() * 12 + (now.getMonth() + 1));
}

const listBlock = (rows, extraLine) => {
  const shown = rows.slice(0, MAX_ROWS).map(r => `  • ${r}`);
  if (rows.length > MAX_ROWS) shown.push(`  ועוד ${rows.length - MAX_ROWS}${extraLine ? ' — ' + extraLine : ''}`);
  return shown.join('\n');
};

// ---- בניית גוף המייל ----
// data: { companyName, overdueInvoices[], uninvoicedEvents[], payablesReady[], payablesWaiting[],
//         mailPending, bankUnmatched, eventsPending }
export function buildReport(data, now = new Date()) {
  const secs = [];

  // 1) כסף שממתין לך
  const inRows = [];
  const totalIn = (data.overdueInvoices || []).reduce((s, d) => s + (Number(d.amount) || 0), 0)
    + (data.uninvoicedEvents || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  if ((data.overdueInvoices || []).length) {
    const rows = data.overdueInvoices
      .slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
      .map(d => `${d.clientName || '—'} · ${d.typeName || 'מסמך'}${d.number ? ' #' + d.number : ''} · ${money(d.amount)} · ${d.days} יום`);
    inRows.push(`חשבוניות פתוחות מעל ${data.overdueDays} יום (${rows.length}):\n${listBlock(rows)}`);
  }
  if ((data.uninvoicedEvents || []).length) {
    const evs = data.uninvoicedEvents.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
    const rows = evs.map(e => `${ddmy(e.date)}${e.artist ? ' · ' + e.artist : ''}${e.location ? ' · ' + e.location : ''} · ${money(e.amount)}`);
    const sum = evs.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    inRows.push(`אירועים שעברו וטרם חויבו (${rows.length} · ${money(sum)}):\n${listBlock(rows, `סה"כ ${money(sum)}`)}`);
  }
  if (inRows.length) secs.push(`💰 כסף שממתין לך — ${money(totalIn)}\n\n${inRows.join('\n\n')}`);

  // 2) כסף שאתה חייב
  const outRows = [];
  const totalOut = [...(data.payablesReady || []), ...(data.payablesWaiting || [])]
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if ((data.payablesReady || []).length) {
    const rows = data.payablesReady.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
      .map(p => `${p.supplierName || 'ספק'}${p.number ? ' · #' + p.number : ''} · ${money(p.amount)}`);
    outRows.push(`מוכן לתשלום — הלקוח כבר שילם (${rows.length}):\n${listBlock(rows)}`);
  }
  if ((data.payablesWaiting || []).length) {
    const rows = data.payablesWaiting.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
      .map(p => `${p.supplierName || 'ספק'}${p.number ? ' · #' + p.number : ''} · ${money(p.amount)}`);
    outRows.push(`ממתין לתשלום מהלקוח (${rows.length}):\n${listBlock(rows)}`);
  }
  if (outRows.length) secs.push(`💸 כסף שאתה חייב — ${money(totalOut)}\n\n${outRows.join('\n\n')}`);

  // 3) דורש יד
  const fix = [];
  if (data.mailPending) fix.push(`${data.mailPending} חשבוניות נתקעו בקליטה מהמייל`);
  if (data.bankUnmatched) fix.push(`${data.bankUnmatched} תנועות בנק לא הותאמו`);
  if (data.eventsPending) fix.push(`${data.eventsPending} אירועים מהיומן ממתינים לאישור`);
  if (fix.length) secs.push(`🔧 דורש יד\n\n${fix.map(x => `  • ${x}`).join('\n')}`);

  if (!secs.length) return null;   // אין מה לדווח — לא שולחים מייל

  const d = now;
  return {
    subject: `סיכום יומי | ${data.companyName} | ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`,
    text: [
      'בוקר טוב,',
      `זה מה שדורש טיפול היום ב${data.companyName}.`,
      '',
      '',
      secs.join('\n\n\n'),
      '',
      '',
      data.appUrl ? `פתח את המערכת: ${data.appUrl}` : '',
      '',
      '— נשלח אוטומטית ממערכת הניהול הפיננסי',
    ].filter(x => x !== undefined).join('\n'),
  };
}

// גרסת HTML — RTL, כפתור אמיתי לפתיחת המערכת, ושמירה על אותו מבנה בדיוק
export function reportHtml(text, appUrl) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(text.replace(/\nפתח את המערכת: .*/, '')).replace(/\n/g, '<br>');
  const btn = appUrl
    ? `<div style="margin:22px 0 6px"><a href="${esc(appUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 26px;border-radius:9px;font-weight:600;font-size:14px">פתח את המערכת</a></div>`
    : '';
  return `<div dir="rtl" style="text-align:right;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.75;color:#1c2333">${body}${btn}</div>`;
}

export { MONTHS_HE, ddmy, money, daysSince };
