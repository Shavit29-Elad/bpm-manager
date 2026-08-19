// backup.js — גיבוי יומי של כל בסיס הנתונים לגוגל דרייב, בלי תלויות חיצוניות.
//
// למה זה קיים: כל הנתונים הפיננסיים של שלוש החברות יושבים במסמך JSON אחד ב-Neon.
// באג שכותב נתון שגוי, מחיקה בטעות או תקלה בספק — ואין לאן לחזור. הגיבוי יוצא
// מהמערכת החוצה, לדרייב של המנהל, ולא תלוי בשום מחשב.
//
// אימות מול גוגל: Service Account (חשבון-רובוט). חותמים JWT ב-RS256 עם המפתח
// הפרטי ומחליפים אותו ב-access token. crypto ו-zlib מובנים ב-Node, אז אין צורך
// בספריית google-api — בהתאם לקונבנציה של הפרויקט (fetch בלבד).

import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { load } from './store.js';

const gzip = promisify(zlib.gzip);
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';   // רק קבצים שהאפליקציה עצמה יצרה

// ---- מדיניות שמירה (סבא-אבא-בן) ----
// צפיפות יורדת: יום ביומו לטווח הקרוב, שבועי לטווח הבינוני, חודשי לשנה.
// ~34 קבצים במקום 365, והמספר לא גדל עם הזמן.
export const RETENTION = { dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12 };

function creds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (!c.client_email || !c.private_key) return null;
    // ב-Render המפתח מודבק לרוב עם \n מילוליים במקום שורות אמיתיות
    c.private_key = String(c.private_key).replace(/\\n/g, '\n');
    return c;
  } catch { return null; }
}

export function backupConfigured() {
  return Boolean(creds() && process.env.GOOGLE_DRIVE_FOLDER_ID);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// access token של גוגל מתוך JWT חתום. תקף לשעה; מחזיקים במטמון עם שוליים של דקה.
let _tok = { value: null, exp: 0 };
async function accessToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const c = creds();
  if (!c) throw new Error('לא מוגדר GOOGLE_SERVICE_ACCOUNT_JSON');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: c.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), c.private_key));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${sig}` }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`אימות מול גוגל נכשל (${res.status}): ${txt.slice(0, 200)}`);
  const d = JSON.parse(txt);
  _tok = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return _tok.value;
}

// ---- בניית קובץ הגיבוי ----
// מוציא את המסמך כולו. emp_files (הקבצים הבינאריים) לא נכללים — הם בטבלה נפרדת
// וכבדים בהרבה; הגיבוי כאן הוא של הנתונים, לא של הצרופות.
export async function buildBackup() {
  const db = load();
  const payload = {
    _backup: {
      at: new Date().toISOString(),
      version: 1,
      note: 'גיבוי מלא של app_state. אינו כולל את טבלת emp_files (קבצים מצורפים).',
      counts: {
        events: (db.events || []).length,
        bankTx: (db.bankTx || []).length,
        employees: (db.employees || []).length,
        oldInvoices: (db.oldInvoices || []).length,
        supplierPayables: (db.supplierPayables || []).length,
      },
    },
    db,
  };
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const gz = await gzip(json, { level: 9 });
  return { buf: gz, rawBytes: json.length, counts: payload._backup.counts, at: payload._backup.at };
}

export const backupFileName = (at = new Date()) =>
  `bpm-backup-${at.toISOString().slice(0, 10)}-${String(at.toISOString().slice(11, 16)).replace(':', '')}.json.gz`;

// ---- דרייב ----
async function driveUpload(name, buf, folderId) {
  const token = await accessToken();
  const boundary = 'bpm' + crypto.randomBytes(12).toString('hex');
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/gzip' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,name,size`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`העלאה לדרייב נכשלה (${res.status}): ${txt.slice(0, 250)}`);
  return JSON.parse(txt);
}

async function driveList(folderId) {
  const token = await accessToken();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and name contains 'bpm-backup-'`);
  const res = await fetch(`${FILES_URL}?q=${q}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=1000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`קריאת תיקיית הדרייב נכשלה (${res.status}): ${txt.slice(0, 200)}`);
  return JSON.parse(txt).files || [];
}

async function driveDelete(id) {
  const token = await accessToken();
  const res = await fetch(`${FILES_URL}/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`מחיקה מהדרייב נכשלה (${res.status})`);
}

// ---- מי נשאר ומי נמחק ----
// טהורה בכוונה (בלי גישה לרשת) כדי שאפשר יהיה לבדוק אותה. מקבלת רשימת קבצים
// ומחזירה מה למחוק. שומרת את החדש ביותר בכל דלי (יום/שבוע/חודש).
export function planRetention(files, now = new Date(), policy = RETENTION) {
  const dated = files
    .map(f => ({ ...f, t: new Date(f.createdTime || 0) }))
    .filter(f => !isNaN(f.t.getTime()))
    .sort((a, b) => b.t - a.t);
  const DAY = 86400000;
  const keep = new Set();
  const seen = { day: new Set(), week: new Set(), month: new Set() };
  const iso = (d) => d.toISOString().slice(0, 10);
  const weekKey = (d) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return iso(x); };
  const monthKey = (d) => d.toISOString().slice(0, 7);
  for (const f of dated) {
    const ageDays = (now - f.t) / DAY;
    if (ageDays <= policy.dailyDays) {
      const k = iso(f.t);
      if (!seen.day.has(k)) { seen.day.add(k); keep.add(f.id); }
    } else if (ageDays <= policy.weeklyWeeks * 7) {
      const k = weekKey(f.t);
      if (!seen.week.has(k)) { seen.week.add(k); keep.add(f.id); }
    } else if (ageDays <= policy.monthlyMonths * 31) {
      const k = monthKey(f.t);
      if (!seen.month.has(k)) { seen.month.add(k); keep.add(f.id); }
    }
    // מעבר לטווח החודשי — לא נשמר
  }
  // רשת ביטחון: אף פעם לא מוחקים את הגיבוי האחרון, יהיה מה שיהיה
  if (dated.length) keep.add(dated[0].id);
  return { keep: dated.filter(f => keep.has(f.id)), remove: dated.filter(f => !keep.has(f.id)) };
}

// ---- שליחה במייל ----
// היעד נקבע ב-BACKUP_EMAIL. נשלח מתיבת החברה הראשית, שכבר מוגדרת ל-SMTP.
export function backupMailText(info) {
  return [
    'גיבוי יומי של מערכת הניהול הפיננסי.',
    '',
    `נוצר: ${new Date(info.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
    `גודל: ${(info.gzBytes / 1048576).toFixed(2)}MB דחוס (${(info.rawBytes / 1048576).toFixed(1)}MB לפני דחיסה)`,
    '',
    'תוכן:',
    `  אירועים: ${info.counts.events}`,
    `  תנועות בנק: ${info.counts.bankTx}`,
    `  עובדים: ${info.counts.employees}`,
    `  חשבוניות ישנות: ${info.counts.oldInvoices}`,
    `  הוצאות ספקים: ${info.counts.supplierPayables}`,
    '',
    'הקובץ מכיל את כל הנתונים של שלוש החברות. אין למחוק אותו — הוא הדרך היחידה',
    'לשחזר את המערכת אם משהו ישתבש. אינו כולל את הקבצים המצורפים (PDF של חשבוניות).',
    '',
    'לשחזור — יש לפנות למפתח עם הקובץ הזה.',
  ].join('\n');
}

// ---- ריצה מלאה ----
// גיבוי במייל — המסלול הפעיל. אין תלות בשום שירות חיצוני מעבר לתיבה שכבר מוגדרת.
export async function runBackupMail(sendMailFrom, creds, to) {
  if (!to) return { skipped: 'לא מוגדר BACKUP_EMAIL' };
  const info = await buildBackup();
  const name = backupFileName(new Date(info.at));
  await sendMailFrom(creds, {
    to: [to],
    subject: `גיבוי מערכת · ${new Date(info.at).toISOString().slice(0, 10)}`,
    text: backupMailText(info),
    attachments: [{ filename: name, content: info.buf, contentType: 'application/gzip' }],
  });
  return { ok: true, to, name, gzBytes: info.buf.length, rawBytes: info.rawBytes, counts: info.counts, at: info.at };
}

export async function runBackup() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!backupConfigured()) return { skipped: 'לא מוגדר — חסר GOOGLE_SERVICE_ACCOUNT_JSON או GOOGLE_DRIVE_FOLDER_ID' };
  const { buf, rawBytes, counts, at } = await buildBackup();
  const name = backupFileName(new Date(at));
  const up = await driveUpload(name, buf, folderId);
  // ניקוי לפי מדיניות השמירה — אחרי ההעלאה, כדי שהחדש כבר יהיה בפנים
  let removed = 0, kept = 0, cleanupError = null;
  try {
    const files = await driveList(folderId);
    const plan = planRetention(files);
    kept = plan.keep.length;
    for (const f of plan.remove) { await driveDelete(f.id); removed++; }
  } catch (e) { cleanupError = e.message; }
  return {
    ok: true, name, fileId: up.id, gzBytes: buf.length, rawBytes, counts, at,
    kept, removed, cleanupError,
  };
}
