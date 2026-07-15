// lib/settings.js
// קריאה/כתיבה של קובץ .env דרך הממשק, כדי שלא צריך לגעת בטרמינל.
// הערכים נכתבים ל-.env וגם מוחלים מיד על process.env (בלי הפעלה מחדש).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');

// מפתחות שהממשק מנהל
export const KEYS = [
  'GREENINVOICE_API_KEY_ID',
  'GREENINVOICE_API_SECRET',
  'GOOGLE_ICAL_URL',
  'WHATSAPP_BRIDGE',
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
}

// טוען את .env לתוך process.env בעליית השרת (בלי לדרוס משתנים שכבר הוגדרו)
export function loadEnvIntoProcess() {
  const env = readEnvFile();
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined && v !== '') process.env[k] = v;
  }
}

// שומר עדכונים ל-.env וגם מחיל על process.env מיידית
export function saveSettings(updates) {
  const current = readEnvFile();
  for (const [k, v] of Object.entries(updates)) {
    if (!KEYS.includes(k)) continue;
    if (v === '' || v == null) { delete current[k]; delete process.env[k]; }
    else { current[k] = v; process.env[k] = v; }
  }
  const body = Object.entries(current).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(ENV_FILE, body, { mode: 0o600 }); // הרשאות מוגבלות לקובץ הסודות
  return statusMasked();
}

// מחזיר סטטוס מוסווה (לא חושף את הערך המלא לממשק)
export function statusMasked() {
  const env = { ...readEnvFile(), ...process.env };
  const mask = (v) => (!v ? '' : v.length <= 6 ? '•••' : v.slice(0, 3) + '•••' + v.slice(-2));
  return {
    GREENINVOICE_API_KEY_ID: { set: Boolean(env.GREENINVOICE_API_KEY_ID), hint: mask(env.GREENINVOICE_API_KEY_ID) },
    GREENINVOICE_API_SECRET: { set: Boolean(env.GREENINVOICE_API_SECRET), hint: mask(env.GREENINVOICE_API_SECRET) },
    GOOGLE_ICAL_URL: { set: Boolean(env.GOOGLE_ICAL_URL), hint: mask(env.GOOGLE_ICAL_URL) },
    WHATSAPP_BRIDGE: { set: env.WHATSAPP_BRIDGE === 'on', hint: env.WHATSAPP_BRIDGE || 'off' },
  };
}

export default { KEYS, readEnvFile, loadEnvIntoProcess, saveSettings, statusMasked };
