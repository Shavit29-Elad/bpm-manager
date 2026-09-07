// lib/payroll.js
// חישוב תלושי שכר / תשלום לעובדים לפי העבודות שעבדו בהן.
// מידע העובדים פנימי בלבד - לא נחשף בין עובד לעובד (ראה server.js: אין endpoint שמחזיר
// שכר של עובד אחר; כל שליפה היא לפי מזהה עובד מפורש למי שמורשה).

// מקבל אירועים + רשימת עובדים (עם שכר בסיס), מחזיר סיכום לכל עובד לחודש.
// בסיס למשמרת = שכר בסיס יומי × פקטור (יומית=1, כפולה=2, חצי=0.5). ניתן לדרוס עם w.rate.
// פקטורים שמוצגים כיומית + בונוס. המפתח הוא הפקטור, והבונוס הוא ההפרש ממנו ל-1.
export const FACTOR_LABELS = { 1.5: 'יומית וחצי', 2: 'יומית כפולה' };

export function employeePayForMonth(events, month /* yyyy-mm */, employees = []) {
  const rateOf = (name) => {
    const e = (employees || []).find(x => x.name === name);
    return e ? Number(e.baseRate) || 0 : 0;
  };
  // החזר נסיעות ברירת-מחדל מכרטיס העובד (מוחל לכל משמרת אלא אם נדרס ידנית במשמרת)
  const travelOf = (name) => {
    const e = (employees || []).find(x => x.name === name);
    return e ? Number(e.travel) || 0 : 0;
  };
  const byEmployee = {};
  for (const ev of events) {
    if (month && !(ev.date || '').startsWith(month)) continue;
    for (const w of ev.employeeDetails || []) {
      const name = w.name;
      if (!name) continue;
      if (!byEmployee[name]) {
        byEmployee[name] = { name, month, base: 0, bonus: 0, food: 0, travel: 0, total: 0, baseRate: rateOf(name), shifts: [] };
      }
      const rate = rateOf(name);
      const factor = w.factor != null && w.factor !== '' ? Number(w.factor) : 1;
      const explicitRate = w.rate != null && w.rate !== '';
      let base = (explicitRate ? Number(w.rate) : rate * factor) || 0;
      // בונוס = סכום קבוע + (שבר יומית × שכר בסיס). "בונוס חצי יומית" → bonusFactor 0.5
      let bonus = (Number(w.bonus) || 0) + (Number(w.bonusFactor) || 0) * rate;
      // יומית וחצי/כפולה מוצגות כיומית מלאה + בונוס על התוספת, כמו בגיליון.
      // הסכום הכולל אינו משתנה — רק הפירוק. עד עכשיו הפירוק נעשה רק כשהביטוי
      // זוהה בהערת האירוע; הגדרה ידנית של הפקטור הציגה סכום אחד בלי בונוס.
      // שכר שהוזן ידנית למשמרת הוא סכום מפורש ואינו מפורק.
      let factorLabel = null;
      if (!explicitRate && rate > 0 && FACTOR_LABELS[factor]) {
        base = rate;
        bonus += rate * (factor - 1);
        factorLabel = FACTOR_LABELS[factor];
      }
      const food = Number(w.food) || 0;
      // נסיעות: אם הוזן ידנית במשמרת — משתמשים בו; אחרת ברירת המחדל מכרטיס העובד
      const travel = (w.travel != null && w.travel !== '') ? Number(w.travel) || 0 : travelOf(name);
      byEmployee[name].base += base;
      byEmployee[name].bonus += bonus;
      byEmployee[name].food += food;
      byEmployee[name].travel += travel;
      byEmployee[name].total += base + bonus + food + travel;
      byEmployee[name].shifts.push({
        eventId: ev.id, date: ev.date, artist: ev.artist, location: ev.location || '', factor, factorLabel,
        base, bonus, food, travel, note: w.note || '',
      });
    }
  }
  // מיון המשמרות לפי תאריך עולה (כמו בגיליון)
  for (const e of Object.values(byEmployee)) e.shifts.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return Object.values(byEmployee);
}

// חישוב שכר לעובד יחיד (למסך המורשה בלבד)
export function payForEmployee(events, employeeName, month) {
  return employeePayForMonth(events, month).find(e => e.name === employeeName) || null;
}

export default { employeePayForMonth, payForEmployee, FACTOR_LABELS };
