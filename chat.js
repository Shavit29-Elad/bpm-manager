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
- "priceSound": עלות הסאונד כמספר אם צוינה (למשל "אליאב - 1500" → 1500; "1800 סאונד + 400 דלק" → 2200). אחרת null.
- "employees": מערך שמות העובדים בלבד (בלי תפקידים/הערות). תקן שגיאות כתיב ברורות (למשל "אביעעד"→"אביעד").
- "employeeBonusRaw": טקסט חופשי שמתאר בונוסים/התאמות לעובדים (למשל "כפיר - כפולה, נתנאל - יומית רגילה" או "בונוס כפיר 250, נתנאל 350"). אם אין — null.
- "contractors": מערך אובייקטים {"name":"שם","amount":מספר או null} (למשל "סויסה - 7500" → {"name":"סויסה","amount":7500}; "קבלן שרון שאלתיאל 4500" → {"name":"שרון שאלתיאל","amount":4500}). אם אין — [].

החזר אך ורק מערך JSON. אם אין אירועים — [].

הטקסט:
${text}`;
  const raw = await complete(system, [{ role: 'user', content: prompt }], { maxTokens: 8000 });
  const arr = parseEventsJson(raw);
  globalThis.__lastExtractRaw = raw; // לצורך דיבוג בלבד
  const n = (v) => (v == null || v === '' || isNaN(+String(v).replace(/[^\d.\-]/g, ''))) ? null : +String(v).replace(/[^\d.\-]/g, '');
  return arr.map(e => {
    const ctr = Array.isArray(e.contractors) ? e.contractors.filter(c => c && c.name).map(c => ({ name: String(c.name).trim(), amount: n(c.amount) })) : [];
    return {
      date: e.date || null, dateRaw: e.date || null,
      artist: e.artist || null,
      price: n(e.price), priceRaw: e.price != null ? String(e.price) : null,
      location: e.location || null,
      sound: e.sound || null, priceSound: n(e.priceSound),
      employees: Array.isArray(e.employees) ? e.employees.map(x => String(x).trim()).filter(Boolean) : [],
      employeeBonusRaw: e.employeeBonusRaw || null,
      contractors: ctr.map(c => c.name),
      contractorDetails: ctr,
      confidence: 1, missingFields: [],
      source: 'whatsapp-ai',
    };
  }).filter(e => e.date || e.artist);
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
