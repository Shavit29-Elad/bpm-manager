// lib/pdfDesc.js
// חילוץ "פירוט" (תיאור) מתוך מסמך פייפרלס. הקבצים מאוחסנים ב-S3 (ללא מגבלת-קצב של פייפרלס).
// • PDF טקסטואלי → חילוץ טקסט (pdf-parse) + בחירת שורות התיאור.
// • תמונה סרוקה (jpg/png) → לא נתמך אוטומטית (צריך OCR) → status 'image'.
// הטעינה של pdf-parse היא דינמית ואופציונלית — אם החבילה חסרה, לא מפילים את השרת.

let _parser = null, _parserTried = false;
async function getParser() {
  if (_parserTried) return _parser;
  _parserTried = true;
  // מייבאים ישירות את הלוגיקה הפנימית (pdf-parse/lib/...) כדי לעקוף בלוק-דיבאג בכניסה הראשית שקורא קובץ-בדיקה וקורס.
  try { const m = await import('pdf-parse/lib/pdf-parse.js'); _parser = m.default || m; }
  catch { try { const m2 = await import('pdf-parse'); _parser = m2.default || m2; } catch { _parser = null; } }
  return _parser;
}

const isImage = (url) => /\.(jpe?g|png|gif|tiff?|bmp|heic)(\?|$)/i.test(String(url || ''));

// שורות "רעש" שאינן תיאור המסמך — שם עוסק, כותרות, סכומים, פרטי קשר וכו'.
const NOISE = [
  /עוסק\s*מורשה/, /ח\.?פ\.?/, /ע\.?מ\.?/, /^מע["׳']?מ/, /סה["׳']?כ/, /לתשלום/, /תאריך/,
  /חשבונית/, /קבלה/, /הצעת\s*מחיר/, /חשבון\s*עסקה/, /מספר\s*מסמך/, /אסמכתא/, /הקצאה/,
  /^\s*כמות\s*/, /מחיר/, /יח["׳']?/, /טלפון|נייד|פקס|דוא["׳']?ל|מייל|כתובת|רח['׳]/, /www\.|@|\.co\.il|\.com/,
  /^סכום/, /^ביניים/, /^הנחה/, /^עמלה/, /^יתרה/, /^שולם/,
];
const hasHebrew = (s) => /[֐-׿]/.test(s);

// בחירת שורות התיאור מתוך טקסט המסמך. שומרים גם raw (מקוצר) לצורך כוונון עתידי.
function pickDescription(text, clientName) {
  const clean = String(text || '').replace(/\r/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const cn = String(clientName || '').trim();
  const cand = [];
  for (const l of lines) {
    if (!hasHebrew(l)) continue;                 // רק שורות עם עברית
    if (l.length < 3 || l.length > 140) continue;
    if (cn && l.includes(cn)) continue;          // שם הלקוח/העוסק — לא תיאור
    if (/^\d[\d.,\s₪%-]*$/.test(l)) continue;    // שורת מספרים בלבד
    if (NOISE.some(re => re.test(l))) continue;
    cand.push(l);
  }
  // שורות התיאור הן בדרך כלל שורות הפריטים — ניקח עד 3 הראשונות המשמעותיות
  const desc = cand.slice(0, 3).join(' · ').trim();
  return desc;
}

// מחלץ פירוט ממסמך לפי ה-URL. מחזיר { status, desc, raw }.
//   status: 'ok' | 'image' | 'empty' | 'unavailable' | 'error' | 'none'
export async function extractDescription(url, clientName) {
  if (!url) return { status: 'none' };
  if (isImage(url)) return { status: 'image' };
  const parser = await getParser();
  if (!parser) return { status: 'unavailable' };
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: 'error' };
    const buf = Buffer.from(await res.arrayBuffer());
    const data = await parser(buf);
    const text = (data && data.text) || '';
    const desc = pickDescription(text, clientName);
    const raw = text.replace(/\s+/g, ' ').trim().slice(0, 400);   // לשמירה/אבחון בלבד
    return desc ? { status: 'ok', desc, raw } : { status: 'empty', raw };
  } catch { return { status: 'error' }; }
}

export default { extractDescription };
