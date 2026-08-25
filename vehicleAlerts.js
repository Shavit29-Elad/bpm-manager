// התראות תוקף לרכבי חברה.
// שלוש תזכורות לכל מסמך: 30 יום, 14 יום ויום אחד לפני הפקיעה.
//
// מניעת כפילות: מפתח השליחה כולל את תאריך התוקף עצמו
// (`license:2027-03-15:30`). לכן חידוש מסמך מייצר מפתחות חדשים ומתחיל מחזור
// תזכורות נקי — בלי שום קוד איפוס, ובלי סיכון שתזכורת ישנה תחסום חדשה.
// מקור האמת היחיד לסוגי המסמכים. השרת מייבא מכאן, והפרונט מסונכרן מולו בבדיקה.
export const VEHICLE_SLOTS = [
  { key: 'license', field: 'licenseExpiry', he: 'רישיון רכב',
    renew: 'חידוש רישיון במשרד הרישוי (טסט שנתי)' },
  { key: 'cto', field: 'ctoExpiry', he: 'ביטוח חובה',
    renew: 'חידוש פוליסת ביטוח חובה' },
  { key: 'comp', field: 'compExpiry', he: 'ביטוח מקיף',
    renew: 'חידוש פוליסת ביטוח מקיף' },
  { key: 'towing', field: 'towingExpiry', he: 'גרירה · שמשות · פנסים ומראות',
    renew: 'חידוש הכיסוי לגרירה, שמשות, פנסים ומראות' },
  { key: 'security', field: 'securityExpiry', he: 'אישור קיום אמצעי מיגון',
    renew: 'חידוש אישור קיום אמצעי מיגון' },
  { key: 'ramp', field: 'rampExpiry', he: 'תסקיר רמפה',
    renew: 'ביצוע תסקיר רמפה מחודש' },
];
export const THRESHOLDS = [30, 14, 1];

const KIND_HE = { truck: 'משאית', private: 'רכב פרטי' };
const isIso = (s) => /^\d{4}-\d{2}-\d{2}/.test(String(s || ''));

// ימים שלמים עד התאריך, לפי חצות — כך ש"מחר" הוא תמיד 1 ולא 0.9
export function daysUntil(iso, now = new Date()) {
  if (!isIso(iso)) return null;
  const target = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export const sentKey = (slot, expiry, threshold) => `${slot}:${String(expiry).slice(0, 10)}:${threshold}`;

// אילו תזכורות מגיעות היום ועדיין לא נשלחו.
// הסף נחצה כשמספר הימים ירד אליו או מתחתיו — כדי ששרת שהיה כבוי ביום המדויק
// ישלח את התזכורת למחרת במקום לדלג עליה. תזכורת של סף נמוך יותר גוברת: אם
// נותרו 12 ימים, נשלחת תזכורת ה-14 ולא זו של 30, וזו של 30 מסומנת כמיותרת.
export function dueAlerts(vehicles, now = new Date()) {
  const out = [];
  for (const v of (vehicles || [])) {
    const slots = VEHICLE_SLOTS.map(s => ({ ...s, expiry: v[s.field] }))
      // מסמכים נוספים שהמשתמש הוסיף. מתריעים רק כשהוזן להם תוקף.
      .concat((v.extras || []).filter(x => x && x.title).map(x => ({
        key: 'extra:' + x.id, field: null, he: String(x.title),
        renew: `חידוש ${x.title}`, expiry: x.expiry })));
    for (const s of slots) {
      const expiry = s.expiry;
      if (!isIso(expiry)) continue;
      const left = daysUntil(expiry, now);
      if (left === null || left < 0) continue;            // כבר פג — אין יותר מה להתריע מראש
      const crossed = THRESHOLDS.filter(t => left <= t);   // כל הספים שנחצו
      if (!crossed.length) continue;
      const threshold = Math.min(...crossed);              // הדחוף ביותr
      const sent = (v.alertsSent || {});
      if (sent[sentKey(s.key, expiry, threshold)]) continue;
      out.push({ vehicleId: v.id, plate: v.plate || '—', kind: v.kind || 'private',
        scope: v.scope === 'personal' ? 'personal' : 'company',
        maker: v.maker || '', ownerName: v.ownerName || '',
        slot: s.key, slotHe: s.he, renewHe: s.renew, expiry: String(expiry).slice(0, 10),
        daysLeft: left, threshold, key: sentKey(s.key, expiry, threshold) });
    }
  }
  // הדחוף קודם
  out.sort((a, b) => a.daysLeft - b.daysLeft || String(a.plate).localeCompare(String(b.plate), 'he'));
  return out;
}

const he = (iso) => String(iso).slice(0, 10).split('-').reverse().join('/');
const urgency = (d) => d <= 1 ? 'מחר' : d <= 14 ? `בעוד ${d} ימים` : `בעוד ${d} ימים`;

export function alertSubject(items) {
  if (!items || !items.length) return '';
  const worst = items[0];
  const who = `${KIND_HE[worst.kind] || 'רכב'} ${worst.plate}`;
  if (worst.daysLeft <= 1) return `🔴 דחוף — ${worst.slotHe} של ${who} פג מחר`;
  if (items.length === 1) return `⏰ ${worst.slotHe} של ${who} פג ${urgency(worst.daysLeft)}`;
  return `⏰ ${items.length} מסמכי רכב שפגים בקרוב — הראשון ${urgency(worst.daysLeft)}`;
}

// גוף המייל. טבלאות ו-inline styles בלבד — Gmail מתעלם מ-<style>.
export function alertHtml(companyName, items) {
  const row = (it) => {
    const color = it.daysLeft <= 1 ? '#b42318' : it.daysLeft <= 14 ? '#a15c00' : '#0a7d33';
    const bg = it.daysLeft <= 1 ? '#fde8e8' : it.daysLeft <= 14 ? '#fff4e5' : '#e7f7ee';
    const sub = [it.scope === 'personal' ? 'רכב אישי' : KIND_HE[it.kind], it.maker,
      it.ownerName && `על שם ${it.ownerName}`].filter(Boolean).join(' · ');
    return `<tr><td style="padding:0 0 14px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border-radius:10px">
        <tr><td style="padding:14px 16px;font-family:Arial,sans-serif;direction:rtl;text-align:right">
          <div style="font-size:17px;font-weight:bold;color:${color}">${it.slotHe} — ${it.plate}</div>
          <div style="font-size:13px;color:#5b6478;margin-top:3px">${sub}</div>
          <div style="font-size:15px;color:#1c2333;margin-top:9px">
            התוקף פג ב-<b>${he(it.expiry)}</b> — ${it.daysLeft <= 1 ? '<b>מחר</b>' : `נותרו <b>${it.daysLeft} ימים</b>`}.
          </div>
          <div style="font-size:13px;color:#5b6478;margin-top:5px">נדרש: ${it.renewHe}.</div>
        </td></tr>
      </table></td></tr>`;
  };
  return `<div style="background:#f5f6fb;padding:22px 0;font-family:Arial,sans-serif;direction:rtl">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
        <tr><td style="padding:0 16px 16px;text-align:right">
          <div style="font-size:20px;font-weight:bold;color:#1c2333">🚚 תוקף מסמכי רכב</div>
          <div style="font-size:13px;color:#5b6478;margin-top:3px">${companyName || ''}</div>
        </td></tr>
        ${items.map(row).join('')}
        <tr><td style="padding:6px 16px;font-family:Arial,sans-serif;direction:rtl;text-align:right;font-size:12.5px;color:#5b6478">
          אחרי החידוש — עדכנו את המסמך בלשונית "רכבי חברה" (כפתור "טופל / חידוש").
          ההתראות ייפסקו רק אחרי הזנת התוקף החדש.
        </td></tr>
      </table></td></tr></table></div>`;
}

export function alertText(companyName, items) {
  const lines = [`תוקף מסמכי רכב — ${companyName || ''}`, ''];
  for (const it of items) {
    lines.push(`${it.slotHe} · ${it.plate} (${it.scope === 'personal' ? 'רכב אישי' : (KIND_HE[it.kind] || '')}${it.maker ? ' ' + it.maker : ''})`);
    lines.push(`  פג ב-${he(it.expiry)} — ${it.daysLeft <= 1 ? 'מחר' : `נותרו ${it.daysLeft} ימים`}. נדרש: ${it.renewHe}.`);
    lines.push('');
  }
  lines.push('אחרי החידוש — עדכנו את המסמך בלשונית "רכבי חברה" (כפתור "טופל / חידוש").');
  return lines.join('\n');
}

export default { VEHICLE_SLOTS, THRESHOLDS, daysUntil, dueAlerts, sentKey, alertSubject, alertHtml, alertText };
