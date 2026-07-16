// store.js
// שכבת נתונים פשוטה מבוססת קובץ JSON. בלי תלות בבסיס נתונים חיצוני -
// כדי שהמערכת תרוץ מיד. בהמשך אפשר להחליף ל-Postgres/SQLite בלי לשנות את שאר הקוד.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  companies: [],   // { id, name, greenInvoiceId?, active }
  events: [],      // אירוע (הופעה) שנקלט מווטסאפ/יומן
  employees: [],   // עובדים (מידע פנימי, לא חשוף ביניהם)
  contractors: [], // קבלנים
  invoices: [],    // חשבוניות/קבלות שהופקו
  bankTx: [],      // תנועות בנק להתאמה
  fixedExpenses: [],// הוצאות קבועות
  assets: [],      // רכבים/הלוואות/ביטוחים - תוקף והתראות
  chats: {},       // שיחות עם דמויות הצוות: { memberId: [ {role, content, at} ] }
  memory: {},      // זיכרון מתמשך לכל דמות: { memberId: "עובדות שנלמדו..." }
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY, null, 2));
}

export function load() {
  ensure();
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return { ...EMPTY, ...raw };
}

export function save(db) {
  ensure();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  return db;
}

export function id(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// עוזרים ממוקדים לישויות נפוצות
export function upsertEvent(db, ev) {
  const idx = db.events.findIndex(e => e.id === ev.id);
  if (idx >= 0) db.events[idx] = { ...db.events[idx], ...ev };
  else db.events.push(ev);
  return ev;
}

export function companyEvents(db, companyId) {
  return db.events.filter(e => e.companyId === companyId);
}
