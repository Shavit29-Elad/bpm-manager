// googleCalendar.js
// חיבור יומן גוגל דרך קישור iCal פרטי (סודי) — בלי OAuth ובלי אסימונים שפגים.
// בגוגל יומן: הגדרות היומן ← "כתובת סודית בפורמט iCal" ← להעתיק את הכתובת.
// הכתובת נשמרת ב-GOOGLE_ICAL_URL. גם matchEvents עצמאי וניתן לבדיקה בלי רשת.

function normalize(str) {
  return (str || '').toLowerCase().replace(/["'’.,\-()]/g, '').replace(/\s+/g, ' ').trim();
}

function nameSimilar(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const wa = new Set(na.split(' ')), wb = nb.split(' ');
  const hits = wb.filter(w => wa.has(w)).length;
  return hits / Math.max(wa.size, wb.length);
}

// הפרש ימים בין שני תאריכים (yyyy-mm-dd)
function dayDiff(a, b) {
  if (!a || !b) return 99;
  const d = Math.abs((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
  return isNaN(d) ? 99 : d;
}

// הצלבה בין אירועי ווטסאפ לאירועי יומן (עם סובלנות של עד יום הפרש בתאריך)
export function matchEvents(whatsappEvents, calendarEvents) {
  const matched = [];
  const usedCal = new Set();
  for (const wa of whatsappEvents) {
    let best = null, bestScore = 0;
    for (const cal of calendarEvents) {
      if (usedCal.has(cal.id)) continue;
      const dd = dayDiff(wa.date, cal.date);
      if (dd > 1) continue; // מתירים עד יום הפרש (טעויות הקלדה/אזור זמן)
      let score = Math.max(
        nameSimilar(wa.artist, cal.title),
        nameSimilar(wa.location, cal.location),
        nameSimilar(wa.location, cal.title),
        nameSimilar(wa.artist, cal.location),
      );
      if (dd === 0) score += 0.05; // עדיפות קלה להתאמת תאריך מדויקת
      if (score > bestScore) { bestScore = score; best = cal; }
    }
    if (best && bestScore >= 0.4) {
      usedCal.add(best.id);
      matched.push({ whatsapp: wa, calendar: best, score: Number(bestScore.toFixed(2)) });
    } else {
      matched.push({ whatsapp: wa, calendar: null, score: 0 });
    }
  }
  const missingInCalendar = matched.filter(m => !m.calendar).map(m => m.whatsapp);
  const matchedCalIds = new Set(matched.filter(m => m.calendar).map(m => m.calendar.id));
  const missingInWhatsapp = calendarEvents.filter(c => !matchedCalIds.has(c.id));
  return { matched, missingInCalendar, missingInWhatsapp };
}

// --- ניתוח פורמט iCal (.ics) ---
// מפענח בלוקים של VEVENT ומחזיר { id, date (yyyy-mm-dd), title, location }
export function parseIcs(text) {
  // ביטול "קיפול שורות" (שורות המשך מתחילות ברווח/טאב)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = rawKey.split(';')[0].toUpperCase();
    if (key === 'DTSTART') {
      const digits = value.replace(/[^0-9]/g, '');
      if (digits.length >= 8) {
        cur.date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
      }
    } else if (key === 'SUMMARY') {
      cur.title = unescapeIcs(value);
    } else if (key === 'LOCATION') {
      cur.location = unescapeIcs(value);
    } else if (key === 'UID') {
      cur.id = value;
    }
  }
  return events.map((e, i) => ({
    id: e.id || `cal_${i}`,
    date: e.date || '',
    title: e.title || '',
    location: e.location || '',
  }));
}

function unescapeIcs(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

// שם היומן מתוך ה-iCal (X-WR-CALNAME) — לשימוש במקרא ובצבעים
function icsCalendarName(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const m = unfolded.match(/^X-WR-CALNAME:(.+)$/mi);
  return m ? unescapeIcs(m[1]) : '';
}

// ריבוי חברות: לכל חברה קישורי iCal משלה (משתני סביבה נפרדים). כל חברה — היומנים שלה בלבד.
// תומך בכמה יומנים לחברה (עד 3 משתנים) וגם כמה כתובות מופרדות בפסיק בתוך כל אחד.
const ICAL_ENV = {
  co_bpm:  ['GOOGLE_ICAL_URL',      'GOOGLE_ICAL_URL_2',      'GOOGLE_ICAL_URL_3'],
  co_ofek: ['GOOGLE_OFEK_ICAL_URL', 'GOOGLE_OFEK_ICAL_URL_2', 'GOOGLE_OFEK_ICAL_URL_3'],
};
const DEFAULT_CO = 'co_bpm';
// קישורי iCal פר-חברה שהוזנו דרך לשונית החיבורים (נשמרים בבסיס הנתונים, נטענים לזיכרון בעלייה ובכל חיבור).
// עדיפות: משתני סביבה → ואם אין, הקישורים שהוזנו באתר לאותה חברה.
const _dbIcal = new Map(); // companyId -> [urls]
export function setDbIcal(companyId, urls) {
  const arr = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(s => String(s).trim()).filter(Boolean);
  if (arr.length) _dbIcal.set(companyId, arr); else _dbIcal.delete(companyId);
  delete _cache[companyId]; // ביטול מטמון היומן של החברה
}
function icalUrls(companyId = DEFAULT_CO) {
  const envs = (ICAL_ENV[companyId] || []).map(e => process.env[e]).filter(Boolean);
  const src = envs.length ? envs : (_dbIcal.get(companyId) || []);
  return src.flatMap(v => String(v).split(/[\s,]+/)).map(s => s.trim()).filter(Boolean);
}

// האם ליומן של חברה זו הוגדר קישור
export function hasCalendar(companyId = DEFAULT_CO) { return icalUrls(companyId).length > 0; }
// רשימת החברות שיש להן יומן מוגדר (לאימות אוטומטי בעליית שרת)
export function calendarCompanies() { return Object.keys(ICAL_ENV).filter(c => hasCalendar(c)); }

// מטמון בזיכרון פר-חברה: מונע הורדה+ניתוח מחדש של אלפי אירועים בכל בקשה.
const _cache = {}; // companyId -> { at, key, events }
const CACHE_TTL = 5 * 60 * 1000; // 5 דקות

// שליפת אירועים מכל היומנים של החברה דרך קישורי ה-iCal (ממוזגים יחד, עם מטמון פר-חברה)
export async function fetchCalendarEvents({ force = false, companyId = DEFAULT_CO } = {}) {
  const urls = icalUrls(companyId);
  if (!urls.length) throw new Error('לא הוגדר קישור iCal ליומן');
  const key = urls.join('|');
  const c = _cache[companyId];
  if (!force && c && c.events && c.key === key && Date.now() - c.at < CACHE_TTL) return c.events;
  const all = [];
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i]);
    if (!res.ok) throw new Error(`יומן ${i + 1} (iCal): ${res.status}`);
    const text = await res.text();
    const calName = icsCalendarName(text) || `יומן ${i + 1}`;
    parseIcs(text).forEach(e => all.push({ ...e, id: `c${i}_${e.id}`, calendarIndex: i, calendarName: calName }));
  }
  _cache[companyId] = { at: Date.now(), key, events: all };
  return all;
}

// בדיקת חיבור: מושך את כל היומנים של החברה ומוודא שכולם תקינים
export async function verify(companyId = DEFAULT_CO) {
  const urls = icalUrls(companyId);
  if (!urls.length) return { ok: false, error: 'לא הוזן קישור iCal' };
  try {
    let count = 0;
    for (let i = 0; i < urls.length; i++) {
      const res = await fetch(urls[i]);
      if (!res.ok) return { ok: false, error: `יומן ${i + 1}: סטטוס ${res.status}` };
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/.test(text)) return { ok: false, error: `יומן ${i + 1}: אינו קובץ iCal תקין` };
      count += parseIcs(text).length;
    }
    return { ok: true, count, calendars: urls.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default { matchEvents, fetchCalendarEvents, parseIcs, verify, hasCalendar };
