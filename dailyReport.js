// dailyReport.js — סיכום יומי פר-חברה, נשלח לתיבת אותה חברה ב-07:00.
//
// העיקרון: המייל מכיל **רק דברים שדורשים פעולה**. מייל שמדווח "הכל בסדר" נהיה
// רעש ומפסיקים לפתוח אותו — ולכן כשאין שום פריט, לא נשלח מייל בכלל.
//
// המבנה: buildReport מייצר **מודל נתונים** (מקטעים → קבוצות → שורות), ושני
// מרנדרים נפרדים הופכים אותו לטקסט או ל-HTML. כך התוכן והעיצוב אינם נדבקים זה
// לזה, ואפשר לבדוק את התוכן בלי חשבונית ירוקה ובלי בסיס נתונים.

const ddmy = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(iso || ''); };
const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('he-IL')} ₪`;
const MAX_ROWS = 12;   // תקרה לרשימות משניות; חשבוניות פתוחות אינן מוגבלות

// כמה ימים מהפקת המסמך עד שהוא נחשב "מתעכב". ניתן לשינוי בפרטי העסק.
export const DEFAULT_OVERDUE_DAYS = 45;

const daysSince = (iso) => {
  const t = Date.parse(String(iso || '').slice(0, 10));
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};

// מתריעים על אירוע שלא חויב רק אחרי שעברנו את החודש שלו — באמצע החודש אין
// טעם לרדוף אחרי אירועים שעוד לא הגיע זמן לחייב.
export function monthClosed(evDate, now = new Date()) {
  const m = String(evDate || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return false;
  return (Number(m[1]) * 12 + Number(m[2])) < (now.getFullYear() * 12 + (now.getMonth() + 1));
}

// ---- מודל הדוח ----
// section: { icon, title, total, tone, groups[] }
// group:   { label, count, sum, note, cols[], limit, rows[{ cells[], flag, sub }] }
export function buildReport(data, now = new Date()) {
  const sections = [];
  const overdueDays = data.overdueDays;

  // ===== 1) כסף שממתין לך =====
  const inGroups = [];
  const invs = (data.overdueInvoices || []).slice().sort((a, b) => {
    const la = (a.days || 0) >= overdueDays ? 0 : 1, lb = (b.days || 0) >= overdueDays ? 0 : 1;
    return la !== lb ? la - lb : (Number(b.amount) || 0) - (Number(a.amount) || 0);
  });
  if (invs.length) {
    const late = invs.filter(d => (d.days || 0) >= overdueDays).length;
    inGroups.push({
      label: 'חשבוניות פתוחות',
      count: invs.length,
      sum: invs.reduce((t, d) => t + (Number(d.amount) || 0), 0),
      note: late ? `${late} מעל ${overdueDays} יום` : null,
      cols: ['לקוח', 'מסמך', 'הופקה', 'ממתינה', 'סכום'],
      limit: null,   // חובות פתוחים — אף פעם לא מקצרים
      rows: invs.map(d => ({
        flag: (d.days || 0) >= overdueDays,
        cells: [
          d.clientName || '—',
          `${d.typeName || 'מסמך'}${d.number ? ' #' + d.number : ''}`,
          d.date ? ddmy(d.date) : '—',
          d.days != null ? `${d.days} יום` : '—',
          money(d.amount),
        ],
        sub: d.description || null,
      })),
    });
  }
  const evs = (data.uninvoicedEvents || []).slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  if (evs.length) {
    inGroups.push({
      label: 'אירועים שעברו וטרם חויבו',
      count: evs.length,
      sum: evs.reduce((t, e) => t + (Number(e.amount) || 0), 0),
      cols: ['תאריך', 'אמן', 'מיקום', 'סכום'],
      rows: evs.map(e => ({ cells: [ddmy(e.date), e.artist || '—', e.location || '—', money(e.amount)] })),
    });
  }
  if (inGroups.length) {
    sections.push({ icon: '💰', title: 'כסף שממתין לך', tone: 'green', total: inGroups.reduce((t, g) => t + g.sum, 0), groups: inGroups });
  }

  // ===== 2) כסף שאתה חייב =====
  const outGroups = [];
  const payGroup = (label, list) => {
    if (!list || !list.length) return;
    const rows = list.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
    outGroups.push({
      label, count: rows.length, sum: rows.reduce((t, p) => t + (Number(p.amount) || 0), 0),
      cols: ['ספק', 'מסמך', 'סכום'],
      rows: rows.map(p => ({ cells: [p.supplierName || 'ספק', p.number ? '#' + p.number : '—', money(p.amount)] })),
    });
  };
  payGroup('מוכן לתשלום — הלקוח כבר שילם', data.payablesReady);
  payGroup('ממתין לתשלום מהלקוח', data.payablesWaiting);
  if (outGroups.length) {
    sections.push({ icon: '💸', title: 'כסף שאתה חייב', tone: 'red', total: outGroups.reduce((t, g) => t + g.sum, 0), groups: outGroups });
  }

  // ===== 3) תנועה בבנק החודש =====
  // תמונת מצב, לא משימה — ולכן היא לבדה אינה מצדיקה משלוח מייל (ראו hasAction בסוף).
  const b = data.bank;
  if (b && (b.credit || b.debit)) {
    sections.push({
      icon: '🏦', title: `תנועה בבנק · ${b.label || 'החודש'}`, tone: 'blue', total: null, info: true,
      groups: [{
        label: null, cols: ['', ''],
        rows: [
          { cells: ['נכנס', money(b.credit)] },
          { cells: ['יצא', money(b.debit)] },
          { cells: ['נטו', money((b.credit || 0) - (b.debit || 0))], strong: true },
        ],
      }],
    });
  }

  // ===== 4) דורש יד =====
  const fix = [];
  if (data.mailPending) fix.push(['חשבוניות נתקעו בקליטה מהמייל', data.mailPending]);
  if (data.bankUnmatched) fix.push(['תנועות זכות בבנק שלא הותאמו', data.bankUnmatched]);
  if (data.eventsPending) fix.push(['אירועים מהיומן ממתינים לאישור', data.eventsPending]);
  if (fix.length) {
    sections.push({
      icon: '🔧', title: 'דורש יד', tone: 'amber', total: null,
      groups: [{ label: null, cols: ['', ''], rows: fix.map(([t, n]) => ({ cells: [t, String(n)] })) }],
    });
  }

  // מייל נשלח רק אם יש משהו לעשות. מקטע מידע (תנועת הבנק) אינו נחשב.
  if (!sections.some(s => !s.info)) return null;

  const d = now;
  const dateLabel = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
  const report = { companyName: data.companyName, dateLabel, appUrl: data.appUrl || null, overdueDays, sections };
  return { subject: `סיכום יומי | ${data.companyName} | ${dateLabel}`, report, text: reportText(report) };
}

// ---- מרנדר טקסט (גרסת ה-plain-text של המייל) ----
export function reportText(r) {
  const out = ['בוקר טוב,', `זה מה שדורש טיפול היום ב${r.companyName}.`];
  for (const s of r.sections) {
    out.push('', '', `${s.icon} ${s.title}${s.total != null ? ` — ${money(s.total)}` : ''}`, '');
    for (const g of s.groups) {
      if (g.label) out.push(`${g.label} (${g.count}${g.sum != null ? ' · ' + money(g.sum) : ''})${g.note ? ' — ' + g.note : ''}:`);
      const lim = g.limit === null ? null : (g.limit || MAX_ROWS);
      for (const row of (lim == null ? g.rows : g.rows.slice(0, lim))) {
        out.push(`  ${row.flag ? '⚠ ' : '• '}${row.cells.join(' · ')}`);
        if (row.sub) out.push(`      ${row.sub}`);
      }
      if (lim != null && g.rows.length > lim) out.push(`  ועוד ${g.rows.length - lim}`);
      out.push('');
    }
  }
  if (r.appUrl) out.push('', `פתח את המערכת: ${r.appUrl}`);
  out.push('', '— נשלח אוטומטית ממערכת הניהול הפיננסי');
  return out.join('\n');
}

// ---- מרנדר HTML ----
// עיצוב מיילים: טבלאות וסגנון inline בלבד. ג'ימייל מסיר <style> חיצוני ואינו
// תומך ב-flex/grid, ולכן כל הפריסה בטבלאות — מיושן בקוד, אבל עובד בכל לקוח מייל.
const TONES = {
  green: { bar: '#059669', soft: '#ecfdf5' },
  red: { bar: '#dc2626', soft: '#fef2f2' },
  amber: { bar: '#d97706', soft: '#fffbeb' },
  blue: { bar: '#4f46e5', soft: '#eef2ff' },
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const F = 'font-family:Arial,Helvetica,sans-serif';

export function reportHtml(r) {
  const sections = r.sections.map(s => {
    const tone = TONES[s.tone] || TONES.green;
    const groups = s.groups.map(g => {
      const head = g.label
        ? `<tr><td colspan="${g.cols.length}" style="padding:14px 14px 6px;${F};font-size:13.5px;font-weight:700;color:#111827">${esc(g.label)}`
          + ` <span style="font-weight:400;color:#6b7280">(${g.count}${g.sum != null ? ' · ' + esc(money(g.sum)) : ''})</span>`
          + (g.note ? `<span style="font-weight:400;color:${tone.bar}"> — ${esc(g.note)}</span>` : '')
          + `</td></tr>`
        : '';
      const cols = g.cols.some(c => c)
        ? `<tr>${g.cols.map((c, i) => `<th align="${i === g.cols.length - 1 ? 'left' : 'right'}" style="padding:5px 14px;${F};font-size:11px;font-weight:600;color:#9ca3af;border-bottom:1px solid #e5e7eb;white-space:nowrap">${esc(c)}</th>`).join('')}</tr>`
        : '';
      const lim = g.limit === null ? null : (g.limit || MAX_ROWS);
      const rows = (lim == null ? g.rows : g.rows.slice(0, lim)).map((row, idx) => {
        const bg = (row.flag || row.strong) ? tone.soft : (idx % 2 ? '#fafbfc' : '#ffffff');
        const tds = row.cells.map((c, i) => {
          const last = i === row.cells.length - 1;
          const edge = (i === 0 && row.flag) ? `;border-right:3px solid ${tone.bar}` : '';
          return `<td align="${last ? 'left' : 'right'}" style="padding:8px 14px;${F};font-size:13px;color:#1f2937;border-bottom:1px solid #f3f4f6${(last || row.strong) ? ';font-weight:700' : ''}${last ? ';white-space:nowrap' : ''}${edge}">${esc(c)}</td>`;
        }).join('');
        const sub = row.sub
          ? `<tr style="background:${bg}"><td colspan="${row.cells.length}" style="padding:0 14px 8px;${F};font-size:11.5px;color:#6b7280;border-bottom:1px solid #f3f4f6">${esc(row.sub)}</td></tr>`
          : '';
        return `<tr style="background:${bg}">${tds}</tr>${sub}`;
      }).join('');
      const more = (lim != null && g.rows.length > lim)
        ? `<tr><td colspan="${g.cols.length}" style="padding:8px 14px;${F};font-size:12px;color:#6b7280">ועוד ${g.rows.length - lim}</td></tr>`
        : '';
      return head + cols + rows + more;
    }).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:16px">
      <tr><td style="padding:11px 14px;background:${tone.bar};border-radius:9px 9px 0 0;${F};font-size:14.5px;font-weight:700;color:#fff">
        ${s.icon} ${esc(s.title)}${s.total != null ? `<span style="float:left">${esc(money(s.total))}</span>` : ''}
      </td></tr>
      <tr><td style="padding:0 0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${groups}</table></td></tr>
    </table>`;
  }).join('');

  const btn = r.appUrl
    ? `<div style="text-align:center;margin:4px 0"><a href="${esc(r.appUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 34px;border-radius:9px;font-weight:700;font-size:14px;${F}">פתח את המערכת</a></div>`
    : '';

  return `<div dir="rtl" style="background:#f6f7fb;padding:22px 12px;${F}">
    <div style="max-width:680px;margin:0 auto">
      <div style="margin-bottom:16px">
        <div style="${F};font-size:19px;font-weight:700;color:#111827">בוקר טוב</div>
        <div style="${F};font-size:13.5px;color:#6b7280;margin-top:3px">זה מה שדורש טיפול היום ב${esc(r.companyName)} · ${esc(r.dateLabel)}</div>
      </div>
      ${sections}
      ${btn}
      <div style="${F};font-size:11.5px;color:#9ca3af;text-align:center;margin-top:16px">נשלח אוטומטית ממערכת הניהול הפיננסי</div>
    </div>
  </div>`;
}

export { ddmy, money, daysSince };
