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

export async function sendMail({ to, subject, text, html, attachments }) {
  if (!mailerConfigured()) throw new Error('שליחת מייל לא מוגדרת (חסר SMTP_USER/SMTP_PASS)');
  const t = await transporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  return t.sendMail({ from, to, subject, text, html, attachments });
}

// בדיקת חיבור (לאימות שהאישורים תקינים)
export async function verifyMailer() {
  if (!mailerConfigured()) return { ok: false, error: 'חסר SMTP_USER/SMTP_PASS' };
  try { const t = await transporter(); await t.verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

export default { mailerConfigured, forwardExpenseTo, sendMail, verifyMailer };
