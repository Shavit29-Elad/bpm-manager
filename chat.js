// chat.js — שיחה עם דמויות הצוות. תומך בשני ספקים (בלי תלויות, fetch בלבד):
//   • Google Gemini (חינמי!)  — GEMINI_API_KEY   ← מומלץ, קל וחינם
//   • Anthropic Claude (בתשלום) — ANTHROPIC_API_KEY
// אם שניהם מוגדרים, Gemini קודם.

export function chatConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

// --- Google Gemini (חינמי) ---
async function callGemini(system, messages) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 1200, temperature: 0.7 },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`שגיאת צ'אט (${res.status}): ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהשירות'); }
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text).filter(Boolean).join('') || '(אין תשובה)';
}

// --- Anthropic Claude (בתשלום) ---
async function callAnthropic(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CHAT_MODEL || 'claude-3-5-sonnet-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1200, system, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`שגיאת צ'אט (${res.status}): ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהשירות'); }
  return (data.content || []).map(c => c.text).filter(Boolean).join('') || '(אין תשובה)';
}

async function complete(system, messages) {
  if (!chatConfigured()) throw new Error('הצ\'אט לא מוגדר — הוסף ANTHROPIC_API_KEY (Claude) או GEMINI_API_KEY ב-Render');
  return process.env.GEMINI_API_KEY ? callGemini(system, messages) : callAnthropic(system, messages);
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
