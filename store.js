// store.js
// שכבת נתונים עם מטמון בזיכרון (קריאה מיידית) וגיבוי קבוע ל-Postgres (Neon).
// אם אין DATABASE_URL — נופל אוטומטית לקובץ מקומי כך שהמערכת עדיין רצה.
//
// דגם הנתונים נשמר כמסמך JSON יחיד (שורה אחת בטבלה app_state), כך ששאר הקוד
// לא משתנה: load() מחזיר את המטמון, save() מעדכן אותו ומסנכרן לרקע ל-Postgres.

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

let cache = null;   // המסמך בזיכרון
let pool = null;    // Postgres pool (אם מחובר)
let usePg = false;
let dirty = false;
let saving = false;

// ----- אתחול (נקרא פעם אחת בעליית השרת) -----
async function initPg() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
  });
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
  await pool.query('CREATE TABLE IF NOT EXISTS emp_files (id TEXT PRIMARY KEY, employee_id TEXT, kind TEXT, filename TEXT, mime TEXT, data TEXT, created_at TIMESTAMPTZ DEFAULT now())');
  const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (r.rows.length) {
    cache = { ...EMPTY, ...r.rows[0].data };
  } else {
    cache = { ...EMPTY };
    await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [JSON.stringify(cache)]);
  }
  usePg = true;
  return true;
}

export async function init() {
  try {
    if (await initPg()) { console.log('אחסון: מחובר ל-Postgres (Neon) ✓'); return; }
    console.log('אחסון: לא הוגדר DATABASE_URL — משתמש בקובץ מקומי (זמני, יתאפס בפריסה)');
  } catch (e) {
    console.error('אחסון: חיבור ל-Postgres נכשל, נופל לקובץ מקומי:', e.message);
  }
  ensureFile();
  try { cache = { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
  catch { cache = { ...EMPTY }; }
  usePg = false;
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY, null, 2));
}

// ----- API תואם-לאחור (סינכרוני) -----
export function load() {
  if (!cache) {
    // fallback אם init עדיין לא רץ
    try { ensureFile(); cache = { ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
    catch { cache = { ...EMPTY }; }
  }
  return cache;
}

export function save(db) {
  cache = db || cache;
  persist();
  return cache;
}

function persist() {
  if (usePg) { dirty = true; flushLoop(); }
  else {
    try { ensureFile(); fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('אחסון: כתיבה לקובץ נכשלה:', e.message); }
  }
}

// מאחד כתיבות מרובות וכותב תמיד את הגרסה האחרונה ל-Postgres
async function flushLoop() {
  if (saving || !dirty || !cache) return;
  saving = true; dirty = false;
  try {
    await pool.query('UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1', [JSON.stringify(cache)]);
  } catch (e) {
    console.error('אחסון: כתיבה ל-Postgres נכשלה:', e.message);
    dirty = true; // ננסה שוב בכתיבה הבאה
  } finally {
    saving = false;
    if (dirty) setTimeout(flushLoop, 300);
  }
}

// כתיבה מיידית וסינכרונית ל-Postgres — נקראת לפני כיבוי כדי לא לאבד את הכתיבה האחרונה
async function flushNow() {
  if (!usePg || !pool || !cache) return;
  try { await pool.query('UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1', [JSON.stringify(cache)]); dirty = false; }
  catch (e) { console.error('אחסון: כתיבה אחרונה לפני כיבוי נכשלה:', e.message); }
}

// בפריסה מחדש / כיבוי, Render שולח SIGTERM — נשמור את המצב האחרון ואז נצא
let shuttingDown = false;
async function gracefulExit() {
  if (shuttingDown) return; shuttingDown = true;
  await flushNow();
  process.exit(0);
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);

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

// ----- אחסון קבצים (מסמכי עובדים) — בטבלה נפרדת כדי לא לנפח את app_state -----
const _localFiles = new Map();
export async function saveFile({ id: fid, employeeId, kind, filename, mime, data }) {
  const fileId = fid || id('file');
  if (usePg && pool) {
    await pool.query(
      'INSERT INTO emp_files (id, employee_id, kind, filename, mime, data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET data=$6, filename=$4, mime=$5, kind=$3',
      [fileId, employeeId || null, kind || null, filename || null, mime || null, data || '']);
  } else {
    _localFiles.set(fileId, { id: fileId, employee_id: employeeId, kind, filename, mime, data });
  }
  return { id: fileId, employeeId, kind, filename, mime };
}
export async function getFile(fileId) {
  if (usePg && pool) { const r = await pool.query('SELECT * FROM emp_files WHERE id=$1', [fileId]); return r.rows[0] || null; }
  return _localFiles.get(fileId) || null;
}
export async function deleteFile(fileId) {
  if (usePg && pool) { await pool.query('DELETE FROM emp_files WHERE id=$1', [fileId]); }
  else { _localFiles.delete(fileId); }
  return true;
}
