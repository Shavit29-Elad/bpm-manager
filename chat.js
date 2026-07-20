// chat.js — שיחה עם דמויות הצוות. תומך בשני ספקים (בלי תלויות, fetch בלבד):
//   • Google Gemini (חינמי!)  — GEMINI_API_KEY   ← מומלץ, קל וחינם
//   • Anthropic Claude (בתשלום) — ANTHROPIC_API_KEY
// אם שניהם מוגדרים, Gemini קודם.

export function chatConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// --- Google Gemini (חינמי) ---
async function callGemini(system, messages, { maxTokens = 1200 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  // רשימת מודלים לניסיון (מהחדש לישן) — עמידה בפני שינויי שמות/פרישת מודלים
  const candidates = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-1.5-flash-latest'];
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  });
  let lastErr = '';
  for (const model of candidates) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = await res.text();
    if (res.status === 404 || res.status === 429) { lastErr = `(${res.status}) ${text.slice(0, 120)}`; continue; } // לא קיים/מכסה — ננסה את הבא
    if (!res.ok) throw new Error(`שגיאת צ'אט (${res.status}): ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהשירות'); }
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text).filter(Boolean).join('') || '(אין תשובה)';
  }
  throw new Error(`אף מודל Gemini לא זמין במפתח הזה. אפשר לקבוע GEMINI_MODEL ידנית. פרט: ${lastErr}`);
}

// --- Anthropic Claude (בתשלום) ---
async function callAnthropic(system, messages, { maxTokens = 1200 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  // רשימת מודלים לניסיון (מהחכם/עדכני לישן) — עמידה בפני שינויי שמות
  const candidates = process.env.CHAT_MODEL
    ? [process.env.CHAT_MODEL]
    : ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'];
  const bodyBase = { max_tokens: maxTokens, system, messages };
  let lastErr = '';
  for (const model of candidates) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, ...bodyBase }),
    });
    const text = await res.text();
    if (res.status === 404) { lastErr = `(404) ${text.slice(0, 120)}`; continue; } // מודל לא קיים — ננסה את הבא
    if (!res.ok) throw new Error(`שגיאת צ'אט (${res.status}): ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהשירות'); }
    return (data.content || []).map(c => c.text).filter(Boolean).join('') || '(אין תשובה)';
  }
  throw new Error(`אף מודל Claude לא זמין. אפשר לקבוע CHAT_MODEL ידנית. פרט: ${lastErr}`);
}

async function complete(system, messages, opts = {}) {
  if (!chatConfigured()) throw new Error('הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY (Claude) ב-Render');
  // עדיפות ל-Claude (ממשפחת Anthropic). Gemini רק כגיבוי אם אין מפתח Claude.
  return process.env.ANTHROPIC_API_KEY ? callAnthropic(system, messages, opts) : callGemini(system, messages, opts);
}

// שילוב הזיכרון המתמשך לתוך פרומפט המערכת של הדמות
function withMemory(member, memory) {
  if (!memory) return member.system;
  return `${member.system}\n\n## הזיכרון המתמשך שלך (מה שלמדת על העסק, המערכת וההעדפות של המנהל — השתמש/י בזה):\n${memory}`;
}

// צ'אט אישי (עם זיכרון)
export async function chatWithMember(member, history, memory = '') {
  return complete(withMemory(member, memory), history.map(m => ({ role: m.role, content: m.content })));
}

// צ'אט קבוצתי — כל חבר עונה בתורו על סמך תמלול השיחה (עם זיכרון)
export async function chatGroupReply(member, transcript, memory = '') {
  const content = `זו שיחה קבוצתית של צוות החברה (כמה עובדים וירטואליים + המנהל). התמלול עד כה:\n\n${transcript}\n\nהשב/י עכשיו כ${member.name} (${member.role}) בלבד — בקצרה, באופי שלך, ורק בתחום שלך. אם אין לך מה להוסיף, כתב/י משפט קצר. אל תדבר/י בשם אחרים.`;
  return complete(withMemory(member, memory), [{ role: 'user', content }]);
}

// סיכום שיחה כבקשת פיתוח מובנית (JSON)
export async function summarizeAsRequest(member, transcript) {
  const system = `אתה עוזר שממיר שיחה עם ${member.name} (${member.role}) לבקשת פיתוח מסודרת עבור מערכת הניהול. ענה אך ורק ב-JSON תקין, בלי טקסט נוסף.`;
  const prompt = `מתוך השיחה הבאה, נסח בקשת פיתוח אחת שמסכמת מה המנהל רוצה שיפותח או ישונה במערכת. החזר JSON בלבד במבנה המדויק:
{"title":"כותרת קצרה","summary":"משפט או שניים שמסבירים את הבקשה","details":["פרט או קריטריון קבלה 1","פרט 2"],"priority":"low|medium|high"}
אם אין בקשה ברורה בשיחה, קבע title ל"לא זוהתה בקשה ברורה".

השיחה:
${transcript}`;
  const raw = await complete(system, [{ role: 'user', content: prompt }]);
  try {
    const jsonStr = (raw.match(/\{[\s\S]*\}/) || [raw])[0];
    const out = JSON.parse(jsonStr);
    return {
      title: out.title || 'בקשת פיתוח',
      summary: out.summary || '',
      details: Array.isArray(out.details) ? out.details.filter(Boolean) : [],
      priority: ['low', 'medium', 'high'].includes(out.priority) ? out.priority : 'medium',
    };
  } catch {
    return { title: 'בקשת פיתוח', summary: raw.slice(0, 300), details: [], priority: 'medium' };
  }
}

// פענוח JSON עמיד: מסיר גדרות קוד, ואם המערך נחתך — משחזר את האובייקטים השלמים
function parseEventsJson(raw) {
  if (!raw) return [];
  let s = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { const a = JSON.parse(arrMatch[0]); if (Array.isArray(a)) return a; } catch { } }
  // שחזור: מפרקים כל אובייקט ברמה העליונה בנפרד (עמיד לחיתוך באמצע)
  const objs = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(s.slice(start, i + 1))); } catch { } start = -1; } }
  }
  return objs;
}

// חילוץ אירועים מהודעה (מובנית או חופשית) לרשימת אירועים מובנית — עם AI
export async function extractEvents(text, defaultYear) {
  const yr = defaultYear || new Date().getFullYear();
  const system = `אתה מנתח הודעות אירועים של חברת הגברה ותאורה (BPM). תפקידך להמיר טקסט למערך JSON של אירועים. ענה אך ורק ב-JSON תקין, בלי טקסט לפני או אחרי.`;
  const prompt = `הטקסט מכיל כמה אירועים — לפעמים בפורמט מובנה (תאריך:/זמר:/תמחור:/מיקום:/סאונד:/עובדים:/תוספת:/קבלן:) ולפעמים בפורמט חופשי (למשל: "6/7 שרית חדד אולמי אמארה 5500 עובדים אביעד נדב ומתניה בונוס 250"). חלץ כל אירוע בנפרד.

לכל אירוע החזר אובייקט עם השדות:
- "date": תאריך בפורמט YYYY-MM-DD. פענח "6/7" או "01.07.26" וכו'; אם השנה חסרה השתמש ב-${yr}.
- "artist": שם הזמר/המופע (אפשר לכלול "- גאגא בוקינג" אם מופיע).
- "price": מחיר האירוע ללקוח כמספר בלבד (בלי ש"ח/פסיקים). אם כתוב "אין"/"???"/"תשלום במזומן"/חסר — null.
- "location": מיקום/אולם.
- "sound": שם איש הסאונד או תיאור קצר (למשל "אליאב"). אם אין — null.
- "priceSound": עלות הסאונד כמספר אם צוינה. אחרת null.
- "priceBackline": עלות הבקליין (backline) כמספר אם צוינה. אחרת null.
- "priceLighting": עלות התאורה כמספר אם צוינה. אחרת null.

כללי תמחור חשובים (מאוד — פרש אותם בדיוק):
- "כפול X" אחרי סכום = הכפל את הסכום ב-X. דוגמאות: "סאונד 1800 כפול 1.5" → priceSound=2700 ; "בקליין 1200 כפול 1.5" → priceBackline=1800 ; "סאונד 2700 כפול 2" → priceSound=5400. ("כפול" מתייחס לסכום שלפניו באותה שורה).
- "בשתיהם" / "בשניהם" / "לשתיהם" / "בשלושתם" / "לכולם" / "בכולם" בשורת תמחור או קבלן = השורה הזו חלה על כל האירועים בהודעה (לא רק על האירוע האחרון). למשל "בקליין 1200 כפול 1.5 בשתיהם" → priceBackline=1800 לכל אחד מהאירועים בהודעה.
- שורת פריט (סאונד/בקליין/תאורה) שכוללת שם אדם והוא לא איש הסאונד המבצע אלא קבלן/ספק — למשל "סאונד אביב 2700" — פרש כך: priceSound=2700 והוסף את השם ל-contractors: {"name":"אביב","amount":null}. הסכום הוא מחיר הפריט, לא בהכרח התשלום לקבלן.
- שם עיר בשורה נפרדת או בסוף שורת הזמר (למשל "נסרין אילת" או שורה של "אילת") = location.

- "employees": מערך אובייקטים, אחד לכל עובד, במבנה: {"name":"שם", "factor":מספר, "bonus":מספר או null, "bonusFactor":מספר או null}. תקן שגיאות כתיב ברורות (למשל "אביעעד"→"אביעד").
  פענח את ההוראות על התשלום והבונוס לכל עובד:
  • factor = מכפיל התשלום ליום: יומית/רגיל=1, חצי יומית=0.5, כפולה=2. "תשלום חצי יומית" לעובד → factor=0.5.
  • "יומית וחצי" לעובד → factor=1 ו-bonusFactor=0.5 (יום עבודה מלא כבסיס + חצי יום כבונוס; לא factor=1.5). למשל שכר בסיס 600 → 600 בסיס + 300 בונוס.
  • bonus = בונוס בסכום קבוע בש"ח (מספר). "בונוס 250" → bonus=250.
  • bonusFactor = בונוס כשבר של יומית (יחושב מאוחר יותר לפי שכר הבסיס). "בונוס חצי יומית" → bonusFactor=0.5, "בונוס יומית" → bonusFactor=1.
  הוראות קבוצתיות חלות על כל העובדים המפורטים: "בונוס לשלושתם 250" / "בונוס לכולם 250" / "פלוס 250 לשלושתם" → bonus=250 לכל אחד; "בונוס חצי יומית לכולם" → bonusFactor=0.5 לכל אחד; "ללא בונוס"/"בלי בונוס" → bonus=0.
  אם אין הוראה מיוחדת לעובד — factor=1, bonus=null, bonusFactor=null.
- "employeeBonusRaw": הטקסט המקורי של ההערות על בונוסים (לתיעוד). אם אין — null.
- "contractors": מערך אובייקטים {"name":"שם","amount":מספר או null} (למשל "סויסה - 7500" → {"name":"סויסה","amount":7500}; "קבלן שרון שאלתיאל 4500" → {"name":"שרון שאלתיאל","amount":4500}). אם אין — [].

דוגמה מלאה (למד ממנה את ההיגיון):
טקסט:
"15.07.26
נסרין
אילת
סאונד אביב 2700
16.7.26
נסרין אילת
סאונד 1800 כפול 1.5
בקליין 1200 כפול 1.5 בשתיהם"
פלט נכון:
[
 {"date":"2026-07-15","artist":"נסרין","location":"אילת","priceSound":2700,"priceBackline":1800,"contractors":[{"name":"אביב","amount":null}]},
 {"date":"2026-07-16","artist":"נסרין","location":"אילת","priceSound":2700,"priceBackline":1800,"contractors":[]}
]
(שים לב: "כפול 1.5" הכפיל את 1800→2700 ואת 1200→1800; "בשתיהם" החיל את הבקליין 1800 על שני האירועים; "אביב" בשורת הסאונד נוסף כקבלן.)

החזר אך ורק מערך JSON. אם אין אירועים — [].

הטקסט:
${text}`;
  const raw = await complete(system, [{ role: 'user', content: prompt }], { maxTokens: 8000 });
  const arr = parseEventsJson(raw);
  globalThis.__lastExtractRaw = raw; // לצורך דיבוג בלבד
  const n = (v) => (v == null || v === '' || isNaN(+String(v).replace(/[^\d.\-]/g, ''))) ? null : +String(v).replace(/[^\d.\-]/g, '');
  return arr.map(e => {
    const ctr = Array.isArray(e.contractors) ? e.contractors.filter(c => c && c.name).map(c => ({ name: String(c.name).trim(), amount: n(c.amount) })) : [];
    // עובדים: תומך גם במבנה חדש (אובייקטים עם factor/bonus/bonusFactor) וגם בשמות בלבד (תאימות)
    const emps = Array.isArray(e.employees)
      ? e.employees.map(w => (typeof w === 'string' ? { name: w } : w)).filter(w => w && w.name)
        .map(w => ({ name: String(w.name).trim(), factor: (w.factor == null || w.factor === '') ? 1 : +w.factor, bonus: n(w.bonus), bonusFactor: n(w.bonusFactor), food: null, note: null }))
      : [];
    return {
      date: e.date || null, dateRaw: e.date || null,
      artist: e.artist || null,
      price: n(e.price), priceRaw: e.price != null ? String(e.price) : null,
      location: e.location || null,
      sound: e.sound || null, priceSound: n(e.priceSound),
      priceBackline: n(e.priceBackline), priceLighting: n(e.priceLighting),
      employees: emps.map(w => w.name),
      employeeDetails: emps,
      employeeBonusRaw: e.employeeBonusRaw || null,
      contractors: ctr.map(c => c.name),
      contractorDetails: ctr,
      confidence: 1, missingFields: [],
      source: 'whatsapp-ai',
    };
  }).filter(e => e.date || e.artist);
}

// פירוש הוראת בונוס/תשלום חופשית והחלתה על עובדים ספציפיים (בעריכה ידנית)
export async function interpretBonuses(note, names) {
  if (!note || !Array.isArray(names) || !names.length) return [];
  const system = `אתה עוזר שמפרש הוראות בונוס/תשלום לעובדים בחברת הגברה ותאורה. ענה אך ורק ב-JSON תקין, בלי טקסט נוסף.`;
  const prompt = `העובדים באירוע: ${names.join(', ')}.
ההוראה שנכתבה: "${note}".
החזר מערך JSON, אובייקט לכל עובד שההוראה חלה עליו, במבנה: {"name":"שם מדויק כפי שמופיע ברשימה","bonus":מספר או null,"bonusFactor":מספר או null,"factor":מספר או null}.
כללים:
- "בונוס X לשניהם/לשלושתם/לכולם/לכולן" או "פלוס X לכולם" → bonus:X לכל העובדים ברשימה.
- "בונוס X ל<שם>" → bonus:X רק לאותו עובד.
- "בונוס חצי יומית" → bonusFactor:0.5 (לכל מי שההוראה חלה עליו). "בונוס יומית" → bonusFactor:1.
- "תשלום חצי יומית" → factor:0.5. "כפולה" → factor:2.
- "יומית וחצי" → factor:1 ו-bonusFactor:0.5 (יום מלא כבסיס + חצי יום כבונוס; לא factor:1.5).
- "ללא בונוס" / "בלי בונוס" / "אין בונוס" → bonus:0 (מאפס את הבונוס) לעובדים הרלוונטיים.
- כלול רק עובדים שההוראה חלה עליהם, ורק שדות רלוונטיים (השאר null). אם אין הוראה תקפה — החזר [].`;
  try {
    const raw = await complete(system, [{ role: 'user', content: prompt }], { maxTokens: 1000 });
    const arr = parseEventsJson(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ===== קליטת חשבונית ספק עם AI — קורא את ה-PDF/תמונה ומחלץ את השדות =====
// קריאה מולטימודלית ל-Claude (מסמך/תמונה) — עם fallback למודלים
async function callAnthropicVision(system, contentBlocks, { maxTokens = 900 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  const candidates = process.env.VISION_MODEL
    ? [process.env.VISION_MODEL]
    : ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest'];
  let lastErr = '';
  for (const model of candidates) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: contentBlocks }] }),
    });
    const text = await res.text();
    if (res.status === 404) { lastErr = `(404) ${text.slice(0, 120)}`; continue; }
    if (!res.ok) throw new Error(`שגיאת AI (${res.status}): ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מ-AI'); }
    return (data.content || []).map(c => c.text).filter(Boolean).join('');
  }
  throw new Error(`אף מודל Claude זמין לקריאת מסמכים. פרט: ${lastErr}`);
}
// קריאה מולטימודלית ל-Gemini (גיבוי)
async function callGeminiVision(system, prompt, fileBase64, mime, { maxTokens = 900 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  const candidates = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime || 'application/pdf', data: fileBase64 } }, { text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
  });
  let lastErr = '';
  for (const model of candidates) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = await res.text();
    if (res.status === 404 || res.status === 429) { lastErr = `(${res.status})`; continue; }
    if (!res.ok) throw new Error(`שגיאת AI (${res.status}): ${text.slice(0, 300)}`);
    let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מ-AI'); }
    return (data.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
  }
  throw new Error(`אף מודל Gemini זמין לקריאת מסמכים. פרט: ${lastErr}`);
}
// חילוץ שדות חשבונית ספק מקובץ (PDF/תמונה) והתאמה לספק קיים
// זיהוי סוג הקובץ מהבייטים עצמם (base64) — כדי לספק media_type תקין ל-Anthropic/Gemini
// (חשבונית ירוקה מחזירה לפעמים content-type כללי כמו application/octet-stream או image/jpg שנדחים)
function sniffMediaType(base64, fallback) {
  const h = String(base64 || '').slice(0, 16);
  if (h.startsWith('JVBER')) return 'application/pdf';       // %PDF
  if (h.startsWith('iVBORw0KGgo')) return 'image/png';       // \x89PNG
  if (h.startsWith('/9j/')) return 'image/jpeg';             // JPEG
  if (h.startsWith('R0lGOD')) return 'image/gif';            // GIF
  if (h.startsWith('UklGR')) return 'image/webp';            // RIFF/WEBP
  const f = String(fallback || '').toLowerCase();
  if (f.includes('pdf')) return 'application/pdf';
  if (f.includes('png')) return 'image/png';
  if (f.includes('gif')) return 'image/gif';
  if (f.includes('webp')) return 'image/webp';
  if (f.includes('jp')) return 'image/jpeg';                 // jpg/jpeg
  return 'image/jpeg';
}

export async function extractInvoiceFields(fileBase64, mime, suppliers = []) {
  if (!chatConfigured()) throw new Error('AI לא מוגדר (חסר ANTHROPIC_API_KEY או GEMINI_API_KEY)');
  const mediaType = sniffMediaType(fileBase64, mime);
  const supList = (suppliers || []).slice(0, 500)
    .map(s => `${s.id}\t${s.name}${s.taxId ? ' | ח.פ ' + s.taxId : ''}`).join('\n');
  const system = 'אתה מומחה לקריאת חשבוניות ספק ישראליות (הוצאות). אתה מחלץ נתונים במדויק ומחזיר JSON תקין בלבד, בלי טקסט לפני או אחרי.';
  const prompt = `זוהי חשבונית/קבלה של ספק (מסמך הוצאה של העסק). קרא את המסמך וחלץ את הנתונים.
החזר אך ורק JSON במבנה המדויק:
{"supplierName":"שם הספק המנפיק","taxId":"ח.פ/עוסק מורשה של הספק (ספרות בלבד) או ריק","supplierPhone":"טלפון הספק או ריק","supplierEmail":"אימייל הספק או ריק","supplierContact":"שם איש קשר אצל הספק או ריק","invoiceNumber":"מספר המסמך/חשבונית","allocationNumber":"מספר הקצאה של רשות המסים אם מופיע (בדרך כלל 9 ספרות) או ריק","date":"YYYY-MM-DD","documentType":305,"amountInclVat":0,"amountExclVat":0,"vat":0,"description":"תיאור קצר של ההוצאה","supplierId":""}

כללים:
- documentType: 305=חשבונית מס, 320=חשבונית מס/קבלה, 400=קבלה, 20=חשבון עסקה/דרישת תשלום. בחר לפי כותרת המסמך.
- amountInclVat = הסכום הכולל לתשלום (כולל מע"מ). amountExclVat = הסכום לפני מע"מ. vat = סכום המע"מ. אם רק חלק מהם מופיע — חשב את השאר (מע"מ בישראל 18%). כל הסכומים כמספרים בלבד.
- הספק הוא מי שהנפיק את החשבונית (לא "בי פי אם" שהוא הלקוח/מקבל).
- supplierPhone/supplierEmail/supplierContact = פרטי הקשר של הספק המנפיק כפי שמופיעים על המסמך (טלפון, אימייל, איש קשר). אם לא מופיע — ריק.
- אם הספק תואם לאחד מהרשימה למטה (לפי שם או ח.פ), החזר את ה-id שלו ב-supplierId. אחרת supplierId ריק.
- אם שדה לא נמצא — החזר ריק ("") למחרוזות ו-0 למספרים.

רשימת ספקים קיימים (id<TAB>שם | ח.פ):
${supList || '(אין)'}`;

  let raw;
  if (process.env.ANTHROPIC_API_KEY) {
    const isPdf = mediaType === 'application/pdf';
    const block = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };
    raw = await callAnthropicVision(system, [block, { type: 'text', text: prompt }]);
  } else {
    raw = await callGeminiVision(system, prompt, fileBase64, mediaType);
  }
  const jsonStr = (String(raw).replace(/```json/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || ['{}'])[0];
  let out; try { out = JSON.parse(jsonStr); } catch { throw new Error('ה-AI לא החזיר נתונים תקינים'); }
  const num = (v) => { const n = +String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); return isNaN(n) ? 0 : n; };
  let incl = num(out.amountInclVat), net = num(out.amountExclVat), vat = num(out.vat);
  if (incl && !net) net = +(incl / 1.18).toFixed(2);
  if (incl && !vat) vat = +(incl - net).toFixed(2);
  if (!incl && net && vat) incl = +(net + vat).toFixed(2);
  // ודא שהספק שהוחזר קיים באמת ברשימה; אחרת התאמה לפי ח.פ/שם
  let supplierId = out.supplierId && (suppliers || []).some(s => String(s.id) === String(out.supplierId)) ? String(out.supplierId) : '';
  if (!supplierId && out.taxId) { const m = (suppliers || []).find(s => s.taxId && String(s.taxId).replace(/\D/g, '') === String(out.taxId).replace(/\D/g, '')); if (m) supplierId = String(m.id); }
  if (!supplierId && out.supplierName) { const nm = String(out.supplierName).trim(); const m = (suppliers || []).find(s => s.name && (s.name === nm || s.name.includes(nm) || nm.includes(s.name))); if (m) supplierId = String(m.id); }
  return {
    supplierId,
    supplierName: String(out.supplierName || '').trim(),
    taxId: String(out.taxId || '').replace(/[^\d]/g, ''),
    supplierPhone: String(out.supplierPhone || '').trim(),
    supplierEmail: String(out.supplierEmail || '').trim(),
    supplierContact: String(out.supplierContact || '').trim(),
    invoiceNumber: String(out.invoiceNumber || '').trim(),
    allocationNumber: String(out.allocationNumber || '').replace(/[^\d]/g, ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '',
    documentType: [20, 305, 320, 400].includes(+out.documentType) ? +out.documentType : 305,
    amountInclVat: incl || 0,
    amountExcludeVat: net || 0,
    vat: vat || 0,
    description: String(out.description || '').trim(),
  };
}

// למידה: מפיק "עובדות לזכור" מתוך חילופי ההודעות האחרונים (לזיכרון המתמשך)
export async function learnFromExchange(member, exchangeText) {
  const system = `אתה עוזר שמתחזק זיכרון ארוך-טווח עבור ${member.name} (${member.role}). מטרתך לזקק עובדות/העדפות/החלטות יציבות ששווה לזכור לטווח ארוך.`;
  const prompt = `מתוך חילופי ההודעות הבאים, כתוב 0–2 נקודות תמציתיות (שורה כל אחת) של מידע חדש ויציב ששווה לזכור על העסק/המערכת/העדפות המנהל. אל תכלול דברים חד-פעמיים או טריוויאליים. אם אין מה לזכור, כתוב בדיוק: אין\n\n${exchangeText}`;
  try {
    const out = (await complete(system, [{ role: 'user', content: prompt }])).trim();
    if (!out || out === 'אין' || out.length > 500) return '';
    return out;
  } catch { return ''; }
}
