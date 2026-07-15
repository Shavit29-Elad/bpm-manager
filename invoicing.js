// lib/invoicing.js
// לוגיקת חיוב: מי צריך חשבונית ועל כמה, ואיסוף אירועים לפי לקוח לחשבונית חודשית אחת.

function monthKey(iso) {
  return iso ? iso.slice(0, 7) : 'unknown'; // yyyy-mm
}

// מקבל אירועים של חברה ומחזיר קיבוץ לפי לקוח (client) ולפי חודש,
// כדי להפיק חשבונית אחת ללקוח בסוף החודש עבור כל האירועים.
export function groupForInvoicing(events) {
  const groups = {};
  for (const ev of events) {
    if (ev.invoiceStatus === 'invoiced') continue; // כבר חויב
    const client = (ev.client || ev.artist || 'לא ידוע').trim();
    const key = `${client}__${monthKey(ev.date)}`;
    if (!groups[key]) {
      groups[key] = { client, month: monthKey(ev.date), events: [], total: 0 };
    }
    groups[key].events.push(ev);
    groups[key].total += Number(ev.price) || 0;
  }
  return Object.values(groups).sort((a, b) => b.month.localeCompare(a.month));
}

// בונה פריטי חשבונית מתוך קבוצה
export function invoiceItemsFromGroup(group) {
  return group.events.map(ev => ({
    description: `${ev.artist || 'אירוע'} — ${ev.location || ''} (${ev.date || ev.dateRaw || ''})`.trim(),
    quantity: 1,
    price: Number(ev.price) || 0,
  }));
}

// קבלנים: מי צריך להוציא לנו חשבונית וכמה אנחנו משלמים
export function contractorPayables(events) {
  const byContractor = {};
  for (const ev of events) {
    for (const c of ev.contractorDetails || []) {
      const name = c.name;
      if (!byContractor[name]) byContractor[name] = { name, total: 0, events: [] };
      byContractor[name].total += Number(c.amount) || 0;
      byContractor[name].events.push({ id: ev.id, date: ev.date, amount: c.amount });
    }
  }
  return Object.values(byContractor);
}

export default { groupForInvoicing, invoiceItemsFromGroup, contractorPayables };
