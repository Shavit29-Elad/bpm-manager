// auth.js — התחברות והרשאות: hashing סיסמאות (scrypt), ניהול סשנים בעוגייה, וקריאת המשתמש המחובר.
// אין שמירת סיסמה גולמית — רק salt + hash. הסיסמאות נקבעות ע"י המשתמש עצמו במסך ההגדרה/ניהול.

import crypto from 'crypto';

export const SESSION_COOKIE = 'bpm_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')); }
  catch { return false; }
}
export function parseCookies(req) {
  const out = {};
  const c = req.headers.cookie || '';
  c.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
export function createSession(db, userId) {
  db.sessions = db.sessions || {};
  // ניקוי סשנים שפגו
  const now = Date.now();
  for (const [t, s] of Object.entries(db.sessions)) if (!s || s.exp < now) delete db.sessions[t];
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { userId, exp: now + SESSION_MS };
  return token;
}
export function getSessionUser(db, req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = (db.sessions || {})[token];
  if (!s || s.exp < Date.now()) return null;
  const u = (db.users || []).find(x => x.id === s.userId);
  if (!u) return null;
  return { ...u, _token: token };
}
export function destroySession(db, token) {
  if (db.sessions && token) delete db.sessions[token];
}
// פרטי משתמש בטוחים לשליחה ללקוח (בלי salt/hash)
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role,
    tabs: u.role === 'admin' ? 'all' : (u.tabs || []),
    companies: u.role === 'admin' ? 'all' : (u.companies || []),
    designMode: !!u.designMode, // מצב עיצוב: כפתורים גלויים אך השרת חוסם שינוי נתונים
    createdAt: u.createdAt || null,
  };
}

export default { SESSION_COOKIE, hashPassword, verifyPassword, parseCookies, setSessionCookie, clearSessionCookie, createSession, getSessionUser, destroySession, publicUser };
