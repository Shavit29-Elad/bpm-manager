// mailReader.js — קריאת תיבת Gmail (IMAP) פר-חברה עם App Password, לסריקת חשבוניות/קבלות נכנסות.
// אותה סיסמת אפליקציה ששולחת מיילים (mailer.js) מעניקה גם גישת קריאה ל-INBOX דרך imap.gmail.com:993.
let _ImapFlow = null, _simpleParser = null;
async function imapflow() { if (!_ImapFlow) _ImapFlow = (await import('imapflow')).ImapFlow; return _ImapFlow; }
async function mailparser() { if (!_simpleParser) _simpleParser = (await import('mailparser')).simpleParser; return _simpleParser; }

function conf(creds) {
  return { host: 'imap.gmail.com', port: 993, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false };
}

// ===== PDF מאחורי קישור בגוף המייל =====
// הרבה ספקים (מורנינג/mrng.to, פנגו, תפנית, Booking, iCount וכו') שולחים *הודעה עם לינק* להורדת החשבונית,
// במקום צרופה. כאן מזהים קישורים כאלה, עוקבים אחרי הפניות, ואם הלינק מוביל לעמוד HTML — קופצים פעם אחת
// לתוך העמוד כדי לאתר את קובץ ה-PDF/תמונה האמיתי, ומצרפים אותו כאילו היה צרופה.
const INVOICE_LINK_HOSTS = /(mrng\.to|morning\.co|greeninvoice|ezcount|icount|sumit|rivhit|tafnit|pango|cellopark|booking\.com|expedia|hotel|invoice|fatoora|myinvoice|docs?\.|drive\.google|dropbox|wetransfer)/i;
const LINK_NOISE = /(unsubscribe|preferences|privacy|policy|terms|facebook|instagram|twitter|linkedin|youtube|wa\.me|whatsapp|mailto:|tel:|\.css|\.js\b|track|pixel|beacon|utm_|\/click\?)/i;
function extractPdfLinks(text) {
  if (!text) return [];
  const out = new Set();
  const re = /https?:\/\/[^\s"'<>()\[\]]+/gi;
  let m;
  while ((m = re.exec(text)) && out.size < 24) {
    let u = m[0].replace(/[.,;]+$/, '').replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(u)) continue;
    const isPdf = /\.pdf(\?|#|$)/i.test(u);
    if (!isPdf && LINK_NOISE.test(u)) continue; // סינון רעש (הסרה מרשימה, רשתות חברתיות, טרקינג) — אלא אם זה PDF ישיר
    const looksDoc = /(invoice|receipt|download|getfile|attachment|document|בחשבונית|חשבונית|קבלה|\/doc|\/file|export)/i.test(u);
    if (isPdf || INVOICE_LINK_HOSTS.test(u) || looksDoc) out.add(u);
  }
  const pdfFirst = (u) => /\.pdf(\?|#|$)/i.test(u) ? 2 : INVOICE_LINK_HOSTS.test(u) ? 1 : 0;
  return [...out].sort((a, b) => pdfFirst(b) - pdfFirst(a));
}
function linkHostBlocked(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|::1)/.test(h) || /\.(local|internal|lan)$/.test(h);
  } catch { return true; }
}
// מוצא בתוך HTML של עמוד נחיתה קישורים שנראים כמו קובץ מסמך (pdf/הורדה) — לקפיצה שנייה אל הקובץ עצמו.
function extractDocLinksFromHtml(html, baseUrl) {
  if (!html) return [];
  const out = new Set();
  const attrRe = /(?:href|src|data-href|data-url|data-download|content)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html)) && out.size < 60) {
    let raw = m[1].replace(/&amp;/g, '&').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    let abs; try { abs = new URL(raw, baseUrl).href; } catch { continue; }
    if (!/^https?:\/\//i.test(abs)) continue;
    const isPdf = /\.pdf(\?|#|$)/i.test(abs);
    if (!isPdf && LINK_NOISE.test(abs)) continue;
    if (isPdf || /(download|getfile|attachment|\/pdf|\/file\/|\/files\/|document|invoice|receipt|export|\.pdf)/i.test(abs)) out.add(abs);
  }
  const pdfFirst = (u) => /\.pdf(\?|#|$)/i.test(u) ? 1 : 0;
  return [...out].sort((a, b) => pdfFirst(b) - pdfFirst(a));
}
async function fetchPdfLink(url, depth = 0) {
  if (linkHostBlocked(url)) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bpm-mailscan/1.0)', 'Accept': 'application/pdf,image/*,text/html;q=0.9,*/*;q=0.8' } });
    clearTimeout(to);
    if (!r || !r.ok) return null;
    const ct = String(r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const finalUrl = r.url || url;
    if (ct.includes('pdf') || ct.startsWith('image/')) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 12 * 1024 * 1024) return null;
      let filename = 'link.pdf';
      const cd = r.headers.get('content-disposition') || '';
      const mm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (mm) { try { filename = decodeURIComponent(mm[1]); } catch { filename = mm[1]; } }
      else { try { const p = new URL(finalUrl).pathname.split('/').pop(); if (p) filename = decodeURIComponent(p); } catch { } }
      if (ct.includes('pdf') && !/\.pdf$/i.test(filename)) filename += '.pdf';
      return { base64: buf.toString('base64'), mime: ct, size: buf.length, filename };
    }
    // עמוד HTML של ספק → קפיצה אחת אל קובץ המסמך שבתוכו
    if (depth < 1 && (ct.includes('html') || ct === 'text/plain' || ct === '')) {
      const html = await r.text().catch(() => '');
      if (!html || html.length > 5 * 1024 * 1024) return null;
      for (const c of extractDocLinksFromHtml(html, finalUrl).slice(0, 6)) {
        if (c === url || c === finalUrl) continue;
        const got = await fetchPdfLink(c, depth + 1).catch(() => null);
        if (got && got.base64) return got;
      }
    }
    return null;
  } catch { clearTimeout(to); return null; }
}
// האם ההודעה "נראית" כמו חשבונית — לפי נושא/שולח/קישורי-ספק — כדי לא לאבד חשבוניות שהלינק שלהן לא נפתח
function looksLikeInvoiceMail(subject, from, hasHostLink) {
  const s = `${subject || ''} ${from || ''}`;
  return hasHostLink || /(חשבונית|קבלה|חשבון עסקה|דרישת תשלום|invoice|receipt|תשלום|מס[- ]?קבלה)/i.test(s);
}

// בדיקת חיבונ: פותח INBOX, מחזיר ספירת הודעות כוללת + מאז תאריך, ומוודא שאפשר למשפים ולפרסר הודעה (imapflow+mailparser מקצה לקצה).
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
        for await (const m of client.fetch('*', { source: true })) {
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
// עובד באצווה (limit הודעות) כדי לא לחרוג מ�timeout; מחזיר remaining כדי שהצד-לקוח יקרא שוב עד שיסיים.
export async function scanMailbox(creds, since, { excludeUids = [], limit = 10 } = {}) {
  if (!creds || !creds.user || !creds.pass) return { ok: false, error: 'חסרים כתובת/סיסמת אפליקציה' };
  const ImapFlow = await imapflow();
  const simpleParser = await mailparser();
  const client = new ImapFlow(conf(creds));
  const items = [];
  const processedUids = [];
  const unresolved = []; // הודעות שנראות כמו חשבונית אך לא הצלחנו לחלץ מהן מסמך (לינק שלא נפתח) — לרשת ביטחון
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let remaining = 0;
    try {
      const uids = (await client.search({ since: new Date(since) }, { uid: true })) || [];
      const exclude = new Set(excludeUids.map(String));
      const fresh = uids.filter(u => !exclude.has(String(u))).reverse();
      remaining = fresh.length;
      const use = fresh.slice(0, Math.max(1, limit));
      if (use.length) {
        for await (const msg of client.fetch(use, { source: true }, { uid: true })) {
          processedUids.push(msg.uid);
          let parsed; try { parsed = await simpleParser(msg.source); } catch { continue; }
          const atts = (parsed.attachments || []).filter(a => {
            const ct = String(a.contentType || '').toLowerCase();
            if (ct.includes('pdf')) return true;
            if (!ct.startsWith('image/')) return false;
            const inline = String(a.contentDisposition || '').toLowerCase() === 'inline' || a.related === true || !!a.cid;
            const size = a.size || (a.content ? a.content.length : 0);
            if (inline || (size && size < 20000)) return false;
            return true;
          });
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
          if (!atts.length) {
            let gotAny = false, urls = [];
            try {
              urls = extractPdfLinks(`${parsed.html || ''}\n${parsed.text || ''}`);
              let li = 0;
              for (const u of urls.slice(0, 6)) {
                const got = await fetchPdfLink(u).catch(() => null);
                if (got && got.base64) {
                  gotAny = true;
                  items.push({
                    messageId, uid: msg.uid, attIndex: 'L' + (li++), from, subject, receivedDate,
                    filename: got.filename || `link-${li}.pdf`, mime: got.mime, size: got.size,
                    contentBase64: got.base64, viaLink: true, sourceUrl: u,
                  });
                }
              }
            } catch { }
            // רשת ביטחון: אם לא הצלחנו לחלץ מסמך אך ההודעה נראית כמו חשבונית — לא מאבדים אותה
            const hostLink = urls.find(u => INVOICE_LINK_HOSTS.test(u)) || urls[0] || null;
            if (!gotAny && looksLikeInvoiceMail(subject, from, !!hostLink)) {
              unresolved.push({ uid: msg.uid, messageId, from, subject, receivedDate, link: hostLink });
            }
          }
        }
      }
      remaining = Math.max(0, remaining - use.length);
    } finally { lock.release(); }
    await client.logout();
    return { ok: true, items, processedUids, remaining, unresolved };
  } catch (e) {
    try { await client.logout(); } catch {}
    try { await client.close(); } catch {}
    return { ok: false, error: e.message };
  }
}

// סימון הודעות כ"נקראו" (\Seen) ב-INBOX — נקרא רק על הודעות שמהן נלקח מסמך לקליטה בפועל.
export async function markMessagesSeen(creds, uids) {
  const list = [...new Set((uids || []).map(Number).filter(Boolean))];
  if (!creds || !creds.user || !creds.pass || !list.length) return { ok: false, count: 0 };
  const ImapFlow = await imapflow();
  const client = new ImapFlow(conf(creds));
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try { await client.messageFlagsAdd(list, ['\\Seen'], { uid: true }); }
    finally { lock.release(); }
    await client.logout();
    return { ok: true, count: list.length };
  } catch (e) {
    try { await client.logout(); } catch { }
    try { await client.close(); } catch { }
    return { ok: false, error: e.message };
  }
}

export default { imapTest, scanMailbox, markMessagesSeen };
