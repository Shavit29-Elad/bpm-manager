// chat.js — שיחה עם דמויות הצוות דרך Anthropic API (בלי תלויות, fetch בלבד).
// דורש: ANTHROPIC_API_KEY (משתנה סביבה ב-Render). מודל: CHAT_MODEL (ברירת מחדל למטה).

export function chatConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callAnthropic(system, messages) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('חסר ANTHROPIC_API_KEY — הוסף מפתח Anthropic ב-Render כדי לשוחח עם הצוות');
  const model = process.env.CHAT_MODEL || 'claude-3-5-sonnet-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1200, system, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`שגיאת צ'אט (${res.status}): ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error('תשובה לא תקינה מהשירות'); }
  return (data.content || []).map(c => c.text).filter(Boolean).join('') || '(אין תשובה)';
}

// צ'אט אישי: היסטוריה מתחלפת user/assistant
export async function chatWithMember(member, history) {
  return callAnthropic(member.system, history.map(m => ({ role: m.role, content: m.content })));
}

// צ'אט קבוצתי: כל חבר צוות עונה בתורו על סמך תמלול השיחה עד כה
export async function chatGroupReply(member, transcript) {
  const content = `זו שיחה קבוצתית של צוות החברה (כמה עובדים וירטואליים + המנהל). התמלול עד כה:\n\n${transcript}\n\nהשב/י עכשיו כ${member.name} (${member.role}) בלבד — בקצרה, באופי שלך, ורק בתחום שלך. אם אין לך מה להוסיף לנושא, כתב/י משפט קצר בלבד. אל תדבר/י בשם אחרים.`;
  return callAnthropic(member.system, [{ role: 'user', content }]);
}
