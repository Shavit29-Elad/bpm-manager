// lib/googleCalendar.js
// שליפת אירועים מיומן גוגל של החברה, והצלבה מול אירועי ווטסאפ כדי לזהות
// מה התפספס פה או שם.
//
// אימות: Access Token של גוגל (OAuth) במשתנה סביבה GOOGLE_ACCESS_TOKEN,
// או חיבור דרך מחבר Google Calendar. הפונקציה matchEvents לא תלויה ב-API
// ולכן ניתנת לבדיקה מלאה גם בלי חיבור.

function normalize(str) {
  return (str || '').toLowerCase().replace(/["'’.,\-()]/g, '').replace(/\s+/g, ' ').trim();
}

// דמיון פשוט בין שני שמות (האם אחד מכיל את השני / חפיפת מילים)
function nameSimilar(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const wa = new Set(na.split(' ')), wb = nb.split(' ');
  const hits = wb.filter(w => wa.has(w)).length;
  return hits / Math.max(wa.size, wb.length);
}

// הצלבה: whatsappEvents[] מול calendarEvents[]. מחזיר התאמות + מה חסר בכל צד.
// calendarEvents פריט: { id, date (yyyy-mm-dd), title, location }
export function matchEvents(whatsappEvents, calendarEvents) {
  const matched = [];
  const usedCal = new Set();

  for (const wa of whatsappEvents) {
    let best = null, bestScore = 0;
    for (const cal of calendarEvents) {
      if (usedCal.has(cal.id)) continue;
      if (wa.date && cal.date && wa.date !== cal.date) continue; // חייב אותו תאריך
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

// שליפה אמיתית מיומן גוגל (כשיש Access Token)
export async function fetchCalendarEvents({ calendarId = 'primary', timeMin, timeMax } = {}) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error('חסר GOOGLE_ACCESS_TOKEN לחיבור יומן גוגל');
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  if (timeMin) url.searchParams.set('timeMin', timeMin);
  if (timeMax) url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`יומן גוגל: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.items || []).map(it => ({
    id: it.id,
    date: (it.start?.date || it.start?.dateTime || '').slice(0, 10),
    title: it.summary || '',
    location: it.location || '',
  }));
}

// בדיקת חיבור אמיתית: מנסה למשוך את רשימת היומנים
export async function verify() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'לא הוזן Access Token' };
  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default { matchEvents, fetchCalendarEvents, verify };
