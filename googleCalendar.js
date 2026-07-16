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

// הצלבה בין אירועי ווטסאפ לאירועי יומן
export function matchEvents(whatsappEvents, calendarEvents) {
  const matched = [];
  const usedCal = new Set();
  for (const wa of whatsappEvents) {
    let best = null, bestScore = 0;
    for (const cal of calendarEvents) {
      if (usedCal.has(cal.id)) continue;
      if (wa.date && cal.date && wa.date !== cal.date) continue;
      const score = Math.max(
        nameSimilar(wa.artist, cal.title),
        nameSimilar(wa.location, cal.location),
        nameSimilar(wa.location, cal.title),
      );
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

// תומך בכמה יומנים: משתנים נפרדים GOOGLE_ICAL_URL / _URL_2 / _URL_3,
// וגם כמה כתובות מופרדות בפסיק בתוך כל אחד (גמישות מלאה).
function icalUrls() {
  return [process.env.GOOGLE_ICAL_URL, process.env.GOOGLE_ICAL_URL_2, process.env.GOOGLE_ICAL_URL_3]
    .filter(Boolean)
    .flatMap(v => v.split(/[\s,]+/))
    .map(s => s.trim()).filter(Boolean);
}

// האם יומן כלשהו הוגדר
export function hasCalendar() { return icalUrls().length > 0; }

// מטמון בזיכרון: מונע הורדה+ניתוח מחדש של אלפי אירועים בכל בקשה.
let _cache = { at: 0, key: '', events: null };
const CACHE_TTL = 5 * 60 * 1000; // 5 דקות

// שליפת אירועים מכל היומנים דרך קישורי ה-iCal (ממוזגים יחד, עם מטמון)
export async function fetchCalendarEvents({ force = false } = {}) {
  const urls = icalUrls();
  if (!urls.length) throw new Error('לא הוגדר קישור iCal ליומן (GOOGLE_ICAL_URL)');
  const key = urls.join('|');
  if (!force && _cache.events && _cache.key === key && Date.now() - _cache.at < CACHE_TTL) {
    return _cache.events;
  }
  const all = [];
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i]);
    if (!res.ok) throw new Error(`יומן ${i + 1} (iCal): ${res.status}`);
    const text = await res.text();
    parseIcs(text).forEach(e => all.push({ ...e, id: `c${i}_${e.id}`, calendarIndex: i }));
  }
  _cache = { at: Date.now(), key, events: all };
  return all;
}

// בדיקת חיבור: מושך את כל היומנים ומוודא שכולם תקינים
export async function verify() {
  const urls = icalUrls();
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
