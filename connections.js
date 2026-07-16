// lib/connections.js
// מרכז החיבורים: הגדרות החיבורים + שמירת מטא-דאטה (סטטוס, מתי התחבר, בדיקה אחרונה).
// הסודות עצמם נשמרים ב-.env (lib/settings.js); כאן נשמר רק הסטטוס.

import { load, save } from './store.js';

// הגדרת החיבורים הזמינים בממשק
export const DEFS = {
  greenInvoice: {
    name: 'חשבונית ירוקה',
    icon: '🧾',
    fields: [
      { env: 'GREENINVOICE_API_KEY_ID', label: 'API Key ID' },
      { env: 'GREENINVOICE_API_SECRET', label: 'Secret', secret: true },
    ],
    help: 'בחשבונית ירוקה: הגדרות ← אזור מפתחים ← צור מפתח API',
  },
  googleCalendar: {
    name: 'יומן גוגל',
    icon: '📅',
    fields: [
      { env: 'GOOGLE_ICAL_URL', label: 'קישור iCal — יומן 1', secret: true },
      { env: 'GOOGLE_ICAL_URL_2', label: 'קישור iCal — יומן 2 (אופציונלי)', secret: true },
    ],
    help: 'בגוגל יומן: הגדרות היומן ← "כתובת סודית בפורמט iCal" (נגמרת ב-basic.ics). כל יומן בשורה משלו.',
  },
  whatsapp: {
    name: 'ווטסאפ (תוסף Chrome)',
    icon: '💬',
    help: 'חיבור דרך תוסף Chrome שמותקן על כל פרופיל של ווטסאפ ווב, ומתייג כל עסק בנפרד. דורש הגדרת WHATSAPP_WEBHOOK_TOKEN במשתני הסביבה. קריאה בלבד.',
  },
  bank: {
    name: 'בנק / התאמת בנק',
    icon: '🏦',
    soon: true,
    help: 'ייבוא תנועות בנק והתאמה מול חשבוניות/קבלות — בפיתוח (שלב הבא).',
  },
};

export function getRecords() {
  const db = load();
  return db.connections || {};
}

// עדכון רשומת חיבור. שומר connectedAt הראשוני ולא דורס אותו בבדיקות חוזרות.
export function setRecord(key, patch) {
  const db = load();
  db.connections = db.connections || {};
  const prev = db.connections[key] || {};
  const next = { ...prev, ...patch };
  if (patch.status === 'connected' && !prev.connectedAt) next.connectedAt = patch.lastCheckedAt || new Date().toISOString();
  if (patch.status && patch.status !== 'connected') next.connectedAt = prev.connectedAt || null;
  db.connections[key] = next;
  save(db);
  return next;
}

export function clearRecord(key) {
  const db = load();
  if (db.connections) delete db.connections[key];
  save(db);
}

export default { DEFS, getRecords, setRecord, clearRecord };
