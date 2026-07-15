// lib/payroll.js
// חישוב תלושי שכר / תשלום לעובדים לפי העבודות שעבדו בהן.
// מידע העובדים פנימי בלבד - לא נחשף בין עובד לעובד (ראה server.js: אין endpoint שמחזיר
// שכר של עובד אחר; כל שליפה היא לפי מזהה עובד מפורש למי שמורשה).

// מקבל אירועים + שיוך תעריפים לעובד, מחזיר סיכום לכל עובד לחודש נתון.
export function employeePayForMonth(events, month /* yyyy-mm */) {
  const byEmployee = {};
  for (const ev of events) {
    if (month && !(ev.date || '').startsWith(month)) continue;
    for (const w of ev.employeeDetails || []) {
      const name = w.name;
      if (!byEmployee[name]) {
        byEmployee[name] = { name, month, base: 0, bonus: 0, total: 0, shifts: [] };
      }
      const base = Number(w.rate) || 0;
      const bonus = Number(w.bonus) || 0;
      byEmployee[name].base += base;
      byEmployee[name].bonus += bonus;
      byEmployee[name].total += base + bonus;
      byEmployee[name].shifts.push({
        eventId: ev.id, date: ev.date, artist: ev.artist, base, bonus,
      });
    }
  }
  return Object.values(byEmployee);
}

// חישוב שכר לעובד יחיד (למסך המורשה בלבד)
export function payForEmployee(events, employeeName, month) {
  return employeePayForMonth(events, month).find(e => e.name === employeeName) || null;
}

export default { employeePayForMonth, payForEmployee };
