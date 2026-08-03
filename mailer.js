// mailer.js — שליחת מיילים דרך SMTP (למשל Gmail עם App Password).
// משמש להעברת קובצי הוצאה אוטומטית לכתובת רו"ח (למשל 516942349@rivh.it).
// הגדרה דרך משתני סביבה ב-Render:
//   SMTP_USER = כתובת ה-Gmail השולחת (למשל you@gmail.com)
//   SMTP_PASS = App Password של אותו חשבון (16 תווים, נוצר בהגדרות אבטחה של גוגל)
//   SMTP_HOST/SMTP_PORT (לא חובה — ברירת מחדל smtp.gmail.com:465)
//   SMTP_FROM (לא חובה — ברירת מחדל = SMTP_USER)
//   FORWARD_EXPENSE_EMAIL (לא חובה — ברירת מחדל 516942349@rivh.it)

let _nodemailer = null, _transporter = null;

async function nm() {
  if (!_nodemailer) { _nodemailer = (await import('nodemailer')).default; }
  return _nodemailer;
}

export function mailerConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

// לאן להעביר הוצאות (ברירת מחדל: תיבת המסמכים של הרו"ח)
export function forwardExpenseTo() {
  const v = (process.env.FORWARD_EXPENSE_EMAIL || '516942349@rivh.it').trim();
  return v || null;
}

async function transporter() {
  if (_transporter) return _transporter;
  const nodemailer = await nm();
  const port = Number(process.env.SMTP_PORT) || 465;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transporter;
}

export async function sendMail({ to, subject, text, html, attachments, from }) {
  if (!mailerConfigured()) throw new Error('שליחת מייל לא מוגדרת (חסר SMTP_USER/SMTP_PASS)');
  const t = await transporter();
  const fromAddr = from || process.env.SMTP_FROM || process.env.SMTP_USER;
  return t.sendMail({ from: fromAddr, to, subject, text, html, attachments });
}

// בדיקת חיבור (לאימות שהאישורים תקינים)
export async function verifyMailer() {
  if (!mailerConfigured()) return { ok: false, error: 'חסר SMTP_USER/SMTP_PASS' };
  try { const t = await transporter(); await t.verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ===== שליחה מחשבון Gmail פר-חברה (App Password) — כל חברה יוצאת מהתיבה שלה =====
const _companyTransports = new Map(); // user -> transporter
async function transporterFor(user, pass) {
  const key = String(user || '');
  const cached = _companyTransports.get(key);
  if (cached && cached._pass === pass) return cached.t;
  const nodemailer = await nm();
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  _companyTransports.set(key, { t, _pass: pass });
  return t;
}
// האם לחברה יש חשבון מייל משלה (Gmail + App Password)
export function companyMailConfigured(creds) { return Boolean(creds && creds.user && creds.pass); }
// שליחה מחשבון החברה. creds = { user, pass, fromName }. אם אין creds — גיבוי לחשבון הכללי (עם From מתוקן אם ניתן).
export async function sendMailFrom(creds, { to, subject, text, html, attachments }) {
  if (companyMailConfigured(creds)) {
    const t = await transporterFor(creds.user, creds.pass);
    const nm = (creds.fromName ? String(creds.fromName).replace(/"/g, '') : '').trim();
    const from = nm ? `"${nm}" <${creds.user}>` : creds.user;
    return t.sendMail({ from, to, subject, text, html, attachments });
  }
  // אין חשבון פר-חברה — נופלים לחשבון הכללי, אך עם כתובת/שם של החברה אם קיימים (כדי לא להיראות כחברה אחרת)
  const nm2 = (creds && creds.fromName ? String(creds.fromName).replace(/"/g, '') : '').trim();
  const addr = (creds && creds.user) ? creds.user : (process.env.SMTP_FROM || process.env.SMTP_USER);
  const from = nm2 && addr ? `"${nm2}" <${addr}>` : (addr || undefined);
  return sendMail({ to, subject, text, html, attachments, from });
}
// בדיקת חיבור לחשבון של חברה
export async function verifyMailerFor(creds) {
  if (!companyMailConfigured(creds)) return { ok: false, error: 'חסר כתובת/סיסמת אפליקציה' };
  try { const t = await transporterFor(creds.user, creds.pass); await t.verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export default { mailerConfigured, forwardExpenseTo, sendMail, verifyMailer, companyMailConfigured, sendMailFrom, verifyMailerFor };
