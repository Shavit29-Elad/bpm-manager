// lib/payroll.js
// חישוב תלושי שכר / תשלום לעובדים לפי העבודות שעבדו בהן.
// מידע העובדים פנימי בלבד - לא נחשף בין עובד לעובד (ראה server.js: אין endpoint שמחזיר
// שכר של עובד אחר; כל שליפה היא לפי מזהה עובד מפורש למי שמורשה).

// מקבל אירועים + רשימת עובדים (עם שכר בסיס), מחזיר סיכום לכל עובד לחודש.
// בסיס למשמרת = שכר בסיס יומי × פקטור (יומית=1, כפולה=2, חצי=0.5). ניתן לדרוס עם w.rate.
export function employeePayForMonth(events, month /* yyyy-mm */, employees = []) {
  const rateOf = (name) => {
    const e = (employees || []).find(x => x.name === name);
    return e ? Number(e.baseRate) || 0 : 0;
  };
  const byEmployee = {};
  for (const ev of events) {
    if (month && !(ev.date || '').startsWith(month)) continue;
    for (const w of ev.employeeDetails || []) {
      const name = w.name;
      if (!name) continue;
      if (!byEmployee[name]) {
        byEmployee[name] = { name, month, base: 0, bonus: 0, food: 0, total: 0, baseRate: rateOf(name), shifts: [] };
      }
      const factor = w.factor != null && w.factor !== '' ? Number(w.factor) : 1;
      const base = (w.rate != null && w.rate !== '' ? Number(w.rate) : rateOf(name) * factor) || 0;
      const bonus = Number(w.bonus) || 0;
      const food = Number(w.food) || 0;
      byEmployee[name].base += base;
      byEmployee[name].bonus += bonus;
      byEmployee[name].food += food;
      byEmployee[name].total += base + bonus + food;
      byEmployee[name].shifts.push({
        eventId: ev.id, date: ev.date, artist: ev.artist, location: ev.location || '', factor, base, bonus, food, note: w.note || '',
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

export default { employeePayForMonth, payForEmployee };
