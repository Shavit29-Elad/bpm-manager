// lib/whatsappBridge.js
// גשר אופציונלי לווטסאפ ווב (whatsapp-web.js). קריאה בלבד - לא שולח הודעות.
// נטען רק אם WHATSAPP_BRIDGE=on ואם החבילה מותקנת, כדי שהמערכת תרוץ גם בלעדיו.
//
// אזהרה: זהו חיבור לא-רשמי לווטסאפ. השימוש עלול לנגוד את תנאי השימוש של ווטסאפ
// וקיים סיכון תיאורטי לחסימת המספר. מומלץ להריץ על מספר עסקי ולא ראשי.

let clientRef = null;
let lastQr = null;
let status = 'stopped';

export function getBridgeStatus() {
  return { status, hasQr: Boolean(lastQr), qr: lastQr };
}

// onEvent(parsedEvent) - callback שמקבל הודעה שנקלטה ומעביר לפרסור/שמירה
export async function startWhatsappBridge(onMessageText) {
  if (process.env.WHATSAPP_BRIDGE !== 'on') {
    status = 'disabled';
    return { ok: false, reason: 'הגשר כבוי (WHATSAPP_BRIDGE!=on). המערכת עובדת בשיטת הדבקה ידנית.' };
  }
  let wweb, qrcode;
  try {
    wweb = await import('whatsapp-web.js');
    qrcode = await import('qrcode-terminal');
  } catch {
    status = 'missing-package';
    return { ok: false, reason: 'החבילה whatsapp-web.js לא מותקנת. הרץ: npm install whatsapp-web.js qrcode-terminal' };
  }

  const { Client, LocalAuth } = wweb.default || wweb;
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './data/wwebjs_auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => {
    lastQr = qr;
    status = 'awaiting-qr';
    (qrcode.default || qrcode).generate(qr, { small: true });
    console.log('סרוק את קוד ה-QR מווטסאפ ווב בטלפון כדי לחבר את הגשר.');
  });
  client.on('ready', () => { status = 'connected'; lastQr = null; console.log('גשר ווטסאפ מחובר.'); });
  client.on('disconnected', () => { status = 'disconnected'; });

  client.on('message', async (msg) => {
    try {
      if (!msg.body) return;
      await onMessageText(msg.body, { from: msg.from, timestamp: msg.timestamp });
    } catch (e) {
      console.error('שגיאה בעיבוד הודעת ווטסאפ:', e.message);
    }
  });

  await client.initialize();
  clientRef = client;
  return { ok: true };
}

export default { startWhatsappBridge, getBridgeStatus };
