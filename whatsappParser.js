// lib/whatsappParser.js
// מנתח הודעת אירוע בפורמט הקבוע של BPM לאובייקט מובנה.
// הפורמט (השדות יכולים להופיע בכל סדר, עם או בלי ניקוד/רווחים):
//   תאריך: ...
//   זמר: ...
//   תמחור: ...
//   מיקום: ...
//   סאונד: ...
//   עובדים: ...
//   תוספת לעובדים: ...
//   קבלן: ...

// מיפוי כותרות בעברית -> שם שדה באנגלית. כולל וריאציות נפוצות.
const FIELD_MAP = [
  { keys: ['תאריך'], field: 'dateRaw' },
  { keys: ['זמר', 'אמן', 'מופע'], field: 'artist' },
  { keys: ['תמחור', 'מחיר', 'תשלום ללקוח', 'סכום'], field: 'priceRaw' },
  { keys: ['מיקום', 'אולם', 'כתובת', 'עיר'], field: 'location' },
  { keys: ['סאונד', 'הגברה', 'sound'], field: 'sound' },
  { keys: ['עובדים', 'צוות'], field: 'employeesRaw' },
  { keys: ['תוספת לעובדים', 'תוספת עובדים', 'תוספת'], field: 'employeeBonusRaw' },
  { keys: ['קבלן', 'קבלנים', 'ספק'], field: 'contractorsRaw' },
];

function normalizeLine(line) {
  return line.replace(/‏|‎/g, '').trim(); // הסרת סימני כיווניות RTL/LTR
}

// מזהה את השדה לפי תחילת השורה "כותרת:"
function matchField(line) {
  const m = line.match(/^\s*\*?\s*([֐-׿'"\s]+?)\s*\*?\s*[:：]\s*(.*)$/);
  if (!m) return null;
  const label = m[1].replace(/[*"']/g, '').trim();
  const value = m[2].trim();
  for (const entry of FIELD_MAP) {
    if (entry.keys.some(k => label === k || label.startsWith(k))) {
      return { field: entry.field, value };
    }
  }
  return null;
}

// המרת רשימת שמות (עובדים/קבלנים) למערך. מפצל בפסיקים/שורות/סלאש/בולטים.
// לא מפצל על מקף כי לרוב הוא מפריד "תפקיד - שם" (למשל "תאורה - ליאור").
function splitNames(raw) {
  if (!raw) return [];
  return raw
    .split(/[,،\n\/•]|\sו(?=[֐-׿])|&/g)
    .map(s => s.trim())
    .filter(Boolean);
}

// פרסור תאריך גמיש: dd/mm/yyyy, dd.mm.yy, dd-mm וכו'. מחזיר ISO (yyyy-mm-dd) אם הצליח.
export function parseDate(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.\/\-]/g, ' ').trim();
  const m = cleaned.match(/(\d{1,2})[.\/\-](\d{1,2})(?:[.\/\-](\d{2,4}))?/);
  if (!m) return null;
  let [, d, mo, y] = m;
  d = parseInt(d, 10); mo = parseInt(mo, 10);
  let year = y ? parseInt(y, 10) : new Date().getFullYear();
  if (year < 100) year += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return iso;
}

// חילוץ מספר מתוך מחרוזת תמחור ("2500 ש\"ח", "2,500", "2500+מעמ")
export function parseAmount(raw) {
  if (!raw) return null;
  const includesVat = /כולל\s*מע|כולל מעמ/i.test(raw);
  const plusVat = /\+\s*מע|לפני\s*מע/i.test(raw);
  const num = raw.replace(/[^\d.]/g, (c, i) => (raw[i] === ',' ? '' : c));
  const cleaned = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!cleaned) return null;
  return { amount: parseFloat(cleaned[0]), includesVat, plusVat };
}

// הפונקציה הראשית: טקסט הודעה -> אובייקט אירוע (חלקי, לפני שיוך חברה/מזהה)
export function parseEventMessage(text) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const fields = {};
  for (const line of lines) {
    const match = matchField(line);
    if (match) fields[match.field] = match.value;
  }

  const date = parseDate(fields.dateRaw);
  const price = parseAmount(fields.priceRaw);

  const parsed = {
    date,
    dateRaw: fields.dateRaw || null,
    artist: fields.artist || null,
    price: price ? price.amount : null,
    priceIncludesVat: price ? price.includesVat : null,
    priceRaw: fields.priceRaw || null,
    location: fields.location || null,
    sound: fields.sound || null,
    employees: splitNames(fields.employeesRaw),
    employeeBonusRaw: fields.employeeBonusRaw || null,
    contractors: splitNames(fields.contractorsRaw),
    source: 'whatsapp',
    rawText: text,
  };

  // מדד ביטחון בסיסי: כמה שדות ליבה נקלטו
  const core = [parsed.date, parsed.artist, parsed.location, parsed.price];
  parsed.confidence = core.filter(Boolean).length / core.length;
  parsed.missingFields = [];
  if (!parsed.date) parsed.missingFields.push('תאריך');
  if (!parsed.artist) parsed.missingFields.push('זמר');
  if (!parsed.price) parsed.missingFields.push('תמחור');
  if (!parsed.location) parsed.missingFields.push('מיקום');

  return parsed;
}

// הודעה אחת עם כמה אירועים: מפצלים לפי שורת "תאריך:" (כל אירוע מתחיל בתאריך),
// גם אם יש שגיאת כתיב כמו "אתאריך:" — מנקים את הקידומת. מחזיר מערך אירועים.
export function parseEventMessages(text) {
  const lines = String(text || '').split(/\r?\n/);
  const isDateLine = (l) => /תאריך\s*[:：]/.test(l);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (isDateLine(line)) {
      if (cur) blocks.push(cur);
      cur = [line.replace(/^[^\n]*?(תאריך\s*[:：])/, '$1')]; // מנקה קידומת לפני "תאריך:"
    } else if (cur) {
      cur.push(line);
    }
    // שורות לפני התאריך הראשון — מתעלמים
  }
  if (cur) blocks.push(cur);
  const events = blocks
    .map(b => parseEventMessage(b.join('\n')))
    .filter(e => e.date || e.artist || e.priceRaw || e.location);
  // נפילה חיננית: אם לא זוהו בלוקים — מנתחים כאירוע יחיד
  return events.length ? events : [parseEventMessage(text)];
}
