// mailReader.js — קריאת תיבת Gmail (IMAP) פר-חברה עם App Password, לסריקת חשבוניות/קבלות נכנסות.
// אותה סיסמת אפליקציה ששולחת מיילים (mailer.js) מעניקה גם גישת קריאה ל-INBOX דרך imap.gmail.com:993.
let _ImapFlow = null, _simpleParser = null;
async function imapflow() { if (!_ImapFlow) _ImapFlow = (await import('imapflow')).ImapFlow; return _ImapFlow; }
async function mailparser() { if (!_simpleParser) _simpleParser = (await import('mailparser')).simpleParser; return _simpleParser; }

function conf(creds) {
  return { host: 'imap.gmail.com', port: 993, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false };
}

// ===== PDF מאחורי קישור בגוף המייל =====
// מזהה קישורים שנראים כמו חשבונית/PDF בגוף ההודעה, מוריד אותם בשרת, ומצרף אותם כאילו היו צרופה.
function extractPdfLinks(text) {
  if (!text) return [];
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>()\]]+/gi;
  let m;
  while ((m = re.exec(text)) && out.size < 8) {
    let u = m[0].replace(/[.,;]+$/, '').replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(u)) continue;
    // מועמד: קישור שנגמר ב-.pdf, או שנראה כמו הורדת חשבונית/קבלה/מסמך
    if (/\.pdf(\?|#|$)/i.test(u) || (/(invoice|receipt|download|getfile|attachment|document|בחשבונית|חשבונית|קבלה)/i.test(u) && /(pdf|download|file|invoice|receipt|doc)/i.test(u))) out.add(u);
  }
  return [...out];
}
function linkHostBlocked(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|::1)/.test(h) || /\.(local|internal|lan)$/.test(h);
  } catch { return true; }
}
async function fetchPdfLink(url) {
  if (linkHostBlocked(url)) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 bpm-mailscan' } });
    clearTimeout(to);
    if (!r || !r.ok) return null;
    const ct = String(r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (!(ct.includes('pdf') || ct.startsWith('image/'))) return null; // רק אם באמת PDF/תמונה — לא דף HTML
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null; // עד 8MB
    let filename = 'link.pdf';
    const cd = r.headers.get('content-disposition') || '';
    const mm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (mm) { try { filename = decodeURIComponent(mm[1]); } catch { filename = mm[1]; } }
    else { try { const p = new URL(url).pathname.split('/').pop(); if (p) filename = decodeURIComponent(p); } catch { } }
    if (ct.includes('pdf') && !/\.pdf$/i.test(filename)) filename += '.pdf';
    return { base64: buf.toString('base64'), mime: ct, size: buf.length, filename };
  } catch { clearTimeout(to); return null; }
}

// בדיקת חיבור: פותח INBOX, מחזיר ספירת הודעות כוללת + מאז תאריך, ומוודא שאפשר למשוך ולפרסר הודעה (imapflow+mailparser מקצה לקצה).
export async function imapTest(creds, since) {
  if (!creds || !creds.user || !creds.pass) return { ok: false, error: 'חסרים כתובת/סיסמת אפליקציה' };
  const ImapFlow = await imapflow();
  const client = new ImapFlow(conf(creds));
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let total = 0, sinceCount = 0, parserOk = false, lastSubject = '';
    try {
      total = client.mailbox.exists || 0;
      if (since) { const uids = await client.search({ since: new Date(since) }, { uid: true }); sinceCount = (uids || []).length; }
      if (total > 0) {
        const simpleParser = await mailparser();
        for await (const m of client.fetch('*', { source: true })) { // '*' = ההודעה האחרונה ברצף
          const parsed = await simpleParser(m.source);
          parserOk = !!parsed; lastSubject = (parsed && parsed.subject) || ''; break;
        }
      }
    } finally { lock.release(); }
    await client.logout();
    return { ok: true, total, sinceCount, parserOk, lastSubject };
  } catch (e) {
    try { await client.logout(); } catch {}
    try { await client.close(); } catch {}
    return { ok: false, error: e.message };
  }
}

// סריקת INBOX: מחזיר צרופות PDF/תמונה מהודעות מאז תאריך, למעט הודעות שכבר טופלו (excludeUids).
// עובד באצווה (limit הודעות) כדי לא לחרוג מ-timeout; מחזיר remaining כדי שהצד-לקוח יקרא שוב עד שיסיים.
export async function scanMailbox(creds, since, { excludeUids = [], limit = 10 } = {}) {
  if (!creds || !creds.user || !creds.pass) return { ok: false, error: 'חסרים כתובת/סיסמת אפליקציה' };
  const ImapFlow = await imapflow();
  const simpleParser = await mailparser();
  const client = new ImapFlow(conf(creds));
  const items = [];
  const processedUids = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let remaining = 0;
    try {
      const uids = (await client.search({ since: new Date(since) }, { uid: true })) || []; // עולה — ישן→חדש
      const exclude = new Set(excludeUids.map(String));
      const fresh = uids.filter(u => !exclude.has(String(u))).reverse(); // הופכים לסדר יורד — מעבדים מהחדש לישן (חשבוניות אחרונות נקלטות קודם)
      remaining = fresh.length;
      const use = fresh.slice(0, Math.max(1, limit)); // אצווה של החדשים ביותר שטרם נסרקו
      if (use.length) {
        for await (const msg of client.fetch(use, { source: true }, { uid: true })) {
          processedUids.push(msg.uid);
          let parsed; try { parsed = await simpleParser(msg.source); } catch { continue; }
          const atts = (parsed.attachments || []).filter(a => {
            const ct = String(a.contentType || '').toLowerCase();
            return ct.includes('pdf') || ct.startsWith('image/');
          });
          if (!atts.length) continue;
          const messageId = parsed.messageId || ('uid:' + msg.uid);
          const from = (parsed.from && parsed.from.text) || '';
          const subject = parsed.subject || '';
          const receivedDate = (parsed.date ? new Date(parsed.date).toISOString().slice(0, 10) : '');
          atts.forEach((a, i) => {
            if (!a.content || !a.content.length) return;
            items.push({
              messageId, uid: msg.uid, attIndex: i, from, subject, receivedDate,
              filename: a.filename || `attachment-${i + 1}`,
              mime: String(a.contentType || 'application/octet-stream').split(';')[0].trim(),
              size: a.content.length, contentBase64: a.content.toString('base64'),
            });
          });
          // אין צרופה? מנסים למצוא PDF מאחורי קישור בגוף המייל (חשבוניות שנשלחות כלינק). לעולם לא זורק שגיאה.
          if (!atts.length) {
            try {
              const urls = extractPdfLinks(`${parsed.html || ''}\n${parsed.text || ''}`);
              let li = 0;
              for (const u of urls.slice(0, 4)) {
                const got = await fetchPdfLink(u).catch(() => null);
                if (got && got.base64) {
                  items.push({
                    messageId, uid: msg.uid, attIndex: 'L' + (li++), from, subject, receivedDate,
                    filename: got.filename || `link-${li}.pdf`, mime: got.mime, size: got.size,
                    contentBase64: got.base64, viaLink: true, sourceUrl: u,
                  });
                }
              }
            } catch { /* קישורים — לא קריטי */ }
          }
        }
      }
      remaining = Math.max(0, remaining - use.length);
    } finally { lock.release(); }
    await client.logout();
    return { ok: true, items, processedUids, remaining };
  } catch (e) {
    try { await client.logout(); } catch {}
    try { await client.close(); } catch {}
    return { ok: false, error: e.message };
  }
}

export default { imapTest, scanMailbox };
