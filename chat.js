// ---- מדידת שימוש: כל קריאה ל-Anthropic מדווחת טוקנים; אוספים אותם כדי לדעת לאן הולך הכסף ----
// המחירים לפי מיליון טוקנים (מחירון Anthropic). cacheRead זול פי 10 מ-input רגיל.
const PRICES = {
  'claude-sonnet-5':            { in: 3,    out: 15,  cacheW: 3.75,  cacheR: 0.30 },
  'claude-haiku-4-5-20251001':  { in: 1,    out: 5,   cacheW: 1.25,  cacheR: 0.10 },
  'claude-3-5-sonnet-20241022': { in: 3,    out: 15,  cacheW: 3.75,  cacheR: 0.30 },
};
export const aiUsage = { calls: 0, byLabel: {}, since: new Date().toISOString() };
function trackUsage(label, model, u) {
  if (!u) return;
  const i = Number(u.input_tokens) || 0, o = Number(u.output_tokens) || 0;
  const cw = Number(u.cache_creation_input_tokens) || 0, cr = Number(u.cache_read_input_tokens) || 0;
  const p = PRICES[model] || PRICES['claude-sonnet-5'];
  const cost = (i * p.in + o * p.out + cw * p.cacheW + cr * p.cacheR) / 1e6;
  const e = aiUsage.byLabel[label] || (aiUsage.byLabel[label] = { calls: 0, in: 0, out: 0, cacheW: 0, cacheR: 0, cost: 0, model });
  e.calls++; e.in += i; e.out += o; e.cacheW += cw; e.cacheR += cr; e.cost += cost; e.model = model;
  aiUsage.calls++;
  console.log(`[ai] ${label} · ${model} · in ${i} out ${o}${cr ? ` cacheR ${cr}` : ''}${cw ? ` cacheW ${cw}` : ''} · $${cost.toFixed(4)}`);
}

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
    : ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-pro-latest'];
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
async function callAnthropic(system, messages, { maxTokens = 1200, label = 'chat' } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  // Haiku ראשון: לצ'אט הפנימי ולחילוץ הוא מספיק לחלוטין ועולה פי 3 פחות מ-Sonnet.
  // Sonnet נשאר כגיבוי אם Haiku לא זמין.
  const candidates = process.env.CHAT_MODEL
    ? [process.env.CHAT_MODEL]
    : ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022'];
  // ההקשר הקבוע (אופי הדמות + מפת המערכת + הזיכרון) חוזר זהה בכל הודעה — ~3,800 טוקנים.
  // cache_control מסמן אותו לשמירה במטמון; קריאה חוזרת ממנו עולה עשירית ממחיר input רגיל.
  const sysBlocks = (typeof system === 'string' && system.length > 2000)
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;
  const bodyBase = { max_tokens: maxTokens, system: sysBlocks, messages };
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
    trackUsage(label, model, data.usage);
    return (data.content || []).map(c => c.text).filter(Boolean).join('') || '(אין תשובה)';
  }
  throw new Error(`אף מודל Claude לא זמין. אפשר לקבוע CHAT_MODEL ידנית. פרט: ${lastErr}`);
}

async function complete(system, messages, opts = {}) {
  if (!chatConfigured()) throw new Error('הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY (Claude) ב-Render');
  // עדיפות ל-Claude (ממשפחת Anthropic). Gemini רק כגיבוי אם אין מפתח Claude.
  return process.env.ANTHROPIC_API_KEY ? callAnthropic(system, messages, opts) : callGemini(system, messages, opts);
}

// שילוב מפת האפליקציה (מעודכנת) + הזיכרון המתמשך לתוך פרומפט המערכת של הדמות
const CHAT_HISTORY_LIMIT = 20;   // כמה הודעות אחרונות נשלחות למודל
function withContext(member, memory, appMap) {
  let sys = member.system;
  if (appMap) sys += `\n\n${appMap}`;
  if (memory) sys += `\n\n## הזיכרון המתמשך שלך (מה שלמדת על העסק, המערכת וההעדפות של המנהל — השתמש/י בזה):\n${memory}`;
  return sys;
}

// צ'אט אישי (עם מפת אפליקציה + זיכרון)
export async function chatWithMember(member, history, memory = '', appMap = '') {
  // חיתוך היסטוריה: כל הודעה שלחה מחדש את *כל* השיחה מתחילתה, בלי גבול.
  // 20 ההודעות האחרונות מספיקות להקשר ועוצרות צמיחה אינסופית של העלות.
  const recent = history.slice(-CHAT_HISTORY_LIMIT);
  return complete(withContext(member, memory, appMap), recent.map(m => ({ role: m.role, content: m.content })), { label: 'chat' });
}

// צ'אט קבוצתי — כל חבר עונה בתורו על סמך תמלול השיחה (עם מפת אפליקציה + זיכרון)
export async function chatGroupReply(member, transcript, memory = '', appMap = '') {
  const content = `זו שיחה קבוצתית של צוות החברה (כמה עובדים וירטואליים + המנהל). התמלול עד כה:\n\n${transcript}\n\nהשב/י עכשיו כ${member.name} (${member.role}) בלבד — בקצרה, באופי שלך, ורק בתחום שלך. אם אין לך מה להוסיף, כתב/י משפט קצר. אל תדבר/י בשם אחרים.`;
  return complete(withContext(member, memory, appMap), [{ role: 'user', content }], { label: 'chat-group' });
}

// צ'אט אישי עם צילום מסך — המנהל מראה למעצבת מסך מהמערכת, והיא מנתחת אותו (ראייה ממוחשבת)
export async function chatWithMemberVision(member, history, memory = '', appMap = '', image = {}, userText = '') {
  const system = withContext(member, memory, appMap);
  const recent = (history || []).slice(-8, -1).map(m => `${m.role === 'user' ? 'מנהל' : member.name}: ${m.content}`).join('\n');
  const prompt = `${recent ? 'הקשר השיחה עד כה:\n' + recent + '\n\n' : ''}המנהל שלח צילום מסך מהמערכת (asfinance.co.il). ${userText ? 'הודעתו: ' + userText : 'נתחי אותו כמעצבת מוצר — מה את רואה, מה עובד טוב, ומה היית משפרת. תני המלצות קונקרטיות (צבעים, מרווחים, היררכיה) ובר-יישום.'}`;
  const media = image.mime || 'image/png';
  const data = image.data || '';
  if (process.env.ANTHROPIC_API_KEY) {
    const isPdf = media === 'application/pdf';
    const block = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: media, data } };
    return callAnthropicVision(system, [block, { type: 'text', text: prompt }], { maxTokens: 1300 });
  }
  return callGeminiVision(system, prompt, data, media, { maxTokens: 1300 });
}

// סיכום שיחה כבקשת פיתוח מובנית (JSON)
export async function summarizeAsRequest(member, transcript) {
  const system = `אתה עוזר שממיר שיחה עם ${member.name} (${member.role}) לבקשת פיתוח מסודרת עבור מערכת הניהול. ענה אך ורק ב-JSON תקין, בלי טקסט נוסף.`;
  const prompt = `מתוך השיחה הבאה, נסח בקשת פיתוח אחת שמסכמת מה המנהל רוצה שיפותח או ישונה במערכת. החזר JSON בלבד במבנה המדויק:
{"title":"כותרת קצרה","summary":"משפט או שניים שמסבירים את הבקשה","details":["פרט או קריטריון קבלה 1","פרט 2"],"priority":"low|medium|high"}
אם אין בקשה ברורה בשיחה, קבע title ל"לא זוהתה בקשה ברורה".

השיחה:
${transcript}`;
  const raw = await complete(system, [{ role: 'user', content: prompt }], { label: 'summarize' });
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
  const prompt = `הטקסט מכיל כמה אירועים — לפעמים בפורמט מובנה ולפעמים בפורמט חופשי. הכותרות יכולות להיות מופרדות ב**נקודתיים** (תאריך:) או ב**מקף** (תאריך - ...). חלץ כל אירוע בנפרד.
פורמט מובנה נפוץ א' (BPM): תאריך:/זמר:/תמחור:/מיקום:/סאונד:/עובדים:/תוספת:/קבלן:
פורמט מובנה נפוץ ב' (אופק, עם מקף): שורת כותרת "*הגברה*" בתחילת האירוע, ואז — "תאריך - / שם אמן - / מיקום - / תמחור - / עובדים - / קבלן - / איש קשר -".
פורמט חופשי (למשל: "6/7 שרית חדד אולמי אמארה 5500 עובדים אביעד נדב ומתניה בונוס 250").

לכל אירוע החזר אובייקט עם השדות:
- "date": תאריך בפורמט YYYY-MM-DD. פענח "6/7" או "01.07.26" או "5.8" וכו'; אם השנה חסרה השתמש ב-${yr}.
- "artist": שם הזמר/המופע (מהשדה "זמר" או "שם אמן"; אפשר לכלול "- גאגא בוקינג" אם מופיע).
- "contact": תוכן השדה "איש קשר" אם קיים (שם האדם/החברה שאליו מפיקים חשבונית). אם אין — null. אל תמציא.
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
  const raw = await complete(system, [{ role: 'user', content: prompt }], { maxTokens: 8000, label: 'extract-events' });
  const arr = parseEventsJson(raw);
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
      contact: (e.contact && String(e.contact).trim()) || null,
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
- "כולל X" / "סה״כ X" / "ביחד X" → X הוא **הסך הכולל לעובד** (יומית + בונוס), לא הבונוס. החזר bonus:X והשרת יחסר את היומית.
- "ללא בונוס" / "בלי בונוס" / "אין בונוס" → bonus:0 (מאפס את הבונוס) לעובדים הרלוונטיים.
- כלול רק עובדים שההוראה חלה עליהם, ורק שדות רלוונטיים (השאר null). אם אין הוראה תקפה — החזר [].`;
  try {
    const raw = await complete(system, [{ role: 'user', content: prompt }], { maxTokens: 1000, label: 'bonuses' });
    const arr = parseEventsJson(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ===== קליטת חשבונית ספק עם AI — קורא את ה-PDF/תמונה ומחלץ את השדות =====
// כשמזוהה ש-Claude ללא קרדיט/הרשאה — מדלגים עליו זמנית וניגשים ישר ל-Gemini (חוסך קריאה מיותרת פר-מסמך ולוגים).
let _claudeOutUntil = 0, _claudeOutReason = '';
// קריאה מולטימודלית ל-Claude (מסמך/תמונה) — עם fallback למודלים
async function callAnthropicVision(system, contentBlocks, opts = {}) {
  const { maxTokens = 900 } = opts;
  const key = process.env.ANTHROPIC_API_KEY;
  // מהירות: Haiku ראשון — מודל מהיר וזול שמספיק לחילוץ שדות מחשבונית; Sonnet רק כגיבוי אם Haiku נכשל.
  const candidates = process.env.VISION_MODEL
    ? [process.env.VISION_MODEL]
    : ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022'];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr = '';
  for (const model of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {   // פחות ניסיונות → מעבר מהיר למודל הבא/Gemini במקום המתנות ארוכות
      let res, text;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: contentBlocks }] }),
        });
        text = await res.text();
      } catch (e) { lastErr = 'network: ' + e.message; await sleep(1000 * (attempt + 1)); continue; } // שגיאת רשת — ניסיון חוזר
      if (res.status === 404) { lastErr = `(404) ${text.slice(0, 120)}`; break; } // מודל לא קיים — למודל הבא
      // הגבלת קצב (429) / עומס (529) / שגיאות שרת זמניות — המתנה קצרה עם backoff; אחרי ניסיון אחד עוברים למודל הבא
      if (res.status === 429 || res.status === 529 || res.status === 500 || res.status === 502 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = (ra > 0 ? Math.min(ra * 1000, 6000) : 0) || Math.min(6000, 1500 * Math.pow(2, attempt));
        lastErr = `(${res.status}) rate/overload`;
        if (attempt >= 1) break;   // כבר חיכינו פעם — לא לתקוע; נעבור למודל הבא
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        // אין קרדיט / הרשאה — אין טעם לנסות מודלים נוספים או מסמכים נוספים ב-Claude; מדלגים עליו ל-15 דק' ועוברים ל-Gemini
        if ((res.status === 400 && /credit balance is too low/i.test(text)) || res.status === 401 || res.status === 403) {
          _claudeOutUntil = Date.now() + 15 * 60 * 1000;
          _claudeOutReason = /credit balance is too low/i.test(text) ? 'Claude — נגמר הקרדיט בחשבון Anthropic' : `Claude — אין הרשאה (${res.status})`;
          throw new Error(_claudeOutReason);
        }
        throw new Error(`שגיאת AI (${res.status}): ${text.slice(0, 300)}`);
      }
      let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מ-AI'); }
      trackUsage(opts.label || 'vision', model, data.usage);
      return (data.content || []).map(c => c.text).filter(Boolean).join('');
    }
  }
  throw new Error(`אף מודל Claude זמין לקריאת מסמכים. פרט: ${lastErr}`);
}
// חילוץ ראייתי עם גיבוי אוטומטי: מנסה Claude (אם יש מפתח); אם נכשל (למשל מכסה/קרדיט נגמר) — עובר ל-Gemini (אם יש מפתח).
async function visionExtract(system, prompt, fileBase64, mediaType, opts = {}) {
  const isPdf = mediaType === 'application/pdf';
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };
  const hasA = !!process.env.ANTHROPIC_API_KEY, hasG = !!process.env.GEMINI_API_KEY;
  // מדלגים על Claude אם זוהה שאין לו קרדיט/הרשאה (עד שהחלון עובר) — ישר ל-Gemini, בלי לבזבז קריאה פר-מסמך
  if (hasA && Date.now() > _claudeOutUntil) {
    try { return await callAnthropicVision(system, [block, { type: 'text', text: prompt }], opts); }
    catch (e) {
      if (!hasG) throw e;
      console.error('[vision] Claude נכשל — עובר ל-Gemini:', String(e.message || e).slice(0, 140));
      try { return await callGeminiVision(system, prompt, fileBase64, mediaType, opts); }
      catch (ge) { throw new Error(`${ge.message} · ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  // Claude מדולג (נגמר קרדיט/הרשאה) — מציינים זאת בשגיאה, אחרת נראה כאילו רק Gemini אשם
  if (hasG) {
    try { return await callGeminiVision(system, prompt, fileBase64, mediaType, opts); }
    catch (ge) { throw new Error(_claudeOutReason ? `${ge.message} · ${_claudeOutReason}` : ge.message); }
  }
  throw new Error('AI לא מוגדר (חסר ANTHROPIC_API_KEY או GEMINI_API_KEY)');
}
// פענוח JSON חסין מתשובת AI: מסיר גדרות ```‏, חותך לאובייקט, מנקה פסיקים עודפים, מבריח מרכאות לא-חוקיות בתוך מחרוזות
// (נפוץ בעברית — למשל בע"מ), ותווי בקרה. מחזיר אובייקט או null (בלי לזרוק).
function parseAiJson(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  s = s.slice(i, j + 1);
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let out = tryParse(s);
  if (out !== undefined) return out;
  // ניקוי 1: פסיקים עודפים לפני }/] + תווי בקרה
  out = tryParse(s.replace(/,\s*([}\]])/g, '$1').replace(/[ -]+/g, ' '));
  if (out !== undefined) return out;
  // ניקוי 2: הברחת מרכאות כפולות לא-חוקיות בתוך ערכי מחרוזת (מרכאה שאינה גבול של מפתח/ערך)
  const repaired = s.replace(/,\s*([}\]])/g, '$1').replace(/[ -]+/g, ' ')
    .replace(/"([^"]*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (mAll) => mAll)      // שמירה על זוגות תקינים
    .replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (mAll) => mAll);
  out = tryParse(repaired);
  return out === undefined ? null : out;
}
// קריאה מולטימודלית ל-Gemini (גיבוי)
async function callGeminiVision(system, prompt, fileBase64, mime, { maxTokens = 900 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  const candidates = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-pro-latest'];
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime || 'application/pdf', data: fileBase64 } }, { text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
  });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr = '';
  for (const model of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res, text;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        });
        text = await res.text();
      } catch (e) { lastErr = 'network: ' + e.message; await sleep(1500 * (attempt + 1)); continue; }
      if (res.status === 404) { lastErr = '(404)'; break; } // מודל לא קיים — למודל הבא
      // 429 = חריגה ממגבלת קצב (Gemini free). המתנה קצרה (מכבד retryDelay אם קטן), אחרת עוברים למודל הבא במהירות.
      if (res.status === 429 || res.status === 503 || res.status === 500) {
        let wait = Math.min(8000, 2000 * Math.pow(2, attempt));
        const m = String(text).match(/"retryDelay"\s*:\s*"(\d+)s"/); if (m) wait = Math.min(10000, Math.max(wait, (Number(m[1]) + 1) * 1000));
        lastErr = `(${res.status}) rate`;
        if (attempt >= 1) break;
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`שגיאת AI (${res.status}): ${text.slice(0, 300)}`);
      let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מ-AI'); }
      return (data.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
    }
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
- documentType: 305=חשבונית מס, 320=חשבונית מס/קבלה, 400=קבלה, 20=חשבון עסקה/דרישת תשלום. בחר לפי כותרת המסמך (למשל "חשבון עסקה" → 20, "חשבונית מס" → 305, "קבלה" → 400).
- הספק (supplierName + taxId) = העסק שהנפיק/הוציא את המסמך — מופיע בדרך כלל בראש המסמך ליד הלוגו, עם הח.פ שלו. זה **לא** הצד שמופיע תחת "לכבוד" (שהוא הלקוח/מקבל החשבונית). קרא את השם והח.פ של המנפיק, לא של המקבל.
- invoiceNumber = מספר המסמך שמופיע ליד כותרת המסמך (למשל "חשבון עסקה 49177" → 49177, "חשבונית מס 1234" → 1234). זה לא ח.פ, לא מספר הקצאה ולא מספר חשבון בנק.
- amountInclVat = הסכום הכולל הסופי לתשלום כולל מע"מ — השורה התחתונה "סה"כ לתשלום" / "סה"כ כולל מע"מ" (לא שורת פריט בודדת). amountExclVat = הסכום לפני מע"מ. vat = סכום המע"מ. אם רק חלק מהם מופיע — חשב את השאר (מע"מ בישראל 18%). כל הסכומים כמספרים בלבד.
- date = תאריך הפקת/הוצאת המסמך בפורמט YYYY-MM-DD.
- supplierPhone/supplierEmail/supplierContact = פרטי הקשר של הספק המנפיק כפי שמופיעים על המסמך (טלפון, אימייל, איש קשר). אם לא מופיע — ריק.
- אם הספק תואם לאחד מהרשימה למטה (לפי שם או ח.פ), החזר את ה-id שלו ב-supplierId. אחרת supplierId ריק.
- אם שדה לא נמצא — החזר ריק ("") למחרוזות ו-0 למספרים.

רשימת ספקים קיימים (id<TAB>שם | ח.פ):
${supList || '(אין)'}`;

  // פענוח חסין + ניסיון שני עם יותר טוקנים (מונע כשל חד-פעמי על JSON פגום/חתוך — למשל מרכאות בטקסט עברי)
  let out = parseAiJson(await visionExtract(system, prompt, fileBase64, mediaType, { maxTokens: 1500 }));
  if (!out) out = parseAiJson(await visionExtract(system, prompt, fileBase64, mediaType, { maxTokens: 2000 }));
  if (!out) throw new Error('ה-AI לא החזיר נתונים תקינים');
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

// חילוץ שדות ממסמך הכנסה ישן (חשבונית/קבלה/הצעה שהעסק הנפיק ללקוח) — למילוי אוטומטי בקליטת מסמך ישן (אופק)
export async function extractIncomeDocFields(fileBase64, mime, clients = []) {
  if (!chatConfigured()) throw new Error('AI לא מוגדר (חסר ANTHROPIC_API_KEY או GEMINI_API_KEY)');
  const mediaType = sniffMediaType(fileBase64, mime);
  const cliList = (clients || []).slice(0, 600).map(c => `${c.id}\t${c.name}`).join('\n');
  const system = 'אתה מומחה לקריאת מסמכי הכנסה ישראליים (חשבוניות/קבלות/הצעות מחיר שהעסק הנפיק ללקוח). אתה מחלץ נתונים במדויק ומחזיר JSON תקין בלבד, בלי טקסט לפני או אחרי.';
  const prompt = `זהו מסמך הכנסה שהעסק הנפיק ללקוח. קרא את המסמך וחלץ את הנתונים.
החזר אך ורק JSON במבנה המדויק:
{"clientName":"שם הלקוח שהמסמך הופק עבורו (הנמען / לכבוד)","clientId":"","documentType":305,"documentNumber":"מספר המסמך","date":"YYYY-MM-DD","amountInclVat":0}

כללים:
- documentType: 10=הצעת מחיר, 300=חשבון עסקה, 305=חשבונית מס, 320=חשבונית מס-קבלה, 400=קבלה. בחר לפי כותרת המסמך.
- clientName = מי שהמסמך מופנה אליו (לכבוד / שם הלקוח), ולא שם העסק המנפיק.
- amountInclVat = הסכום הכולל לתשלום כולל מע"מ, כמספר בלבד.
- אם הלקוח תואם לאחד מהרשימה למטה (לפי שם), החזר את ה-id שלו ב-clientId. אחרת clientId ריק.
- אם שדה לא נמצא — החזר ריק ("") למחרוזות ו-0 למספרים.

רשימת לקוחות קיימים (id<TAB>שם):
${cliList || '(אין)'}`;

  // פענוח חסין + ניסיון שני עם יותר טוקנים (מונע כשל חד-פעמי על JSON פגום/חתוך)
  let out = parseAiJson(await visionExtract(system, prompt, fileBase64, mediaType, { maxTokens: 1500 }));
  if (!out) out = parseAiJson(await visionExtract(system, prompt, fileBase64, mediaType, { maxTokens: 2000 }));
  if (!out) throw new Error('ה-AI לא החזיר נתונים תקינים');
  const num = (v) => { const n = +String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); return isNaN(n) ? 0 : n; };
  let clientId = out.clientId && (clients || []).some(c => String(c.id) === String(out.clientId)) ? String(out.clientId) : '';
  const nm = String(out.clientName || '').trim();
  if (!clientId && nm) { const m = (clients || []).find(c => c.name && (c.name === nm || c.name.includes(nm) || nm.includes(c.name))); if (m) clientId = String(m.id); }
  return {
    clientId,
    clientName: nm,
    documentType: [10, 300, 305, 320, 400].includes(+out.documentType) ? +out.documentType : 305,
    number: String(out.documentNumber || '').trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '',
    amountInclVat: num(out.amountInclVat) || 0,
  };
}

// classifyExpenseAttachment — סיווג צרופת מייל: האם זו חשבונית/קבלה/הצעה של הוצאה, ואם כן איזה סוג + שדות מלאים.
// route: 'expense' (עסקה/מס/מס-קבלה/זיכוי/קבלה → קליטה כהוצאה בחשבונית ירוקה) · 'record' (הצעת מחיר → רישום בלבד) · 'skip' (לא מסמך כספי).
export async function classifyExpenseAttachment(fileBase64, mime, suppliers = []) {
  if (!chatConfigured()) throw new Error('AI לא מוגדר (חסר ANTHROPIC_API_KEY או GEMINI_API_KEY)');
  const mediaType = sniffMediaType(fileBase64, mime);
  const supList = (suppliers || []).slice(0, 500).map(s => `${s.id}\t${s.name}${s.taxId ? ' | ח.פ ' + s.taxId : ''}`).join('\n');
  const system = 'אתה מומחה לקריאת מסמכים עסקיים ישראליים. אתה מסווג במדויק ומחזיר JSON תקין בלבד, בלי טקסט לפני או אחרי.';
  const prompt = `לפניך צרופה שהגיעה במייל לעסק. קבע קודם האם זו בכלל מסמך כספי של ספק — חשבונית מס / חשבונית מס-קבלה / קבלה / חשבונית זיכוי / הצעת מחיר / חשבון עסקה (דרישת תשלום/פרופורמה) — או משהו אחר (מצגת, לוגו, חתימת מייל, צילום כללי, קטלוג, מסמך שאינו כספי).
החזר אך ורק JSON במבנה המדויק:
{"isFinancialDoc":true,"documentType":305,"supplierName":"שם הספק המנפיק","taxId":"ח.פ/עוסק (ספרות בלבד) או ריק","supplierPhone":"","supplierEmail":"","supplierContact":"","invoiceNumber":"מספר המסמך","allocationNumber":"מספר הקצאה של רשות המסים (בד״כ 9 ספרות) או ריק","date":"YYYY-MM-DD","amountInclVat":0,"amountExclVat":0,"vat":0,"description":"תיאור קצר של ההוצאה","supplierId":"","confidence":0.9}

כללים:
- isFinancialDoc=false אם זו לא חשבונית/קבלה/הצעה/דרישת תשלום. במקרה כזה documentType=0 ואפסים/ריקים בשאר.
- documentType: 10=הצעת מחיר, 300=חשבון עסקה/דרישת תשלום/פרופורמה, 305=חשבונית מס, 320=חשבונית מס-קבלה, 330=חשבונית זיכוי, 400=קבלה. בחר לפי כותרת המסמך. מסמך כספי שסוגו לא ברור — 305.
- הספק הוא מי שהנפיק את המסמך (לא מקבל המייל).
- amountInclVat = סכום כולל מע"מ. amountExclVat = לפני מע"מ. vat = סכום המע"מ. השלם חסרים (מע"מ 18%). מספרים בלבד.
- אם הספק תואם לרשימה למטה (לפי שם/ח.פ), החזר את ה-id שלו ב-supplierId. אחרת ריק.
- confidence בין 0 ל-1.

רשימת ספקים קיימים (id<TAB>שם | ח.פ):
${supList || '(אין)'}`;
  let raw;
  raw = await visionExtract(system, prompt, fileBase64, mediaType);
  const jsonStr = (String(raw).replace(/```json/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || ['{}'])[0];
  let out; try { out = JSON.parse(jsonStr); } catch { return { isFinancialDoc: false, documentType: 0, route: 'skip' }; }
  const numF = (v) => { const n = +String(v == null ? '' : v).replace(/[^\d.\-]/g, ''); return isNaN(n) ? 0 : n; };
  const isFin = out.isFinancialDoc === true || out.isFinancialDoc === 'true';
  const dt = [10, 300, 305, 320, 330, 400].includes(+out.documentType) ? +out.documentType : (isFin ? 305 : 0);
  let incl = numF(out.amountInclVat), net = numF(out.amountExclVat), vat = numF(out.vat);
  if (incl && !net) net = +(incl / 1.18).toFixed(2);
  if (incl && !vat) vat = +(incl - net).toFixed(2);
  if (!incl && net && vat) incl = +(net + vat).toFixed(2);
  let supplierId = out.supplierId && (suppliers || []).some(s => String(s.id) === String(out.supplierId)) ? String(out.supplierId) : '';
  if (!supplierId && out.taxId) { const m = (suppliers || []).find(s => s.taxId && String(s.taxId).replace(/\D/g, '') === String(out.taxId).replace(/\D/g, '')); if (m) supplierId = String(m.id); }
  if (!supplierId && out.supplierName) { const nm = String(out.supplierName).trim(); const m = (suppliers || []).find(s => s.name && (s.name === nm || s.name.includes(nm) || nm.includes(s.name))); if (m) supplierId = String(m.id); }
  // כל מסמך חשבונית של ספק — עסקה(300)/מס(305)/מס-קבלה(320)/זיכוי(330)/קבלה(400) — נקלט כהוצאה (מופיע בקליטה לאישור).
  // הצעת מחיר(10) — רישום בלבד. כל השאר — דילוג.
  const route = [300, 305, 320, 330, 400].includes(dt) ? 'expense' : (dt === 10 ? 'record' : 'skip');
  return {
    isFinancialDoc: isFin && dt !== 0, documentType: dt, route,
    supplierId, supplierName: String(out.supplierName || '').trim(),
    taxId: String(out.taxId || '').replace(/[^\d]/g, ''),
    supplierPhone: String(out.supplierPhone || '').trim(),
    supplierEmail: String(out.supplierEmail || '').trim(),
    supplierContact: String(out.supplierContact || '').trim(),
    invoiceNumber: String(out.invoiceNumber || '').trim(),
    allocationNumber: String(out.allocationNumber || '').replace(/[^\d]/g, ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : '',
    amountInclVat: incl || 0, amountExcludeVat: net || 0, vat: vat || 0,
    description: String(out.description || '').trim(),
    confidence: Math.max(0, Math.min(1, numF(out.confidence) || 0)),
  };
}

// למידה: מפיק "עובדות לזכור" מתוך חילופי ההודעות האחרונים (לזיכרון המתמשך)
export async function learnFromExchange(member, exchangeText) {
  const system = `אתה עוזר שמתחזק זיכרון ארוך-טווח עבור ${member.name} (${member.role}). מטרתך לזקק עובדות/העדפות/החלטות יציבות ששווה לזכור לטווח ארוך.`;
  const prompt = `מתוך חילופי ההודעות הבאים, כתוב 0–2 נקודות תמציתיות (שורה כל אחת) של מידע חדש ויציב ששווה לזכור על העסק/המערכת/העדפות המנהל. אל תכלול דברים חד-פעמיים או טריוויאליים. אם אין מה לזכור, כתוב בדיוק: אין\n\n${exchangeText}`;
  try {
    const out = (await complete(system, [{ role: 'user', content: prompt }], { label: 'learn' })).trim();
    if (!out || out === 'אין' || out.length > 500) return '';
    return out;
  } catch { return ''; }
}
