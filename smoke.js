// smoke.js — בדיקת עשן לפני פריסה. הרצה: node smoke.js
//
// למה זה קיים: `node --check` בודק תחביר בלבד. הוא עובר בהצלחה גם על קוד
// שמפנה למשתנה שלא קיים, ועל HTML שנשבר בזמן ריצה. שני באגים אמיתיים חמקו
// דרכו — כלל CSS חסר שהשבית שלוש פונקציות, ומשתנה לא מוגדר שהקפיא חלונית.
//
// הבדיקה כאן מריצה קוד בפועל: מאתחלת פונקציות רינדור מ-app.js מול DOM מדומה,
// מעלה את השרת ודופקת ב-endpoints, ומאמתת כללי-עקביות שקל לשבור בשקט.

import fs from 'fs';
import zlibMod from 'node:zlib';
import { execSync } from 'child_process';

const app = fs.readFileSync('app.js', 'utf8');
const srv = fs.readFileSync('server.js', 'utf8');
// בדיקות אסינכרוניות נאספות כאן ומאומתות בסוף, אחרי כל הבדיקות הסינכרוניות
const pendingAsync = [];
// אותו נרמול שבקוד — לבדיקות שמצריכות אותו כתלות
const giLinkedIds = (d) => [...new Set([].concat(d?.linkedDocuments || [], d?.linkedDocumentIds || [])
  .map(x => (x && typeof x === 'object') ? x.id : x).filter(x => x != null && String(x)).map(String))];
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');

let pass = 0, fail = 0;
const ok = (t) => { pass++; console.log(`  ✓ ${t}`); };
const bad = (t, d) => { fail++; console.log(`  ✗ ${t}${d ? '\n      ' + d : ''}`); };
const check = (t, fn) => {
  try {
    const r = fn();
    // בדיקה אסינכרונית החזירה Promise. קודם הוא נחשב "לא false" ולכן כל בדיקה
    // כזו נספרה כעוברת בלי שאיש בדק אותה. עכשיו ממתינים לה בסוף הריצה.
    if (r && typeof r.then === 'function') {
      pendingAsync.push(r.then(v => { v === false ? bad(t) : ok(t); }, e => bad(t, e.message)));
      return;
    }
    r === false ? bad(t) : ok(t);
  } catch (e) { bad(t, e.message); }
};
// אזהרה — מדווחת ולא מפילה. לבדיקות היוריסטיות שיש בהן התראות שווא.
const warn = (t, fn) => { try { fn(); ok(t); } catch (e) { console.log(`  ⚠ ${t}\n      ${e.message}`); } };

console.log('\n── תחביר ──');
for (const f of ['server.js', 'app.js', 'chat.js', 'mailReader.js', 'dailyReport.js', 'backup.js']) {
  check(f, () => { execSync(`node --check ${f}`, { stdio: 'pipe' }); });
}

console.log('\n── סנכרון לשוניות (שלושה מקומות שחייבים להתאים) ──');
const validTabs = new Set((srv.match(/const VALID_TABS = \[(.*?)\]/s)?.[1] || '').replace(/['\s]/g, '').split(',').filter(Boolean));
const htmlTabs = new Set([...html.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]));
const labels = new Set([...(app.match(/TAB_LABELS\s*=\s*\{(.*?)\}/s)?.[1] || '').matchAll(/(\w+)\s*:/g)].map(m => m[1]));
check('כל לשונית ב-HTML מופיעה ב-TAB_LABELS', () => {
  const miss = [...htmlTabs].filter(t => !labels.has(t));
  return miss.length ? bad('', 'חסרות: ' + miss) === undefined && false : true;
});
check('כל לשונית ב-VALID_TABS קיימת ב-HTML', () => {
  const miss = [...validTabs].filter(t => !htmlTabs.has(t));
  if (miss.length) throw new Error('קיימות בשרת ולא ב-HTML: ' + miss);
  return true;
});
check('לכל לשונית ב-HTML יש פונקציית רינדור', () => {
  const map = app.match(/const TAB_RENDERERS = \{(.*?)\};/s)?.[1] || '';
  if (!map) throw new Error('TAB_RENDERERS לא נמצאה');
  const routed = new Set([...map.matchAll(/(\w+):\s*render/g)].map(m => m[1]));
  const miss = [...htmlTabs].filter(t => !routed.has(t));
  if (miss.length) throw new Error('בלי רינדור: ' + miss);
  // render() ו-_softRerender חייבים לשאוב מאותה מפה — אחרת רענון הרקע יצייר לשונית אחרת
  if (!/\(TAB_RENDERERS\[state\.tab\]\)\(c\)/.test(app)) throw new Error('render() לא משתמש ב-TAB_RENDERERS');
  if (!/const fn = c && TAB_RENDERERS\[state\.tab\]/.test(app)) throw new Error('_softRerender לא משתמש ב-TAB_RENDERERS');
  return true;
});

console.log('\n── CSS שהקוד מסתמך עליו ──');
check('.hidden מוגדר גלובלית', () => {
  if (!/^\.hidden\s*\{/m.test(css)) throw new Error('classList.toggle("hidden") לא יסתיר כלום');
  return true;
});

console.log('\n── פונקציות שהקוד קורא להן ──');
const declared = new Set([
  ...[...app.matchAll(/^(?:async )?function (\w+)/gm)].map(m => m[1]),
  ...[...app.matchAll(/^(?:const|let|var) (\w+)\s*=/gm)].map(m => m[1]),
  ...[...app.matchAll(/^window\.(\w+)\s*=/gm)].map(m => m[1]),
  ...[...app.matchAll(/window\.(\w+)\s*=/g)].map(m => m[1]),
]);
const BUILTINS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'await', 'else', 'do', 'try']);
const called = [...app.matchAll(/onclick="(\w+)\(/g)].map(m => m[1])
  .concat([...app.matchAll(/oninput="(\w+)\(/g)].map(m => m[1]))
  .concat([...app.matchAll(/onchange="(\w+)\(/g)].map(m => m[1]));
check('כל onclick/oninput/onchange מצביע לפונקציה קיימת', () => {
  const miss = [...new Set(called)].filter(n => !declared.has(n) && !BUILTINS.has(n));
  if (miss.length) throw new Error('לא מוגדרות: ' + miss.join(', '));
  return true;
});

console.log('\n── משתני מודול ──');
check('אין משתנה שבשימוש בלי הכרזה', () => {
  // באג חוזר: תיקון שנכשל באמצע משאיר הפניה למשתנה שמעולם לא הוכרז.
  // node --check עובר על זה בשקט — זו שגיאת ריצה, לא תחביר.
  // רק שימוש כמשתנה: לא אחרי נקודה (תכונה של אובייקט), לא מפתח באובייקט,
  // ולא בתוך מחרוזת. אחרת מתקבלות התראות שווא כמו _blank מתוך target="_blank".
  const src = app.replace(/'[^'\n]*'|"[^"\n]*"/g, "''");
  const used = new Set([...src.matchAll(/(?<![.\w$])(_[a-zA-Z][a-zA-Z0-9_]*)\b(?!\s*:)/g)].map(m => m[1]));
  const declared = new Set([
    ...[...app.matchAll(/(?:let|const|var)\s+([^;\n]+)/g)]
      .flatMap(m => m[1].split(',').map(x => x.trim().split(/[\s=({[]/)[0])).filter(Boolean),
    ...[...app.matchAll(/function\s+(\w+)/g)].map(m => m[1]),
    ...[...app.matchAll(/window\.(\w+)\s*=/g)].map(m => m[1]),
    // רק רשימות פרמטרים אמיתיות. הדפוס "(...)\s*{" תופס גם if/for/while, ואז
    // תנאי כמו "if (_x && ...)" נספר כהצהרה של _x — והבדיקה מפספסת את הבאג.
    ...[...app.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)].flatMap(m => m[1].split(',').map(x => x.trim().split(/[\s=]/)[0])),
    ...[...app.matchAll(/\(([^)]*)\)\s*=>/g)].flatMap(m => m[1].split(',').map(x => x.trim().split(/[\s=]/)[0])),
    ...[...app.matchAll(/catch\s*\((\w+)\)/g)].map(m => m[1]),
    ...[...app.matchAll(/for\s*\((?:const|let|var)\s+(\w+)/g)].map(m => m[1]),
  ]);
  const miss = [...used].filter(v => !declared.has(v));
  if (miss.length) throw new Error('בשימוש בלי הכרזה: ' + miss.join(', '));
  return true;
});

console.log('\n── בידוד חברות ──');
warn('ראוטים שנוגעים בנתוני חברה בלי ownedBy (לבדיקה ידנית)', () => {
  const risky = [];
  const lines = srv.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^add\('(POST|PUT|DELETE)'/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^\}\);/.test(lines[j])) j++;
    const body = lines.slice(i, j).join('\n');
    if (/db\.(events|bankTx|txGroups|oldInvoices|supplierPayables)\b/.test(body) && !/ownedBy\(/.test(body)) {
      risky.push((lines[i].match(/\/\^([^,]+)/) || [])[1] || `שורה ${i + 1}`);
    }
  }
  if (risky.length) throw new Error('בלי ownedBy:\n      ' + risky.join('\n      '));
  return true;
});

console.log('\n── בניית חלוניות מול DOM מדומה ──');
// מריץ בפועל את פונקציות הבנייה שהיו נשברות בזמן ריצה בלי ש-node --check יבחין
// חילוץ גוף פונקציה לפי איזון סוגריים — lastIndexOf('};') נכשל כשיש '};' בפנים
function fnBody(src, start) {
  const open = src.indexOf('{', start);
  let depth = 0, inStr = null, esc = false, tpl = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k], prev = src[k - 1];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === '`') { tpl = tpl ? 0 : 1; continue; }
    if (tpl) { if (c === '$' && src[k + 1] === '{') { depth++; k++; } else if (c === '}' && depth > 0) depth--; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '/' && (prev === '/' )) { while (k < src.length && src[k] !== '\n') k++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open + 1, k); }
  }
  throw new Error('לא נמצא סוף הפונקציה');
}

function fakeDom() {
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', options: [],
    appendChild() {}, remove() {}, focus() {}, setSelectionRange() {}, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {}, click() {} });
  return { getElementById: () => el(), createElement: () => el(), querySelectorAll: () => [],
    querySelector: () => null, body: { appendChild() {} }, addEventListener() {} };
}
check('openEditPayable נבנית בלי שגיאת ריצה', () => {
  const i = app.indexOf('window.openEditPayable = (pid) => {');
  const j = app.indexOf('window.savePayableEdit');
  if (i < 0 || j < 0) throw new Error('הפונקציה לא נמצאה');
  const body = fnBody(app, i);
  const stubs = `
    const escAttr=(x)=>String(x==null?'':x), escapeHtml=(x)=>String(x==null?'':x);
    const money=(n)=>String(n), ddmy=(d)=>String(d||'');
    const _suppliers=[{id:'s1',name:'ספק'}];
    const _supPayables=[{id:'pay1',supplierName:'ספק',number:'1',amount:9000,amountExcludeVat:7692,documentType:300,hasFile:true,
      coveredEvents:[{eventId:'ev1',index:0,date:'2026-08-05',artist:'א',location:'ב',amount:4500},
                     {eventId:'ev2',index:0,date:'2026-08-06',artist:'ג',location:'ד',amount:4500}]}];
    function epLoadFile(){} function epRecalcCov(){}
  `;
  const fn = new Function('document', `${stubs}\nconst pid='pay1';\n${body}`);
  fn(fakeDom());
  return true;
});
check('כל יצירת לקוח/ספק מנקה את מטמון ה-API', () => {
  // בלי זה api() מחזיר תשובה מהמטמון (60 שניות) בלי הרשומה החדשה, והמשתמש
  // מחפש ספק שהרגע הוסיף ולא מוצא אותו.
  const L = app.split('\n');
  const bad = [];
  L.forEach((l, i) => {
    if (!l.includes("method: 'POST'")) return;
    if (!/\/api\/(suppliers|clients)'/.test(l)) return;
    if (!L.slice(i, i + 22).join('\n').includes('clearApiCache()')) bad.push(i + 1);
  });
  if (bad.length) throw new Error('מסלולים בלי clearApiCache בשורות: ' + bad.join(', '));
  return true;
});
check('החלפת חברה מאפסת את כל מטמוני הנתונים', () => {
  // באג אמיתי: רשימות הספקים/לקוחות/עובדים נטענות פעם אחת לכל טעינת דף
  // ("if (!_evSuppliers)"), ובלי איפוס בהחלפת חברה הן ממשיכות להציג את נתוני
  // החברה הקודמת — ספק חדש לא נמצא, ושמות של חברה אחת דולפים לתצוגה של אחרת.
  const m = app.match(/function resetCompanyCaches\(\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error('resetCompanyCaches לא קיימת');
  const reset = m[1];
  const must = ['_evSuppliers', '_evClients', '_evEmployees', '_suppliers', '_supPayables', '_bankList', 'clientsList'];
  const miss = must.filter(v => !reset.includes(v));
  if (miss.length) throw new Error('לא מאופסים: ' + miss.join(', '));
  const onchange = app.match(/sel\.onchange = \(\) => \{[^\n]*/)?.[0] || '';
  if (!onchange.includes('resetCompanyCaches()')) throw new Error('לא נקראת בהחלפת חברה');
  return true;
});
check('שמירת אירוע לא מוחקת שדות קישור של שורות קבלן', () => {
  // הבדיקה הקודמת בדקה רק את *טעינת* העורך, ולכן עברה בזמן שהבאג עדיין חי:
  // ההשמטה קרתה ב-collectEventBody, במסלול היציאה. כאן נבדק המסלול הזה.
  const L = app.split('\n');
  const i = L.findIndex(l => l.includes('const ctr = _evCtr.filter'));
  if (i < 0) throw new Error('לא נמצאה בניית ctr');
  const fn = new Function('_evCtr', 'num', L[i] + '\nreturn ctr;');
  const row = fn([{ name: 'ספק ', amount: '4000', paid: false, paidSource: 'manual',
    paidPayableId: 'pay_x', paidExpenseId: 'exp_9', paidInvoice: '500924', paidExpenseUrl: 'u', handled: true }],
    (x) => (x === '' || x == null || isNaN(+x) ? null : +x))[0];
  const lost = ['paidPayableId', 'paidExpenseId', 'paidSource', 'paidInvoice', 'paidExpenseUrl', 'handled']
    .filter(k => row[k] === undefined);
  if (lost.length) throw new Error('שדות שנמחקים בשמירה: ' + lost.join(', '));
  if (row.amount !== 4000) throw new Error('הסכום לא נשמר: ' + row.amount);
  return true;
});
check('עורך האירוע לא מוחק שדות קישור של שורות קבלן', () => {
  // באג אמיתי: הרשימה נבנתה מחדש עם שדות נבחרים בלבד, ולכן פתיחת אירוע ושמירתו
  // מחקה את paidPayableId — והשיוך להוצאת הספק נעלם בלי שנגעו בכלום.
  const L = app.split('\n');
  const i = L.findIndex(l => l.includes('_evCtr = (ev.contractorDetails'));
  if (i < 0) throw new Error('לא נמצאה בניית _evCtr');
  const code = L[i] + '\n' + L[i + 1];
  const fn = new Function('ev', 'let _evCtr;\n' + code + '\nreturn _evCtr;');
  const row = fn({ contractorDetails: [{ name: 'ספק', amount: 4500, paid: true, paidSource: 'manual',
    paidPayableId: 'pay_x', paidExpenseId: 'exp_9', paidInvoice: '500924', paidExpenseUrl: 'u', handled: true }] })[0];
  const lost = ['paidPayableId', 'paidExpenseId', 'paidSource', 'paidInvoice', 'paidExpenseUrl', 'handled', 'paid']
    .filter(k => row[k] === undefined);
  if (lost.length) throw new Error('שדות שנמחקים: ' + lost.join(', '));
  return true;
});
check('buildReport מייצר מייל שלם', async () => true);

const mr = await import('./mailReader.js');
check('winmail.dat — חילוץ ה-PDF שבפנים', () => {
  // Outlook ב-RTF אורז את כל הצרופות לקובץ בינארי אחד. בלי פענוח הסורק רואה
  // קובץ שאינו PDF ומדלג, והחשבונית נעלמת בלי שום חיווי.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(120, 0x41)]);
  // כמו שאאוטלוק כותב בפועל: 16 הביטים העליונים של המזהה הם סוג הנתון.
  // השוואה של כל 32 הביטים לא מוצאת כלום — זה היה באג אמיתי.
  const attr = (type, id, data) => { const b = Buffer.alloc(9); b.writeUInt8(2, 0);
    b.writeUInt32LE(((type & 0xFFFF) << 16) | (id & 0xFFFF), 1); b.writeUInt32LE(data.length, 5);
    return Buffer.concat([b, data, Buffer.alloc(2)]); };
  const head = Buffer.alloc(6); head.writeUInt32LE(0x223E9F78, 0); head.writeUInt16LE(1, 4);
  const tnef = Buffer.concat([head, attr(0x0001, 0x8010, Buffer.from('INVOICE.PDF\0', 'latin1')), attr(0x0006, 0x800F, pdf)]);
  const out = mr.expandTnef([{ filename: 'winmail.dat', contentType: 'application/ms-tnef', content: tnef }]);
  if (!out.some(a => String(a.contentType).includes('pdf'))) throw new Error('ה-PDF לא חולץ');
  if (mr.extractTnefAttachments(Buffer.from('garbage')).length) throw new Error('קובץ פגום לא מוחזר ריק');
  const plain = mr.expandTnef([{ filename: 'a.pdf', contentType: 'application/pdf', content: pdf }]);
  if (plain[0].filename !== 'a.pdf') throw new Error('צרופה רגילה שונתה');
  return true;
});

check('חשבונית מותאמת בבנק נחשבת שולמה גם בלי רשומה מקומית', () => {
  // "רישום הוצאת ספק" נוצר רק כשקולטים חשבונית דרך האתר. חשבונית שנוצרה ישירות
  // בחשבונית ירוקה ומותאמת בבנק לא הייתה קיימת בחישוב, ולכן שיוך אליה לא סומן
  // כשולם — למרות שהכסף יצא בפועל.
  const fnSrc = srv.match(/const bankOnlyStatus = \(c\) => \{[\s\S]*?\n  \};/);
  if (!fnSrc) throw new Error('bankOnlyStatus לא קיימת');
  const nrm = (x) => String(x || '').trim().toLowerCase().replace(/^0+/, '');
  // bankOnlyStatus נשענת על rowDocKeys, שאוספת גם את המסמכים שמצורפים לשורה
  const keysSrc = srv.match(/const rowDocKeys = \(c\) => \{[\s\S]*?\n  \};/);
  if (!keysSrc) throw new Error('rowDocKeys לא קיימת');
  const fn = new Function('debitByKey', '_nrmExpKey', 'c', keysSrc[0] + fnSrc[0] + ' return bankOnlyStatus(c);');
  const keys = { 'num:40114': 16107 };
  if (!fn(keys, nrm, { paidInvoice: '40114' })) throw new Error('חשבונית מותאמת לא זוהתה כשולמה');
  if (fn(keys, nrm, { paidInvoice: '99999' })) throw new Error('חשבונית לא מותאמת סומנה כשולמה');
  if (fn(keys, nrm, {})) throw new Error('שורה בלי קישור סומנה כשולמה');
  // ובעיקר — שהפונקציה באמת מחוברת לשרשרת. בלי זה הבדיקה עוברת בזמן שהתיקון מנותק.
  if (!/v = bankOnlyStatus\(c\)/.test(srv)) throw new Error('bankOnlyStatus לא מחוברת לחישוב הסטטוס');
  // וכל מקורות הקישור נבדקים — כולל המסמכים שמצורפים לשורה בלוח
  if (!/for \(const k of rowDocKeys\(c\)\) \{ if \(statusByKey\[k\]\)/.test(srv))
    throw new Error('סטטוס התשלום אינו נגזר מכל המסמכים שמצביעים על השורה');
  if (!/for \(const d of \(c\.docs \|\| \[\]\)\) push\(d\.payableId, d\.number, d\.giExpenseId\)/.test(srv))
    throw new Error('docs[] אינם נכללים במקורות הקישור');
  return true;
});

check('קישור לחשבונית מחשבונית ירוקה יוצר רשומת הוצאה', () => {
  // בלי זה הקישור נשמר על האירועים אבל אין שורה במסך שתחתיה יוצגו — והפעולה
  // נראית כאילו לא עשתה כלום. זה היה המקרה של קבלה 40114.
  if (!/createdPayable/.test(srv)) throw new Error('לא נוצרת רשומה בקישור');
  if (!/!doc\.localOnly/.test(srv)) throw new Error('חסרה הגנה מפני יצירת כפילות לרשומה מקומית');
  if (!/String\(p\.giExpenseId \|\| ''\) === String\(doc\.id\)/.test(srv)) throw new Error('חסרה בדיקת קיום לפי מזהה GI');
  if (!/createdPayable \|\| \(db\.supplierPayables/.test(srv)) throw new Error('הקישור לא מצביע לרשומה החדשה');
  return true;
});

check('מחיקת הוצאת ספק — ברירת המחדל לא נוגעת בחשבונית ירוקה', () => {
  if (!/body && body\.alsoGi === true/.test(srv)) throw new Error('המחיקה מ-GI אינה מותנית בדגל מפורש');
  if (!/greenInvoice\.deleteExpense\(p\.giExpenseId\)/.test(srv)) throw new Error('אין מחיקה בפועל מחשבונית ירוקה');
  if (!/alsoGi/.test(app)) throw new Error('הפרונט לא שולח את הדגל');
  return true;
});

const bm = await import('./bankMatch.js');
check('הקבלה מוצגת לצד חשבונית המס, ותאריך התשלום אחיד', () => {
  const f = new Function(app.match(/const payDateFmt = \(d\) => \{[\s\S]*?\n\};/)[0] + '; return payDateFmt;')();
  for (const [inp, want] of [['2026-07-21', '21/07/2026'], ['05/08/2026', '05/08/2026'], ['', ''], [null, '']])
    if (f(inp) !== want) throw new Error(`${inp} → ${f(inp)} במקום ${want}`);
  if (!/\.join\(''\) \+ payTag/.test(app)) throw new Error('תג מסמך התשלום לא מצורף לשורה');
  if (!/String\(d\.number\) === String\(pd\.number\)/.test(app))
    throw new Error('הקבלה עלולה להופיע פעמיים כשהיא כבר מקושרת לאירוע');
  if (!/pd && pd\.url \? `previewDoc/.test(app))
    throw new Error('קבלה ששמורה עם קישור בלבד (בלי מזהה) לא ניתנת לפתיחה');
  if (!/שולם ✓\$\{paidOn\}/.test(app)) throw new Error('תאריך התשלום לא מוצג');
  return true;
});

check('לשונית האירועים מקבלת את סטטוס התשלום מהשרת', () => {
  // השרת מחשב אותו עם אותה פונקציה שמשרתת את "קבלנים לתשלום" — לא חישוב נפרד
  if (!/ev\.clientPayStatus = eventClientPaid\(ev, bankPaid, openNums\)/.test(srv))
    throw new Error('הראוט לא מצרף clientPayStatus');
  // ההשלמה חייבת לקרות לפני חישוב הסטטוס — אחרת חשבונית המס שנמצאה לא נלקחת בחשבון
  const evRoute = srv.slice(srv.indexOf("add('GET', /^\\/api\\/events$/"));
  const iDerive = evRoute.indexOf('resolveConvertedInvoice');
  const iStatus = evRoute.indexOf('ev.clientPayStatus =');
  if (iDerive < 0 || iStatus < 0 || iDerive > iStatus)
    throw new Error('הסטטוס מחושב לפני השלמת חשבונית המס');
  if (!/linkedDocs: docs/.test(srv)) throw new Error('המסמך שהושלם לא מוזרק לאירוע');
  // ההשלמה היא לתצוגה בלבד — אירועים לא נשמרים מחדש
  const evBody = srv.slice(srv.indexOf("add('GET', /^\\/api\\/events$/"));
  const evEnd = evBody.indexOf('\n});');
  if (/save\(db2\); *\n(?![\s\S]*?docChain)/.test(evBody.slice(0, evEnd)) && !/db2\.docChain = work\.docChain/.test(evBody.slice(0, evEnd)))
    throw new Error('הראוט שומר משהו מעבר למטמון השרשרת');
  // רק המקרה שבו האירוע תקוע על חשבון עסקה — לא שולפים לכל אירוע
  if (!/stuckOnProforma/.test(srv)) throw new Error('אין הגבלה למקרה של חשבון עסקה בלבד');
  if (!/chainBudget/.test(srv)) throw new Error('אין תקציב שליפות');
  const chain = srv.match(/async function resolveConvertedInvoice[\s\S]*?\n\}\n/)[0];
  if (!/\[305, 320\]\.includes\(Number\(d\.type\)\)/.test(chain)) throw new Error('מס-קבלה לא מזוהה כתוצאת המרה');
  if (!/catch \{ return null; \}/.test(chain)) throw new Error('תקלת רשת עלולה לשבור את טעינת האירועים');
  // הקישור נשמר על המסמך הנגזר ומצביע למקור (ראה linkedDocumentSet ביצירת מסמך המשך).
  // חיפוש בכיוון ההפוך — מה מקושר לחשבון העסקה — לא מוצא כלום.
  if (!/pointsAtSource/.test(chain)) throw new Error('החיפוש בכיוון ההפוך — לא ימצא מסמך המשך');
  const iDirect = chain.indexOf('const direct = list.find');
  const iConfirm = chain.indexOf('pointsAtSource(greenInvoice.linkedIdsOf(raw))');
  if (iDirect < 0 || iConfirm < 0) throw new Error('חסר אחד ממסלולי האיתור');
  if (iDirect > iConfirm) throw new Error('המסלול היקר רץ לפני הזול');
  // צמצום לפי לקוח/סכום הוא ניחוש — האימות מול הקישור הוא מה שמכריע
  const confirmBlock = chain.slice(chain.indexOf('const cands ='), chain.indexOf('// 3)'));
  if (!/pointsAtSource\(greenInvoice\.linkedIdsOf\(raw\)\)/.test(confirmBlock))
    throw new Error('מסמך נבחר לפי לקוח וסכום בלי אימות הקישור');
  // חשבונית ירוקה מחזירה linkedDocuments (אובייקטים), ושולחים לה linkedDocumentIds.
  // קריאת שם השדה של הבקשה בתוך התשובה החזירה שרשרת ריקה תמיד.
  const giSrc = fs.readFileSync('greenInvoice.js', 'utf8');
  if (!/linkedDocumentIds: linkedIdsOf\(d\)/.test(giSrc))
    throw new Error('רשימת המסמכים לא נושאת את הקישור');
  const norm = giSrc.slice(giSrc.indexOf('export function linkedIdsOf'), giSrc.indexOf('function mapDoc'));
  if (!/linkedDocuments/.test(norm)) throw new Error('הנרמול אינו קורא את linkedDocuments');
  const ids = new Function(norm.replace('export function', 'function') + '\nreturn linkedIdsOf;')();
  const got = ids({ linkedDocuments: [{ id: 'a', type: 300 }, { id: 'b' }] });
  if (got.join(',') !== 'a,b') throw new Error('נרמול linkedDocuments נכשל: ' + got);
  if (ids({ linkedDocumentIds: ['c'] }).join(',') !== 'c') throw new Error('נרמול linkedDocumentIds נכשל');
  if (ids({}).length) throw new Error('מסמך בלי קישורים החזיר ערכים');
  if (!/buildBankPaidMap\(db, cid\)/.test(srv)) throw new Error('הראוט לא משתמש במפת הבנק');
  if (/clientPaid: eventClientPaid\(e, bankPaid, openNums\)\s*\}\)\);/.test(srv))
    throw new Error('דורס את clientPaid — שדה בוליאני קיים על אירוע שמור');

  const src = app.match(/function evPayState\(e\) \{[\s\S]*?\n\}/)[0];
  const f = new Function('isNoInvoiceEv', 'activeLinkedDocs',
    src + '; return evPayState;')(e => !!e.noInvoice, e => e.linkedDocs || []);
  const doc = (t, n) => ({ type: t, number: n });
  const cases = [
    ['שולם בבנק — מס בלבד', { linkedDocs: [doc(305, '1')], clientPayStatus: { status: 'paid', via: 'bank' } }, 'green'],
    ['נסגר בחשבונית ירוקה', { linkedDocs: [doc(305, '1')], clientPayStatus: { status: 'paid', via: 'closed' } }, 'green'],
    ['באמת ממתין', { linkedDocs: [doc(305, '1')], clientPayStatus: { status: 'charged' } }, 'yellow'],
    ['בלי סטטוס מהשרת — התנהגות קודמת', { linkedDocs: [doc(305, '1')] }, 'yellow'],
    ['מס-קבלה נשאר ירוק גם אם השרת אומר charged', { linkedDocs: [doc(320, '1')], clientPayStatus: { status: 'charged' } }, 'green'],
    ['אין מסמך', { linkedDocs: [] }, 'red'],
    ['לא נדרשת חשבונית', { noInvoice: true, linkedDocs: [] }, 'none'],
  ];
  for (const [name, ev, want] of cases) {
    const got = f(ev);
    if (got !== want) throw new Error(`${name}: ${got} במקום ${want}`);
  }
  return true;
});

check('חשבון עסקה לא מוצע לשיוך בבנק', () => {
  const exps = [
    { id: 'a', number: '64535', type: 305, supplierName: 'ט. ברגר', amountIncVat: 2360, date: '2026-08-20' },
    { id: 'b', number: '49177', type: 300, supplierName: 'ט. ברגר', amountIncVat: 2360, date: '2026-08-21' },
    { id: 'c', number: '70001', type: 400, supplierName: 'ט. ברגר', amountIncVat: 2360, date: '2026-08-22' },
    { id: 'd', number: '80001', type: null, supplierName: 'ט. ברגר', amountIncVat: 2360, date: '2026-08-22' },
  ];
  const r = bm.matchDebits([{ id: 't1', direction: 'debit', date: '23/08/2026', absAmount: 2360 }], exps)[0];
  const types = r.suggestions.map(x => Number(x.type) || 0);
  if (types.includes(300)) throw new Error('חשבון עסקה מוצע לשיוך');
  if (!types.includes(305)) throw new Error('חשבונית מס נעלמה מההצעות');
  if (!types.includes(0)) throw new Error('מסמך ללא סוג ידוע נעלם — עלול להעלים מסמך תקין');
  // גם בתצוגה: הצעות ישנות ששמורות על השורה כוללות עסקה עד לרענון
  if (!/\[305, 320, 400, 330\]\.includes\(ty\)/.test(app)) throw new Error('הפרונט לא מסנן הצעות שמורות');
  return true;
});

check('התאמת ספק לפי שם לא נופלת על שם מוכל באמצע מילה', () => {
  const src = fs.readFileSync('chat.js', 'utf8').match(/function matchSupplierByName[\s\S]*?\n\}/)[0];
  const f = new Function(src + '; return matchSupplierByName;')();
  const sup = [{ id: 'led', name: 'לד' }, { id: 'gold', name: 'גולדשטיין הפקות' }, { id: 'yosef', name: 'יוסף כהן הפקות' }];
  const cases = [
    ['גולדשטיין הפקות בע"מ', 'gold'],
    ['מולדת אירועים', ''],          // מכיל "לד" באמצע מילה
    ['לד', 'led'],                   // התאמה מדויקת לשם קצר עדיין עובדת
    ['יוסף כהן', 'yosef'],
    ['הפקות', ''],                   // מעורפל — שני מועמדים
  ];
  for (const [name, want] of cases) {
    const got = f(sup, name) || '';
    if (got !== want) throw new Error(`"${name}" → ${got || 'אין'} במקום ${want || 'אין'}`);
  }
  return true;
});

check('תשלום שהותאם דרך קבלה מזוהה גם על חשבונית המס', () => {
  const src = srv.match(/function buildBankPaidMap\(db, companyId\) \{[\s\S]*?\n\}/);
  const nameFn = srv.match(/function sameClientName\(a, b\) \{[\s\S]*?\n\}/);
  const pairFn = srv.match(/function pairInvoiceReceipts\(entries\) \{[\s\S]*?\n\}/);
  if (!src || !nameFn || !pairFn) throw new Error('buildBankPaidMap לא נמצאה');
  const build = new Function('ownedBy',
    nameFn[0] + '\n' + pairFn[0] + '\n' + src[0] + '; return buildBankPaidMap;')((t, c) => !c || t.companyId === c);
  // תנועה מותאמת לקבלה 6002; חשבונית המס 6001 קוננה תחתיה והוסרה מהרשימה הראשית
  const tx = { companyId: 'co_bpm', direction: 'credit', matchStatus: 'approved', date: '08/07/2026',
    matchedInvoices: [{ id: 'r1', number: '6002', type: 400, sourceInvoice: { id: 'i1', number: '6001', type: 305 } }] };
  const m = build({ bankTx: [tx] }, 'co_bpm');
  if ((m.get('num:6001') || {}).date !== '08/07/2026') throw new Error('חשבונית המס המקוננת לא נמצאה במפה');
  if ((m.get('num:6002') || {}).date !== '08/07/2026') throw new Error('הקבלה עצמה לא נמצאה');
  if ((m.get('id:i1') || {}).date !== '08/07/2026') throw new Error('חשבונית המס לא נמצאה לפי מזהה');
  // המפה נושאת גם את המסמך שהתנועה שויכה אליו — כדי להציג את הקבלה על האירוע
  if ((m.get('num:6001') || {}).doc?.number !== '6002') throw new Error('מסמך התשלום לא נשמר במפה');

  // הקבלה מגיעה בשלוש דרכים שונות — כולן חייבות להניב מסמך תשלום
  const paths = [
    ['רשומות נפרדות באותה שורה', [
      { id: 'i', number: '50424', type: 305, clientName: 'אבי גואטה בע"מ', amount: 5900 },
      { id: 'r', number: '80375', type: 400, clientName: 'אבי גואטה בע"מ', amount: 5900, url: 'u' }], '80375'],
    ['קבלה מוצמדת לחשבונית', [
      { id: 'i', number: '50424', type: 305, amount: 5900, receipt: { number: '777', url: 'u' } }], '777'],
    ['שיוך ישיר לקבלה', [
      { id: 'r', number: '999', type: 400, url: 'u', sourceInvoice: { id: 'i', number: '50424', type: 305 } }], '999'],
  ];
  for (const [name, matchedInvoices, want] of paths) {
    const map = build({ bankTx: [{ companyId: 'co_bpm', direction: 'credit', date: '16/08/2026',
      matchStatus: 'approved', matchedInvoices }] }, 'co_bpm');
    const got = (map.get('num:50424') || {}).doc;
    if (!got || String(got.number) !== want) throw new Error(`${name}: ${got ? got.number : 'אין'} במקום ${want}`);
  }
  // תשלום מרוכז: שורה אחת עם שלוש חשבוניות ושלוש קבלות, כולן מאותו לקוח.
  // שם הלקוח אינו מבחין ביניהן — הסכום כן, וכל קבלה משויכת לחשבונית אחת בלבד.
  const C = 'היוצרים - סיטי הפקות';
  const bulk = build({ bankTx: [{ companyId: 'co_bpm', direction: 'credit', date: '18/08/2026', matchStatus: 'approved',
    matchedInvoices: [
      { id: 'a', number: '50421', type: 305, clientName: C, amount: 2360, date: '2026-08-02' },
      { id: 'b', number: '50433', type: 305, clientName: C, amount: 4720, date: '2026-08-05' },
      { id: 'c', number: '50434', type: 305, clientName: C, amount: 3540, date: '2026-08-07' },
      { id: 'r1', number: '80376', type: 400, clientName: C, amount: 2360, date: '2026-08-15' },
      { id: 'r2', number: '80377', type: 400, clientName: C, amount: 4720, date: '2026-08-15' },
      { id: 'r3', number: '80378', type: 400, clientName: C, amount: 3540, date: '2026-08-16' }] }] }, 'co_bpm');
  for (const [inv, want] of [['50421', '80376'], ['50433', '80377'], ['50434', '80378']]) {
    const got = (bulk.get('num:' + inv) || {}).doc;
    if (!got || String(got.number) !== want) throw new Error(`תשלום מרוכז: ${inv} → ${got ? got.number : 'אין'} במקום ${want}`);
  }
  // התאריך מטעה והסכום מכריע: הקבלה הקרובה בזמן לחשבונית א' היא של חשבונית ב'
  const cross = build({ bankTx: [{ companyId: 'co_bpm', direction: 'credit', date: '18/08/2026', matchStatus: 'approved',
    matchedInvoices: [
      { id: 'a', number: 'INV-A', type: 305, clientName: C, amount: 2360, date: '2026-08-02' },
      { id: 'b', number: 'INV-B', type: 305, clientName: C, amount: 4720, date: '2026-08-05' },
      { id: 'r1', number: 'RCP-B', type: 400, clientName: C, amount: 4720, date: '2026-08-03' },
      { id: 'r2', number: 'RCP-A', type: 400, clientName: C, amount: 2360, date: '2026-08-20' }] }] }, 'co_bpm');
  for (const [inv, want] of [['INV-A', 'RCP-A'], ['INV-B', 'RCP-B']]) {
    const got = (cross.get('num:' + inv) || {}).doc;
    if (!got || String(got.number) !== want)
      throw new Error(`זיווג לפי תאריך במקום סכום: ${inv} → ${got ? got.number : 'אין'} במקום ${want}`);
  }

  // שתי חשבוניות בסכום זהה ובאותו יום — לא ניתן להכריע, ואסור לשייך קבלה שרירותית
  const tie = build({ bankTx: [{ companyId: 'co_bpm', direction: 'credit', date: '18/08/2026', matchStatus: 'approved',
    matchedInvoices: [
      { id: 'a', number: 'A1', type: 305, clientName: C, amount: 1000, date: '2026-08-02' },
      { id: 'b', number: 'A2', type: 305, clientName: C, amount: 1000, date: '2026-08-02' },
      { id: 'r1', number: 'R1', type: 400, clientName: C, amount: 1000, date: '2026-08-10' },
      { id: 'r2', number: 'R2', type: 400, clientName: C, amount: 1000, date: '2026-08-12' }] }] }, 'co_bpm');
  const a1 = (tie.get('num:A1') || {}).doc, a2 = (tie.get('num:A2') || {}).doc;
  if (a1 && a2 && String(a1.number) === String(a2.number)) throw new Error('אותה קבלה שויכה לשתי חשבוניות');

  // חשבון עסקה שנסגר בחשבונית ירוקה נסגר בהמרה, לא בתשלום
  const ecp2 = new Function(
    srv.match(/function payDocOf\(d\) \{[\s\S]*?\n\}/)[0]
    + srv.match(/const OPEN_DOCS_MONTHS[\s\S]*?\n\}\n/)[0]
    + srv.match(/function ddmmyyyyToISO[^\n]*\n/)[0]
    + srv.match(/function eventClientPaid\(e, bankPaid, openNums\) \{[\s\S]*?\n\}\n/)[0] + '; return eventClientPaid;')();
  const prof = ecp2({ linkedDocs: [{ type: 300, number: '40446', date: '2026-08-01' }] }, new Map(), new Set(['9']));
  if (prof.status === 'paid') throw new Error('חשבון עסקה שהומר סומן כשולם');

  // חשבונית לבדה — אין קבלה, ואסור להמציא אחת
  const alone = build({ bankTx: [{ companyId: 'co_bpm', direction: 'credit', date: '16/08/2026', matchStatus: 'approved',
    matchedInvoices: [{ id: 'i', number: '50424', type: 305, amount: 5900 }] }] }, 'co_bpm');
  const soloDoc = (alone.get('num:50424') || {}).doc;
  if (soloDoc && [320, 400].includes(Number(soloDoc.type))) throw new Error('הומצאה קבלה שלא קיימת');
  for (const [name, bad] of [
    ['שורה לא מאושרת', { ...tx, matchStatus: 'unmatched' }],
    ['תנועת חובה', { ...tx, direction: 'debit' }],
    ['חברה אחרת', { ...tx, companyId: 'co_moshe' }],
  ]) if (build({ bankTx: [bad] }, 'co_bpm').size) throw new Error(name + ' נספרה בטעות');
  // האירוע מחזיק את חשבונית המס — ועכשיו נחשב שולם
  const ecp = new Function(
    srv.match(/function payDocOf\(d\) \{[\s\S]*?\n\}\n/)[0]
    + srv.match(/const OPEN_DOCS_MONTHS[\s\S]*?\n\}\n/)[0]
    + srv.match(/function ddmmyyyyToISO[^\n]*\n/)[0]
    + srv.match(/function eventClientPaid\(e, bankPaid, openNums\) \{[\s\S]*?\n\}\n/)[0]
    + '; return eventClientPaid;')();
  const r = ecp({ linkedDocs: [{ type: 305, number: '6001', date: '2026-07-08' }] }, m, new Set(['6001']));
  if (r.status !== 'paid' || r.via !== 'bank') throw new Error(`האירוע יצא ${r.status}/${r.via} במקום paid/bank`);
  if (r.date !== '08/07/2026') throw new Error('תאריך התנועה לא הועבר');
  if (!r.payDoc || r.payDoc.number !== '6002') throw new Error('הקבלה לא מוצמדת לאירוע');
  if (!/each\(inv && inv\.sourceInvoice\)/.test(app)) throw new Error('סינון ההצעות לא כולל חשבונית מקור מקוננת');
  return true;
});

check('חשבונית שנסגרה בחשבונית ירוקה נחשבת שולמה', () => {
  const src = srv.match(/function payDocOf\(d\) \{[\s\S]*?\n\}\n/)[0]
            + srv.match(/const OPEN_DOCS_MONTHS[\s\S]*?\n\}\n/)[0]
            + srv.match(/function ddmmyyyyToISO[^\n]*\n/)[0]
            + srv.match(/function eventClientPaid\(e, bankPaid, openNums\) \{[\s\S]*?\n\}\n/)[0];
  const f = new Function(src + '; return eventClientPaid;')();
  const none = new Map();
  const doc = (o = {}) => ({ type: 305, number: '7001', date: new Date().toISOString().slice(0, 10), ...o });
  const cases = [
    ['סגורה = שולם', { linkedDocs: [doc()] }, new Set(['9999']), 'paid'],
    ['פתוחה = ממתין', { linkedDocs: [doc()] }, new Set(['7001']), 'charged'],
    ['GI לא זמין = ממתין', { linkedDocs: [doc()] }, null, 'charged'],
    ['שזוכה = ממתין', { linkedDocs: [doc({ credited: true })] }, new Set(['9999']), 'charged'],
    ['הומרה = ממתין', { linkedDocs: [doc({ type: 300, converted: true })] }, new Set(['9999']), 'charged'],
    ['ישנה מדי = ממתין', { linkedDocs: [doc({ date: '2019-01-05' })] }, new Set(['9999']), 'charged'],
    ['בלי מספר = ממתין', { linkedDocs: [doc({ number: null })] }, new Set(['9999']), 'charged'],
  ];
  for (const [name, ev, open, want] of cases) {
    const got = f(ev, none, open).status;
    if (got !== want) throw new Error(`${name}: ${got} במקום ${want}`);
  }
  // תאריך התשלום: מהתאמת בנק או מתאריך הקבלה. סגירה בחשבונית ירוקה — בלי תאריך.
  const bank = new Map([['num:5001', { date: '10/08/2026', doc: { id: 'r5', number: '5002', type: 400, date: '2026-08-10' } }]]);
  const withBank = f({ linkedDocs: [{ type: 305, number: '5001', date: '2026-07-30' }] }, bank, new Set(['5001']));
  if (withBank.date !== '10/08/2026') throw new Error('תאריך מהתאמת בנק אבד');
  if (!withBank.payDoc || withBank.payDoc.number !== '5002') throw new Error('הקבלה מהתאמת הבנק לא מוחזרת');
  // הבנק שויך לחשבונית המס עצמה — אין קבלה נפרדת, ואסור להמציא אחת
  const selfBank = new Map([['num:5001', { date: '11/08/2026', doc: { id: 'x', number: '5001', type: 305 } }]]);
  const noRcpt = f({ linkedDocs: [{ type: 305, number: '5001', date: '2026-07-30' }] }, selfBank, new Set(['5001']));
  if (noRcpt.payDoc) throw new Error('הוצגה קבלה שלא קיימת');
  const withRcpt = f({ linkedDocs: [{ type: 400, number: '6002', date: '2026-07-12' }] }, none, new Set());
  if (withRcpt.date !== '2026-07-12') throw new Error('תאריך הקבלה לא מוחזר');
  const closedNoDate = f({ linkedDocs: [doc()] }, none, new Set(['9999']));
  if (closedNoDate.date) throw new Error('הומצא תאריך תשלום למסמך שרק נסגר');
  if (!/openNums instanceof Set/.test(srv)) throw new Error('openNums לא מחובר');
  if (!/cp\.via === 'closed'/.test(app)) throw new Error('אין חיווי למקור הסגירה');
  return true;
});

check('כפילות בחשבונית ירוקה מתורגמת להסבר בעברית', () => {
  const rx = srv.match(/const m = (\/"errorCode"[\s\S]*?\/)\.exec/);
  if (!rx) throw new Error('זיהוי שגיאת 1010 לא נמצא');
  const re = eval(rx[1]);
  const real = 'חשבונית ירוקה PUT /expenses/ae63: 400 {"errorCode":1010,"errorMessage":"b187a24d-20f1"}';
  const hit = re.exec(real);
  if (!hit) throw new Error('שגיאת הכפילות האמיתית לא זוהתה');
  if (hit[1] !== 'b187a24d-20f1') throw new Error('מזהה ההוצאה הקיימת לא חולץ');
  if (eval(rx[1]).exec('... 500 {"errorCode":1,"errorMessage":"boom"}')) throw new Error('שגיאה רגילה סווגה בטעות ככפילות');
  if (!/כבר קיימת הוצאה עם מספר מסמך/.test(srv)) throw new Error('אין הודעה בעברית');
  if (!/_exeDupId/.test(app)) throw new Error('אין כפתור לפתיחת ההוצאה הקיימת');
  return true;
});

check('מסמך שנמחק יורד גם מרשימת ההצעות של הבנק', () => {
  const m = srv.match(/function dropDocFromBank\(db, docId, companyId\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('dropDocFromBank לא נמצאה');
  const drop = new Function('ownedBy', m[0] + '; return dropDocFromBank;')(() => true);
  const cases = [
    ['הצעה בלבד', { matchStatus: 'unmatched', suggestions: [{ id: 'g' }, { id: 'x' }], matchedInvoices: [] }, 'unmatched', 1, 0],
    ['שויך ידנית', { matchStatus: 'manual', suggestions: [], matchedInvoices: [{ id: 'g' }] }, 'unmatched', 0, 0],
    ['אושר', { matchStatus: 'approved', suggestions: [], matchedInvoices: [{ id: 'g' }] }, 'unmatched', 0, 0],
    ['נשאר מסמך נוסף', { matchStatus: 'manual', suggestions: [], matchedInvoices: [{ id: 'g' }, { id: 'y' }] }, 'manual', 0, 1],
    ['מוסתרת נשארת מוסתרת', { matchStatus: 'ignored', suggestions: [], matchedInvoices: [{ id: 'g' }] }, 'ignored', 0, 0],
    ['שורה אחרת לא נפגעת', { matchStatus: 'manual', suggestions: [{ id: 'z' }], matchedInvoices: [{ id: 'z' }] }, 'manual', 1, 1],
  ];
  for (const [name, tx, st, sg, mi] of cases) {
    drop({ bankTx: [tx] }, 'g', 'co_bpm');
    if (tx.matchStatus !== st) throw new Error(`${name}: status=${tx.matchStatus} במקום ${st}`);
    if (tx.suggestions.length !== sg) throw new Error(`${name}: ${tx.suggestions.length} הצעות במקום ${sg}`);
    if (tx.matchedInvoices.length !== mi) throw new Error(`${name}: ${tx.matchedInvoices.length} משויכים במקום ${mi}`);
  }
  if (!/dropDocFromBank\(db, id, reqCompany\(q\)\)/.test(srv)) throw new Error('מחיקת הוצאה לא קוראת לעוזר');
  if (!/dropDocFromBank\(db2, p\.giExpenseId, _cid\)/.test(srv)) throw new Error('מחיקת הוצאת ספק לא קוראת לעוזר');
  return true;
});

check('שיוך להוצאה שנמחקה בחשבונית ירוקה נחסם ומתנקה', () => {
  if (!/greenInvoice\.getExpense\(inv\.id\)/.test(srv)) throw new Error('אין בדיקת קיום לפני שיוך');
  if (!/stale: true/.test(srv)) throw new Error('השרת לא מסמן stale');
  if (!/r\.stale/.test(app)) throw new Error('הפרונט לא מנקה את ההצעה מהמסך');
  const guard = srv.match(/let gone = false;[\s\S]*?if \(!gone\) continue;/);
  if (!guard) throw new Error('בדיקת ה-404 לא נמצאה');
  if (!/404/.test(guard[0])) throw new Error('נחסם על כל שגיאה ולא רק על 404 — תקלת רשת תמנע שיוך תקין');
  return true;
});

check('רכבי חברה — בידוד חברות, הרשאת קבצים וחיווי תוקף', () => {
  // כל ראוט שנוגע ברכב חייב לעבור דרך ownedBy — אחרת חברה אחת רואה רכבים של אחרת
  const routes = [];
  for (let i = srv.indexOf("add('"); i >= 0; i = srv.indexOf("add('", i + 1)) {
    const head = srv.slice(i, i + 90);
    if (!/\/api\\\/vehicles/.test(head)) continue;
    const end = srv.indexOf('\n});', i);
    routes.push(srv.slice(i, end > 0 ? end : i + 2000));
  }
  if (routes.length < 5) throw new Error(`נמצאו ${routes.length} ראוטים של רכבים מתוך 5`);
  for (const r of routes) {
    if (!/reqCompany\(/.test(r)) throw new Error('ראוט רכבים בלי reqCompany');
    const isList = /add\('GET'/.test(r);
    if (!isList && !/wrongCompany\(res, 'הרכב'\)/.test(r)) throw new Error('ראוט רכבים בלי בדיקת בעלות');
    if (isList && !/ownedBy\(v, cid\)/.test(r)) throw new Error('רשימת הרכבים לא מסוננת לפי חברה');
  }
  // קובץ של רכב חייב להיפתר לחברה של הרכב, אחרת /api/files/:id יגיש אותו לכל אחד
  if (!/owner\.match\(\/\^veh:\(\.\+\)\$\/\)/.test(srv)) throw new Error('fileCompanyId לא מזהה קובץ של רכב');
  if (!/employeeId: 'veh:' \+ v\.id/.test(srv)) throw new Error('קובץ רכב לא מתויג בחברה');
  // כמה מסמכים לאותה קטגוריה: העלאה מוסיפה ולא מוחקת את הקודם
  const iUp = srv.indexOf("add('POST', /^\\/api\\/vehicles\\/([^/]+)\\/file$/");
  if (iUp < 0) throw new Error('ראוט ההעלאה לא נמצא');
  const upRoute = srv.slice(iUp, srv.indexOf('\n});', iUp));
  if (!/isExtraSlot\(slot\)/.test(upRoute))
    throw new Error('ההעלאה לא מבחינה בין קטגוריה קבועה למסמך נוסף');
  if (!/for \(const f of replaced\)/.test(upRoute))
    throw new Error('מסמך שהוחלף בקטגוריה קבועה לא נמחק');

  // הכלל עצמו: קבוע מחליף, נוסף מצטרף
  const pick = new Function('isExtraSlot', 'prevFiles', 'rec',
    'return { keep: (isExtraSlot(\'S\') ? prevFiles : []).concat([rec]), replaced: isExtraSlot(\'S\') ? [] : prevFiles };');
  const prev = [{ id: 'old' }];
  const fixed = pick(() => false, prev, { id: 'new' });
  if (fixed.keep.length !== 1 || fixed.keep[0].id !== 'new') throw new Error('קטגוריה קבועה לא מחליפה');
  if (fixed.replaced.length !== 1) throw new Error('המסמך הקודם בקטגוריה קבועה לא סומן למחיקה');
  const extra = pick(() => true, prev, { id: 'new' });
  if (extra.keep.length !== 2) throw new Error('מסמך נוסף לא מצטרף לקיימים');
  if (extra.replaced.length) throw new Error('מסמך נוסף מוחק את הקודם');
  if (!/isExtraSlot = \(slot\) => String\(slot\)\.startsWith\('extra:'\)/.test(srv))
    throw new Error('זיהוי "מסמך נוסף" לא לפי הקידומת');

  // יישור רכבים שנשמרו לפני הכלל — אחרת קטגוריה קבועה נשארת עם שני מסמכים
  const norm = new Function(
    srv.match(/const slotFiles = \(v, slot\) =>[^\n]*/)[0] + '\n'
    + srv.match(/const isExtraSlot = \(slot\) =>[^\n]*/)[0] + '\n'
    + srv.match(/function normalizeFixedSlots\(v\) \{[\s\S]*?\n\}/)[0] + '; return normalizeFixedSlots;')();
  const cases = [
    ['שומר את האחרון לפי חותמת', { license: [{ id: 'a', at: '2026-01-01' }, { id: 'b', at: '2026-05-01' }] }, { license: ['b'] }, 1],
    ['גם כשהסדר במערך הפוך', { license: [{ id: 'b', at: '2026-05-01' }, { id: 'a', at: '2026-01-01' }] }, { license: ['b'] }, 1],
    ['בלי חותמות — לפי סדר ההעלאה', { license: [{ id: 'a' }, { id: 'b' }] }, { license: ['b'] }, 1],
    ['מסמך נוסף נשאר צובר', { 'extra:x': [{ id: 'a' }, { id: 'b' }] }, { 'extra:x': ['a', 'b'] }, 0],
    ['מבנה ישן (קובץ יחיד)', { license: { id: 'a' } }, { license: ['a'] }, 0],
  ];
  for (const [name, files, want, nDropped] of cases) {
    const v = { files: JSON.parse(JSON.stringify(files)) };
    const dropped = norm(v);
    const got = Object.fromEntries(Object.entries(v.files).map(([k, x]) => [k, (Array.isArray(x) ? x : [x]).map(y => y.id)]));
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name}: ${JSON.stringify(got)}`);
    if (dropped.length !== nDropped) throw new Error(`${name}: ${dropped.length} נמחקו במקום ${nDropped}`);
  }
  // הפרדה בין רכבי חברה לרכבים אישיים — תצוגה בלבד, אותה התנהגות
  const clean = new Function('VEH_SLOT_DEFS', srv.match(/const cleanVehicle = \(b, prev = \{\}\) => \{[\s\S]*?\n\};/)[0] + '; return cleanVehicle;')([]);
  if (clean({ plate: '1' }).scope !== 'company') throw new Error('רכב חדש לא משויך כברירת מחדל לרכבי החברה');
  if (clean({ plate: '1', scope: 'personal' }).scope !== 'personal') throw new Error('שיוך לרכב אישי לא נשמר');
  if (clean({ plate: '1', scope: 'nonsense' }).scope !== 'company') throw new Error('שיוך לא מוכר לא נופל לברירת מחדל');
  // עריכה שלא נוגעת בשיוך חייבת לשמר אותו, אחרת רכב אישי קופץ למקטע החברה
  if (clean({ plate: '1' }, { scope: 'personal' }).scope !== 'personal') throw new Error('עריכה איפסה את השיוך');
  if (!/v\.scope === 'personal' \? 'personal' : 'company'/.test(app)) throw new Error('המסך לא מפריד בין המקטעים');
  if (!/רכב אישי/.test(fs.readFileSync('vehicleAlerts.js', 'utf8'))) throw new Error('המייל לא מבחין ברכב אישי');

  // חיווי סטטוס הרכבים בראש המסך — אותם ספים כמו ההתראות במייל
  const pillFn = new Function('api', 'vehWorst', 'state', 'NO_FLEET_COMPANIES',
    app.match(/async function vehiclePill\(\) \{[\s\S]*?\n\}/)[0] + '; return vehiclePill;');
  const run = async (vehicles, worstOf, co = 'co_bpm') =>
    pillFn(async () => vehicles, worstOf, { company: co }, ['co_tal', 'co_moshe'])();
  const days = { ok: 200, soon: 12, bad: -3 };
  const check1 = async () => {
    const empty = await run([], () => null);
    if (!/אין רכבים/.test(empty)) throw new Error('חיווי ריק שגוי');
    const good = await run([{}], () => days.ok);
    if (!/תקין/.test(good) || !/pill ok/.test(good)) throw new Error('חיווי "תקין" שגוי');
    const warn = await run([{}], () => days.soon);
    if (!/pill warn/.test(warn) || !/פג בתוך 30 יום/.test(warn)) throw new Error('חיווי "מתקרב" שגוי');
    const bad = await run([{ x: 1 }, { x: 2 }], (v) => (v.x === 1 ? days.bad : days.soon));
    if (!/pill bad/.test(bad) || !/פג תוקף/.test(bad) || !/מתקרב/.test(bad)) throw new Error('חיווי "פג תוקף" שגוי');
    // עסק בלי צי רכב: הסטטוס אומר את הסיבה, ולא "אין רכבים" שנקרא כמידע חסר
    const noFleet = await run([{}], () => days.bad, 'co_tal');
    if (!/רכבים: פרטיים/.test(noFleet)) throw new Error('עסק בלי צי רכב אינו מסומן ככזה');
    if (/gotoVehicles/.test(noFleet)) throw new Error('החיווי מקשר ללשונית שמוסתרת');
  };
  pendingAsync.push(check1());
  if (!/gotoVehicles/.test(app)) throw new Error('אי אפשר לעבור ללשונית מהחיווי');
  if (/pill\('חשבונית ירוקה'/.test(app)) throw new Error('חיווי חשבונית ירוקה עדיין תופס את המקום');

  // הניקוי חייב לרוץ בטעינת הרשימה, אחרת רכבים קיימים לא מתיישרים לעולם
  const iList = srv.indexOf("add('GET', /^\\/api\\/vehicles$/");
  if (!/normalizeFixedSlots\(v\)/.test(srv.slice(iList, srv.indexOf('\n});', iList))))
    throw new Error('הניקוי לא רץ בטעינת רשימת הרכבים');
  // גם החידוש מציית לאותו כלל
  const iRen = srv.indexOf("add('POST', /^\\/api\\/vehicles\\/([^/]+)\\/renew$/");
  if (!/isExtraSlot\(slot\)/.test(srv.slice(iRen, srv.indexOf('\n});', iRen))))
    throw new Error('החידוש לא מבחין בין קטגוריה קבועה למסמך נוסף');
  // קריאה חייבת לסבול גם את המבנה הישן (קובץ יחיד), אחרת רכבים קיימים מאבדים מסמכים
  const sf = new Function(srv.match(/const slotFiles = \(v, slot\) =>[^\n]*/)[0] + '; return slotFiles;')();
  if (sf({ files: { license: { id: 'a' } } }, 'license').length !== 1) throw new Error('מבנה ישן (קובץ יחיד) לא נקרא');
  if (sf({ files: { license: [{ id: 'a' }, { id: 'b' }] } }, 'license').length !== 2) throw new Error('מבנה חדש לא נקרא');
  if (sf({}, 'license').length !== 0) throw new Error('רכב בלי קבצים מחזיר משהו');
  const af = new Function(srv.match(/const slotFiles = \(v, slot\) =>[^\n]*/)[0] + '\n'
    + srv.match(/const allVehicleFiles = \(v\) =>[^\n]*/)[0] + '; return allVehicleFiles;')();
  if (af({ files: { license: [{ id: 'a' }, { id: 'b' }], cto: { id: 'c' } } }).length !== 3)
    throw new Error('מחיקת רכב לא תאסוף את כל הקבצים');
  // הסרת קובץ בודד לפי מזהה
  if (!/q\.fileId/.test(srv)) throw new Error('אי אפשר להסיר קובץ בודד מתוך קטגוריה');

  // חיווי התוקף
  const f = new Function(app.match(/function vehDaysLeft\(iso\) \{[\s\S]*?\n\}/)[0] + '; return vehDaysLeft;')();
  // תאריך לפי לוח השנה המקומי. toISOString הוא UTC, ובשעות הערב בישראל הוא
  // מחזיר את היום הקודם — מה שהפך את הבדיקה עצמה לתלוית שעה.
  const iso = (d) => { const x = new Date(); x.setDate(x.getDate() + d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  if (f(iso(-5)) !== -5) throw new Error('מסמך שפג לא מזוהה');
  if (f(iso(10)) !== 10) throw new Error('ספירת ימים שגויה');
  if (f('') !== null || f(null) !== null) throw new Error('תאריך חסר לא מטופל');
  const worst = new Function(app.match(/const VEH_SLOTS = \[[\s\S]*?\n\];/)[0]
    + app.match(/const vehRows = \(v\) =>[\s\S]*?;\n/)[0]
    + app.match(/function vehDaysLeft\(iso\) \{[\s\S]*?\n\}/)[0]
    + app.match(/function vehWorst\(v\) \{[\s\S]*?\n\}/)[0] + '; return vehWorst;')();
  if (worst({ licenseExpiry: iso(200), ctoExpiry: iso(-3), compExpiry: iso(50) }) !== -3)
    throw new Error('הכרטיס לא נצבע לפי המסמך הדחוף ביותר');
  if (worst({}) !== null) throw new Error('רכב בלי תאריכים סווג בטעות');
  return true;
});

check('העברת רשומות מקומיות לחשבונית ירוקה — מוגנת ולא מוחקת', () => {
  const iRep = srv.indexOf("add('GET', /^\\/api\\/local-expenses\\/report$/");
  const iMig = srv.indexOf("add('POST', /^\\/api\\/local-expenses\\/migrate$/");
  if (iRep < 0 || iMig < 0) throw new Error('ראוטי ההעברה לא נמצאו');
  const mig = srv.slice(iMig, srv.indexOf('\n});', iMig));
  if (!/b\.confirm !== true/.test(mig)) throw new Error('אפשר להריץ העברה בלי אישור מפורש');
  if (!/ownedBy\(p, cid\)/.test(srv.slice(srv.indexOf('const localMigratable'), iRep)))
    throw new Error('ההעברה עוברת על רשומות של חברות אחרות');
  if (!/Number\(p\.documentType\) !== 20 && !p\.isBusinessDoc/.test(srv))
    throw new Error('חשבון עסקה פנימי נשלח לחשבונית ירוקה');
  if (!/if \(!p \|\| p\.giExpenseId\) continue;/.test(mig))
    throw new Error('רשומה שכבר הועברה תיווצר שוב');
  if (!/errorCode"\\s\*:\\s\*1010/.test(mig)) throw new Error('כפילות לא מטופלת כ"כבר קיימת"');
  // שליחה חוזרת לרו"ח רק בבקשה מפורשת ורק למה שנכשל — אחרת עותקים כפולים
  // שליחה חוזרת רק כשידוע בוודאות שהשליחה נכשלה. היעדר רישום אינו "לא נשלח":
  // במסלול הרגיל הטיוטה נמחקת ו-draftId מתאפס, ואז אין רישום כלל.
  if (!/b\.emailMissing === true && wasForwarded\(db, p\) === false/.test(mig))
    throw new Error('המיגרציה עלולה לשלוח מיילים כפולים לרו"ח');
  const wf = new Function(srv.match(/const wasForwarded = \(db, p\) => \{[\s\S]*?\n\};/)[0] + '; return wasForwarded;')();
  if (wf({}, { id: 'x' }) !== null) throw new Error('רשומה בלי טיוטה סווגה כ"לא נשלחה"');
  if (wf({ approvedDrafts: {} }, { id: 'x', draftId: 'd' }) !== null) throw new Error('טיוטה שנמחקה סווגה כ"לא נשלחה"');
  if (wf({ approvedDrafts: { d: { forwarded: false } } }, { id: 'x', draftId: 'd' }) !== false) throw new Error('כשל שליחה אמיתי לא מזוהה');
  if (wf({ approvedDrafts: { d: { forwarded: true } } }, { id: 'x', draftId: 'd' }) !== true) throw new Error('שליחה מוצלחת לא מזוהה');
  // סיווג — לא נופלים על "הראשון ברשימה"
  if (/cls\[0\]/.test(mig)) throw new Error('המיגרציה בוחרת סיווג שרירותי');
  if (!/b\.fallbackClassificationId/.test(mig)) throw new Error('אין סיווג ברירת מחדל שנבחר במפורש');
  if (!/אין סיווג — יש לבחור סיווג ברירת מחדל/.test(mig)) throw new Error('מסמך בלי סיווג יועבר בכל זאת');
  // מסמכי הכנסה מדווחים אבל לעולם לא מועברים — הפקה מחדש = דיווח כפול לרשויות
  const rep = srv.slice(iRep, srv.indexOf('\n});', iRep));
  if (!/localIncome/.test(rep)) throw new Error('מסמכי הכנסה מקומיים לא מדווחים בדוח');
  // ההעברה לרו"ח נשארת גם במסלול חשבונית ירוקה — ותנאיה מדווחים
  if (!/accountantEmail/.test(rep)) throw new Error('הדוח לא בודק שההעברה לרו"ח מוגדרת');
  const giPath = srv.slice(srv.indexOf('// העברת קובץ ההוצאה אוטומטית לכתובת רו"ח'));
  if (!/sendMailLogged\(/.test(giPath.slice(0, 1200))) throw new Error('מסלול חשבונית ירוקה לא מעביר לרו"ח');
  if (/oldInvoices/.test(mig)) throw new Error('ההעברה נוגעת במסמכי הכנסה — סכנת דיווח כפול');
  // ההעברה לא מוחקת שום דבר
  const destructive = mig.match(/db\w*\.\w+ = [^;]*\.filter\(|delete db|deleteFile\(/g) || [];
  if (destructive.length) throw new Error('ההעברה מכילה פעולת מחיקה: ' + destructive.join(','));
  // שני החישובים חייבים להיות זהים, אחרת המסך אומר 30 יום והמייל אומר 29
  const feDays = app.match(/function vehDaysLeft\(iso\) \{[\s\S]*?\n\}/)[0];
  if (!/Date\.UTC\(y, m - 1, d\)/.test(feDays) || !/Date\.UTC\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)\)/.test(feDays))
    throw new Error('המסך מחשב ימים אחרת מההתראות');

  // הקוד שמחק את נתוני אופק הוסר לגמרי
  if (/_ofekDataCleared|_ofekBankBalanceCleared/.test(srv))
    throw new Error('נותר קוד שמוחק נתוני חברה — שחזור מגיבוי ישן ימחק הוצאות אמיתיות');
  if (/companyId !== 'co_ofek'/.test(srv)) throw new Error('נותר סינון שמוחק נתוני אופק');

  // מסלול ההוצאה נגזר ממצב החיבור ולא משם החברה
  // מסלול קליטת ההוצאה נגזר ממצב החיבור ולא משם החברה — בשרת ובפרונט
  if (!/const localOnly = isBusiness \|\| !giEnabled\(_activeCid\)/.test(srv))
    throw new Error('השרת מקבע חברה מסוימת כמקומית');
  if (/_activeCid === 'co_ofek'/.test(srv)) throw new Error('נותר קיבוע לפי שם חברה במסלול ההוצאה');
  if (!/state\.giConnected === false/.test(app)) throw new Error('הפרונט לא נגזר ממצב החיבור');
  return true;
});

check('סגירת הצעות מחיר שחויבו — רק כשיש חשבונית, ורק באישור', () => {
  const src = srv.match(/function staleQuotes\(db, cid\) \{[\s\S]*?\n\}/);
  if (!src) throw new Error('staleQuotes לא נמצאה');
  const f = new Function('ownedBy', src[0] + '; return staleQuotes;')(() => true);
  const ev = (docs) => ({ events: [{ id: 'e', companyId: 'c', linkedDocs: docs }] });
  const Q = { id: 'q', type: 10, number: '580' };
  if (f(ev([Q, { id: 'i', type: 305, number: '900' }]), 'c').length !== 1) throw new Error('הצעה שחויבה לא זוהתה');
  if (f(ev([Q]), 'c').length) throw new Error('הצעה שטרם חויבה נסגרת — לא תוכל להפיק ממנה חשבונית');
  if (f(ev([{ ...Q, converted: true }, { id: 'i', type: 305 }]), 'c').length) throw new Error('הצעה שכבר הומרה נספרה שוב');
  if (f(ev([{ ...Q, uploaded: true }, { id: 'i', type: 305 }]), 'c').length) throw new Error('הצעה שהועלתה כקובץ נשלחת לסגירה בחשבונית ירוקה');
  if (f(ev([Q, { id: 'i', type: 305, credited: true }]), 'c').length) throw new Error('חשבונית שזוכתה נחשבת חיוב פעיל');
  const i = srv.indexOf("add('POST', /^\\/api\\/stale-quotes\\/close$/");
  const close = srv.slice(i, srv.indexOf('\n});', i));
  if (!/b\.confirm !== true/.test(close)) throw new Error('סגירה בלי אישור מפורש');
  if (!/ownedBy/.test(src[0])) throw new Error('הסגירה עוברת על אירועים של חברות אחרות');
  return true;
});

// חשבון עסקה שחשבונית המס שלו הופקה ישירות בחשבונית ירוקה נשאר פתוח שם לנצח
// (linkedDocumentIds נקבע ביצירה בלבד). הרשימה חייבת להיקרא מחשבונית ירוקה עצמה —
// הדגל converted שלנו נקבע גם מזיהוי לתצוגה, וסגירה על סמכו תסגור מסמכים חיים.
check('סגירת חשבונות עסקה שחויבו — לפי הסטטוס בחשבונית ירוקה, ורק באישור', async () => {
  const src = srv.match(/async function staleProformas\(cid\) \{[\s\S]*?\n\}/);
  if (!src) throw new Error('staleProformas לא נמצאה');
  const mk = (open, events) => new Function('greenInvoice', 'load', 'ownedBy',
    src[0] + '; return staleProformas;')(
    { openDocuments: async () => open }, () => ({ events }), () => true);
  const P = { id: 'p', type: 300, number: '10195', amount: 18880, clientName: 'פאזל' };
  const openP = [P];
  const ev = (docs) => [{ id: 'e', companyId: 'c', linkedDocs: docs }];
  const run = (open, docs) => mk(open, ev(docs))('c');

  if ((await run(openP, [{ id: 'p', type: 300, number: '10195', converted: true }, { id: 'i', type: 320, number: 30268 }])).length !== 1)
    throw new Error('חשבון עסקה פתוח בחשבונית ירוקה לא זוהה — הדגל converted שלנו הסתיר אותו');
  if ((await run([], [{ id: 'p', type: 300 }, { id: 'i', type: 320 }])).length)
    throw new Error('נסגר חשבון עסקה שכבר סגור בחשבונית ירוקה');
  if ((await run(openP, [{ id: 'p', type: 300, number: '10195' }])).length)
    throw new Error('חשבון עסקה שטרם חויב נסגר — לא תוכל להפיק ממנו חשבונית');
  if ((await run(openP, [{ id: 'p', type: 300 }, { id: 'i', type: 320, credited: true }])).length)
    throw new Error('חשבונית שזוכתה נחשבת חיוב פעיל');
  // התאמה לפי מספר כשהמזהה על האירוע שונה (מסמך שנקלט במסלול ישן)
  if ((await run(openP, [{ id: 'other', type: 300, number: '10195' }, { id: 'i', type: 305 }])).length !== 1)
    throw new Error('התאמה לפי מספר מסמך לא עבדה');

  const i = srv.indexOf("add('POST', /^\\/api\\/stale-proformas\\/close$/");
  if (i < 0) throw new Error('ראוט הסגירה לא נמצא');
  const close = srv.slice(i, srv.indexOf('\n});', i));
  if (!/b\.confirm !== true/.test(close)) throw new Error('סגירה בלי אישור מפורש');
  // בלי ניקוי המטמון openDocuments מחזיר את אותה רשימה, remaining לא יורד והלולאה בפרונט תיתקע
  if (!/clearDataCache\(\)/.test(close)) throw new Error('המטמון לא מנוקה — הלולאה לא תתקדם');
  if (!/ownedBy/.test(src[0])) throw new Error('הסגירה עוברת על אירועים של חברות אחרות');
  for (const fn of ['loadStaleProformas', 'runCloseStaleProformas'])
    if (!app.includes(`window.${fn} =`)) throw new Error(`${fn} חסרה בפרונט`);
  return true;
});

check('הפקת חשבונית מאירועים מקשרת את הצעת המחיר', () => {
  const i = srv.indexOf("add('POST', /^\\/api\\/invoicing\\/generate$/");
  if (i < 0) throw new Error('ראוט ההפקה לא נמצא');
  const gen = srv.slice(i, srv.indexOf('\n});', i));
  if (!/linkedDocumentIds: quoteIds/.test(gen))
    throw new Error('החשבונית נוצרת בלי קישור להצעת המחיר — ההצעה תישאר פתוחה בחשבונית ירוקה');
  // רק הצעות פעילות: הצעה שכבר הומרה או שהועלתה כקובץ אינה מסמך מקור בחשבונית ירוקה
  if (!/Number\(d\.type\) !== 10 \|\| !d\.id \|\| d\.uploaded \|\| d\.converted/.test(gen))
    throw new Error('הצעה שהומרה או שהועלתה כקובץ נשלחת כמסמך מקור');
  if (!/d\.converted = true/.test(gen)) throw new Error('ההצעה לא מסומנת כהומרה על האירוע');
  // הבחירה נגזרת מהאירועים שמחויבים, לא מהתצוגה המקדימה
  const pick = new Function('evs', gen.match(/const quoteIds = \[\];[\s\S]*?\n    \}/)[0] + '; return quoteIds;');
  const q = (docs) => pick([{ linkedDocs: docs }]);
  if (q([{ id: 'a', type: 10 }]).length !== 1) throw new Error('הצעה פעילה לא נאספת');
  if (q([{ id: 'a', type: 10, converted: true }]).length) throw new Error('הצעה שהומרה נאספה');
  if (q([{ id: 'a', type: 10, uploaded: true }]).length) throw new Error('הצעה שהועלתה כקובץ נאספה');
  if (q([{ id: 'a', type: 305 }]).length) throw new Error('חשבונית מס נאספה כהצעה');
  if (q([{ id: 'a', type: 10 }, { id: 'a', type: 10 }]).length !== 1) throw new Error('אותה הצעה נאספה פעמיים');
  return true;
});

const pp = await import('./pngPdf.js');
check('מסמך שנשלח לרואה החשבון תמיד בפורמט קביל', () => {
  // פייפרלס מקבל PDF/JPG בלבד. PNG נדחה שם, אצלנו נרשם כשליחה מוצלחת,
  // והמסמך פשוט לא מגיע — כשל שקט שמתגלה רק בסוף החודש.
  const zlib = zlibMod;
  const tbl = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]); };
  const png = (w, h, colorType, ch, filter) => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
    const rows = []; for (let y = 0; y < h; y++) { const r = Buffer.alloc(w * ch + 1); r[0] = filter;
      for (let i = 0; i < w * ch; i++) r[i + 1] = (y * 7 + i * 13) % 256; rows.push(r); }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  };
  // כל סוגי הצבע וכל חמשת סוגי הסינון של PNG
  for (const [name, ct, chn] of [['RGB', 2, 3], ['RGBA', 6, 4], ['אפור', 0, 1], ['אפור+שקיפות', 4, 2]])
    for (let f = 0; f <= 4; f++) {
      const pdf = pp.pngToPdf(png(24, 18, ct, chn, f));
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`${name}/סינון ${f}: לא הופק PDF`);
      if (!pdf.subarray(-8).toString('latin1').includes('%%EOF')) throw new Error(`${name}/סינון ${f}: PDF קטוע`);
    }
  // השער: מה עובר כמות שהוא, מה מומר, ומה נחסם
  const pdfOk = pp.toAcceptable(Buffer.from('x'), 'application/pdf');
  if (pdfOk.converted || pdfOk.ext !== 'pdf') throw new Error('PDF הומר שלא לצורך');
  const jpgOk = pp.toAcceptable(Buffer.from('x'), 'image/jpeg');
  if (jpgOk.converted || jpgOk.ext !== 'jpg') throw new Error('JPG הומר שלא לצורך');
  const conv = pp.toAcceptable(png(10, 10, 2, 3, 0), 'image/png');
  if (!conv.converted || conv.ext !== 'pdf') throw new Error('PNG לא הומר');
  let blocked = false;
  try { pp.toAcceptable(Buffer.from('x'), 'image/gif'); } catch { blocked = true; }
  if (!blocked) throw new Error('פורמט לא נתמך נשלח בכל זאת');

  // כל שליחה של הוצאה לרואה החשבון עוברת דרך השער. שליחת מסמך ללקוח ומסמכי
  // הכנסה אינן במסלול הזה — האחרונים נשלפים מחשבונית ירוקה וכבר PDF.
  let expenseSends = 0, expenseGated = 0;
  for (let i = srv.indexOf('subject: `הוצאה'); i >= 0; i = srv.indexOf('subject: `הוצאה', i + 1)) {
    const win = srv.slice(Math.max(0, i - 500), i + 700);   // ההמרה קורית לפני קריאת השליחה
    if (!/attachments: \[/.test(win)) continue;
    expenseSends++;
    if (/toMailableDoc\(/.test(win)) expenseGated++;
  }
  if (!expenseSends) throw new Error('לא נמצאו מסלולי שליחת הוצאה');
  if (expenseGated < expenseSends)
    throw new Error(`${expenseSends} מסלולי שליחת הוצאה, רק ${expenseGated} עוברים המרה`);
  // ואף מסלול לא מצרף את הקובץ הגולמי במקום המומר
  if (/content: fileBuf, contentType: fileCt/.test(srv)) throw new Error('קובץ גולמי מצורף בלי המרה');
  // והמקור לא מייצר PNG מלכתחילה
  if (/toBlob\(res, 'image\/png'\)/.test(app)) throw new Error('השיטוח עדיין מייצר PNG');
  if (/mime: 'image\/png'/.test(app)) throw new Error('עדיין מועלה קובץ כ-PNG');
  return true;
});

check('זיכוי חלקי לא מוציא אירוע מחויב חזרה לרשימת ההפקה', () => {
  // בחירת אירוע במסך הזיכוי קובעת מה ייכתב בתיאור. החזרת האירוע ל"ממתין לחיוב"
  // היא החלטה נפרדת — אחרת זיכוי חלקי מחזיר לרשימת ההפקה אירוע שחשבוניתו בתוקף.
  if (!/const revertEventIds = window\._creditRevert \? selIds : \[\]/.test(app))
    throw new Error('בחירת אירוע לתיאור הזיכוי מחזירה אותו ל"ממתין לחיוב"');
  if (!/creditRevertChk/.test(app)) throw new Error('אין סימון מפורש להחזרת אירועים');
  // השרת: זיכוי חלקי-לפי-סכום אינו משנה סטטוס אירועים מעצמו
  const i = srv.indexOf("add('POST', /^\\/api\\/documents\\/([^/]+)\\/credit$/");
  const cr = srv.slice(i, srv.indexOf('\n});', i));
  if (!/} else if \(!isPartial && !\(body && body\.revertEvents === false\)\)/.test(cr))
    throw new Error('זיכוי חלקי מחזיר אירועים מעצמו');
  // שחזור: שיוך מחדש של החשבונית מנקה את סימון "זוכה"
  if (!/if \(cur\) \{ if \(cur\.credited\) delete cur\.credited; continue; \}/.test(srv))
    throw new Error('אין דרך להחזיר אירוע שסומן כמזוכה בטעות');
  if (/delete cur\.converted/.test(srv)) throw new Error('שיוך מחדש מבטל המרה — המרה אינה הפיכה');
  return true;
});

check('הסימון "שלח ללקוח במייל" עובד בכל מסלולי ההפקה', () => {
  // הסימון קיים במסך אחד ומשרת כמה מסלולי הפקה. באחד מהם הוא פשוט לא נקרא,
  // ולכן לא עשה כלום — סימון שאינו עושה דבר גרוע מהיעדר סימון.
  const routes = [
    ['quotes', 'הצעת מחיר'],
    ['documents', 'מסמך הכנסה חדש'],
    ['invoicing', 'חשבונית מאירועים'],
  ];
  const heads = [...srv.matchAll(/add\('POST', \/\^[^\n]*?\/(create|generate)\$\//g)];
  for (const [key, name] of routes) {
    const h = heads.find(m => m[0].includes(key));
    if (!h) throw new Error(`ראוט ${name} לא נמצא`);
    const i = h.index;
    const body = srv.slice(i, srv.indexOf('\n});', i));
    if (!/body\.sendEmail/.test(body)) throw new Error(`${name}: הדגל לא נקרא בשרת`);
    if (!/body\.email/.test(body)) throw new Error(`${name}: הכתובת לא נקראת בשרת`);
  }
  // והפרונט שולח אותו בכל שלושת המקומות
  const sends = (app.match(/sendEmail: (!!e\.sendEmail|p\.sendEmail)/g) || []).length;
  if (sends < 3) throw new Error(`הפרונט שולח את הדגל ב-${sends} מסלולים מתוך 3`);
  // ואם סומן בלי כתובת — נעצר לפני ההפקה ולא נכשל בשקט
  if ((app.match(/סמנת "שלח במייל" — יש להזין כתובת מייל/g) || []).length < 2)
    throw new Error('אין בדיקה של כתובת חסרה בכל המסלולים');
  return true;
});

check('כל שליחת מייל נרשמת ביומן', () => {
  // הצורך אמיתי: היו שני מקרים שמסמך לא הגיע ליעדו ואיש לא ידע. יומן הוא הדרך
  // היחידה לוודא בדיעבד — ולכן אסור שיהיה מסלול שליחה שמתחמק ממנו.
  // ל-mailer.js שתי פונקציות שליחה. שתיהן חייבות לעבור דרך העוטף — הבדיקה
  // הראשונה כיסתה רק אחת מהן, ואחת מהקריאות באמת עקפה את היומן.
  const direct = [...srv.matchAll(/mailer\.(sendMailFrom|sendMail)\(/g)].length;
  if (direct !== 2) throw new Error(`${direct} קריאות ישירות לשליחה — רק העוטף רשאי (שתיים, בתוכו)`);
  const wrapBody = srv.match(/async function sendMailLogged[\s\S]*?\n\}/)[0];
  if ((wrapBody.match(/mailer\.(sendMailFrom|sendMail)\(/g) || []).length !== 2)
    throw new Error('קריאה ישירה לשליחה מחוץ לעוטף');
  const wrapped = [...srv.matchAll(/sendMailLogged\(/g)].length;
  if (wrapped < 13) throw new Error(`רק ${wrapped} שליחות עוברות דרך היומן`);
  // לכל שליחה סיווג — בלי זה היומן הוא רשימת נושאים בלי הקשר
  const noMeta = [...srv.matchAll(/sendMailLogged\((\w+), \{(?! __meta)/g)].length;
  if (noMeta) throw new Error(`${noMeta} שליחות בלי סיווג`);
  // גם כישלון נרשם — אחרת היומן מראה רק הצלחות ומטעה
  const wrap = srv.match(/async function sendMailLogged[\s\S]*?\n\}/)[0];
  if (!/finally/.test(wrap)) throw new Error('כישלון שליחה לא נרשם');
  if (!/catch \{ \/\* תיעוד לא יפיל שליחה \*\/ \}/.test(wrap)) throw new Error('תקלה בתיעוד עלולה להפיל שליחה');
  if (!/ok, error/.test(wrap)) throw new Error('היומן לא שומר את תוצאת השליחה');
  // והמסך קורא אותו
  if (!/loadMailLog/.test(app)) throw new Error('אין מסך ליומן');
  return true;
});

check('שורת האירוע ותא מסמכי החיוב נבנים בלי שגיאת ריצה', () => {
  // הבדיקה הקיימת מאתרת משתנה שלא הוכרז ברמת המודול, אבל לא משתנה שמוכרז
  // בפונקציה אחת ומשמש באחרת. החלפת טקסט גלובלית הזליגה בדיוק כך משתנה
  // מחלונית התצוגה לתוך שורת האירוע — והיה שובר את כל הלשונית.
  const grab = (sig) => { const i = app.indexOf(sig); if (i < 0) throw new Error(`${sig} לא נמצאה`);
    let d = 0, j = app.indexOf('{', i);
    for (let k = j; k < app.length; k++) { if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error('לא נסגרה'); };
  const stubs = `
    const escapeHtml=(x)=>String(x==null?'':x), escAttr=escapeHtml, money=(n)=>'₪'+(n||0), ddmy=(d)=>String(d||'');
    const SHORT_BILL={10:'הצעה',300:'עסקה',305:'מס',320:'מס-קבלה',400:'קבלה',330:'זיכוי'};
    const FOLLOWUP_FOR={10:[[305,'מס']],300:[[305,'מס']],305:[[400,'קבלה']]};
    const EV_PAY_BG={red:'',yellow:'',green:'',none:''}, VAT_RATE=0.18;
    const state={user:{role:'admin'},company:'co_bpm'};
    const activeLinkedDocs=(e)=>(e.linkedDocs||[]).filter(d=>!d.credited&&!d.converted);
    const isNoInvoiceEv=(e)=>!!e.noInvoice, isBilledEv=(e)=>e.invoiceStatus==='invoiced';
    const isOverdueUnbilled=()=>false, evGross=(e)=>Number(e.price)||0;
    const followupDocForEvent=()=>null, creditableDocForEvent=()=>null;
    const evPayState=(e)=>'yellow', clientPaidBadge=()=>'', payDateFmt=(d)=>String(d||'');
  `;
  const fn = new Function('ev', stubs + '\n'
    + grab('function invoiceCell(e) {') + '\n'
    + grab('function rowEvent(e) {') + '\n'
    + 'return rowEvent(ev);');
  const ev = { id: 'e1', date: '2026-07-01', artist: 'אמן', location: 'ת"א', clientName: 'לקוח',
    price: 5000, confirmed: true, invoiceStatus: 'invoiced', employees: ['א'], contractors: ['ב'],
    linkedDocs: [{ id: 'd1', type: 305, number: '900' }] };
  const html = fn(ev);
  if (!/<tr/.test(html)) throw new Error('לא הופקה שורה');
  if (!/900/.test(html)) throw new Error('מספר המסמך לא מוצג');
  // גם אירוע בלי מסמכים ובלי אישור
  const html2 = fn({ id: 'e2', date: '2026-07-02', linkedDocs: [] });
  if (!/<tr/.test(html2)) throw new Error('אירוע בלי מסמכים נכשל');
  return true;
});

check('חלונית שנפתחת מתוך תצוגת מסמך מופיעה מעליה', () => {
  // השכבה נגזרת ממה שפתוח בפועל (topZ), ולא ממספר קבוע שנשבר בכל מסלול חדש.
  for (const id of ['docSendHistModal', 'docLinks']) {
    const i = app.indexOf(`id = '${id}'`);
    if (i < 0) throw new Error(id + ' לא נמצא');
    if (!/style\.zIndex = topZ\(/.test(app.slice(i, i + 900)))
      throw new Error(`${id}: אין חישוב שכבה — תיפתח מאחורי חלונית התצוגה`);
  }
  return true;
});

check('טבלה רחבה מוצגת ככרטיסים בפלאפון', () => {
  // טבלה שרוחבה המינימלי גדול ממסך פלאפון נגללת אופקית, וכפתורי הפעולה שבקצה
  // השורה יוצאים מהמסך — אי אפשר ללחוץ עליהם בלי לגלול את הטבלה הצידה.
  const missing = [];
  for (const m of app.matchAll(/<table([^>]*)>/g)) {
    const attrs = m[1];
    const mw = /min-width:\s*\$\{[^}]*\}|min-width:\s*(\d+)px/.exec(attrs);
    const w = mw && mw[1] ? Number(mw[1]) : (mw ? 999 : 0);   // ביטוי מחושב — מניחים רחב
    // no-cardify = פריסת דוח להדפסה (colspan ושורת סיכום) — כרטיסים היו הורסים אותה
    if (w >= 500 && !/class="[^"]*\bcardify\b/.test(attrs) && !/no-cardify/.test(attrs))
      missing.push(`min-width ${w || 'מחושב'}`);
  }
  if (missing.length) throw new Error(`${missing.length} טבלאות רחבות בלי כרטיסים: ${missing.join(', ')}`);
  // הכפתור הצף חייב להתחמק מתוכן — אחרת כפתור שנופל תחתיו אינו לחיץ כלל
  if (!/fab-away/.test(app) || !/fab-lift/.test(app)) throw new Error('הכפתור הצף אינו מתחמק מתוכן');
  if (!/avoidOverlap/.test(app)) throw new Error('אין בדיקת חפיפה לכפתור הצף');
  const css = fs.readFileSync('styles.css', 'utf8');
  // שדות קלט: padding מוטבע גובר, ולכן min-height הוא מה שאוכף גובל מגע
  if (!/input:not\(\[type=checkbox\]\):not\(\[type=radio\]\):not\(\[type=file\]\),select,textarea\{min-height:42px/.test(css))
    throw new Error('אין גובה מינימלי לשדות קלט בפלאפון');
  return true;
});

const invMod = await import('./invoicing.js');
check('רשימת ההפקה — זיכוי מלא מחזיר, זיכוי חלקי לא', () => {
  const base = { id: 'e', clientName: 'לקוח', price: 26000, invoiceStatus: 'pending', invoiceId: null, invoiceType: null };
  const inv = { id: 'i', type: 305, number: '50425' };
  const inList = (docs) => !invMod.eventsByClient([{ ...base, linkedDocs: docs }])[0].events[0].issued;
  const cases = [
    ['בלי מסמכים', [], true],
    ['חשבונית פעילה', [inv], false],
    ['זיכוי מלא', [{ ...inv, credited: true }, { id: 'c', type: 330, credit: true, amount: 26000 }], true],
    ['זיכוי חלקי', [{ ...inv, credited: true }, { id: 'c', type: 330, credit: true, amount: 5000 }], false],
    ['זיכוי מלא ואז חשבונית חדשה', [{ ...inv, credited: true }, { id: 'c', type: 330, credit: true, amount: 26000 }, { id: 'i2', type: 305, number: '50999' }], false],
    ['שני זיכויים חלקיים שמסתכמים למלא', [{ ...inv, credited: true }, { id: 'c1', type: 330, credit: true, amount: 20000 }, { id: 'c2', type: 330, credit: true, amount: 6000 }], true],
    ['סכום זיכוי לא ידוע — נחשב מלא', [{ ...inv, credited: true }, { id: 'c', type: 330, credit: true, amount: null }], true],
  ];
  for (const [name, docs, want] of cases) {
    const got = inList(docs);
    if (got !== want) throw new Error(`${name}: ${got ? 'ברשימה' : 'לא ברשימה'} — ציפייה ${want ? 'ברשימה' : 'לא ברשימה'}`);
  }
  return true;
});

check('שליחת מסמך ללקוח עוברת רק דרכנו, מייל אחד לשתי כתובות', () => {
  // חשבונית ירוקה לא תשלח ללקוח כלום: העברת כתובות אליה מוציאה מייל שאיננו
  // רואים, שלא נרשם ביומן, ושכישלון בו אינו מדווח.
  if (/opts\.sendEmail = true/.test(srv)) throw new Error('מסלול שעדיין מעביר כתובות לחשבונית ירוקה');
  if (/sendEmail: Boolean\(body\.sendEmail\)/.test(srv)) throw new Error('מסלול שעדיין מעביר כתובות לחשבונית ירוקה');
  const senders = (srv.match(/mailDocToClient\(/g) || []).length;
  if (senders < 6) throw new Error(`רק ${senders - 1} מסלולי הפקה שולחים מצדנו`);
  // מייל אחד לשתי הכתובות, לא שניים
  const fn = srv.match(/async function mailDocToClient[\s\S]*?\n\}/)[0];
  if (!/\[\.\.\.new Set\(\[\]\.concat\(emails \|\| \[\]\)/.test(fn))
    throw new Error('הכתובות אינן מאוחדות לנמענים של מייל אחד');
  if ((fn.match(/sendMailLogged\(/g) || []).length !== 1)
    throw new Error('נשלח יותר ממייל אחד');
  if (!/kind: 'document-client', companyId: cid, docId: doc\.id/.test(fn))
    throw new Error('השליחה אינה נרשמת על המסמך ולכן לא תופיע בהיסטוריה');
  // והמסך מציע כתובת שנייה
  if (!/nq-email2/.test(app)) throw new Error('אין שדה כתובת שנייה בחלונית המסמך');
  if (!/email2: \(e\.email2 \|\| ''\)\.trim\(\)/.test(app)) throw new Error('הכתובת השנייה לא נשלחת');
  return true;
});

const va = await import('./vehicleAlerts.js');
check('התראות תוקף רכב — שלושה ספים, בלי כפילות, ומתאפסות בחידוש', () => {
  const now = new Date('2026-08-25T09:00:00Z');
  const at = (d) => { const x = new Date(now); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  const mk = (over = {}) => ({ id: 'v1', plate: '12-345-67', kind: 'truck', alertsSent: {}, ...over });

  // כל סף מפעיל תזכורת אחת
  for (const t of [30, 14, 1]) {
    const d = va.dueAlerts([mk({ licenseExpiry: at(t) })], now);
    if (d.length !== 1 || d[0].threshold !== t) throw new Error(`סף ${t} לא הפעיל תזכורת`);
  }
  // מחוץ לטווח — שקט
  if (va.dueAlerts([mk({ licenseExpiry: at(45) })], now).length) throw new Error('תזכורת נשלחה 45 יום מראש');
  // מסמך שכבר פג — אין התראה מקדימה (הוא כבר אדום במסך)
  if (va.dueAlerts([mk({ licenseExpiry: at(-2) })], now).length) throw new Error('התראה מקדימה על מסמך שכבר פג');

  // אותה תזכורת לא נשלחת פעמיים
  const v = mk({ licenseExpiry: at(14) });
  const first = va.dueAlerts([v], now);
  v.alertsSent[first[0].key] = new Date().toISOString();
  if (va.dueAlerts([v], now).length) throw new Error('אותה תזכורת נשלחה פעמיים');

  // הסף הדחוף גובר: אחרי שנשלחה תזכורת 30, ביום ה-14 נשלחת תזכורת חדשה
  const v2 = mk({ licenseExpiry: at(14) });
  v2.alertsSent[va.sentKey('license', at(14), 30)] = 'x';
  const d14 = va.dueAlerts([v2], now);
  if (d14.length !== 1 || d14[0].threshold !== 14) throw new Error('תזכורת 14 לא נשלחה אחרי תזכורת 30');

  // חידוש — התוקף החדש מייצר מפתחות חדשים, כלומר מחזור תזכורות נקי
  const v3 = mk({ licenseExpiry: at(14) });
  v3.alertsSent[va.dueAlerts([v3], now)[0].key] = 'x';
  v3.licenseExpiry = at(370);
  if (va.dueAlerts([v3], now).length) throw new Error('תוקף חדש הפעיל תזכורת מיידית');
  v3.licenseExpiry = at(20);
  const after = va.dueAlerts([v3], now);
  if (after.length !== 1 || after[0].threshold !== 30) throw new Error('אחרי חידוש התזכורות לא התחילו מחדש');
  v3.alertsSent[after[0].key] = 'x';
  // המבחן האמיתי: אותו סף חוזר על התוקף החדש. מפתח שלא כולל את התאריך היה
  // בולע אותו, כי סף 14 כבר "נשלח" — על המסמך הקודם.
  v3.licenseExpiry = at(12);   // תוקף חדש, אבל שוב בטווח סף 14
  const again = va.dueAlerts([v3], now);
  if (again.length !== 1 || again[0].threshold !== 14)
    throw new Error('סף שחזר על התוקף החדש נבלע — מפתח השליחה אינו כולל את התאריך');

  // שלושה מסמכים שפגים באותו יום → מייל אחד, הדחוף בראש
  const many = va.dueAlerts([mk({ licenseExpiry: at(30), ctoExpiry: at(14), compExpiry: at(1) })], now);
  if (many.length !== 3) throw new Error('לא כל המסמכים נכללו');
  if (many[0].slot !== 'comp') throw new Error('הדחוף ביותר אינו ראשון');
  if (!/דחוף/.test(va.alertSubject(many))) throw new Error('נושא המייל לא משקף דחיפות');
  for (const it of many) if (!va.alertHtml('בי פי אם', many).includes(it.slotHe)) throw new Error('מסמך חסר בגוף המייל');
  if (/<style/.test(va.alertHtml('x', many))) throw new Error('<style> — Gmail מתעלם ממנו');

  // ספירת ימים לפי חצות
  if (va.daysUntil(at(1), now) !== 1) throw new Error('ספירת ימים שגויה');
  if (va.daysUntil('', now) !== null) throw new Error('תאריך ריק לא מטופל');
  return true;
});

check('סוגי מסמכי הרכב מסונכרנים בין ההתראות לממשק', () => {
  // אותה משמעת כמו הלשוניות: סוג מסמך שנוסף במקום אחד בלבד מייצר שדה שלא מתריע,
  // או התראה על שדה שאי אפשר למלא במסך.
  const backend = va.VEHICLE_SLOTS.map(x => x.key);
  const feKeys = [...app.match(/const VEH_SLOTS = \[[\s\S]*?\n\];/)[0].matchAll(/k: '([^']+)'/g)].map(m => m[1]);
  const feFields = [...app.match(/const VEH_SLOTS = \[[\s\S]*?\n\];/)[0].matchAll(/date: '([^']+)'/g)].map(m => m[1]);
  if (backend.join(',') !== feKeys.join(','))
    throw new Error(`מפתחות לא תואמים — שרת: ${backend.join(',')} · ממשק: ${feKeys.join(',')}`);
  if (va.VEHICLE_SLOTS.map(x => x.field).join(',') !== feFields.join(','))
    throw new Error('שמות שדות התוקף לא תואמים בין השרת לממשק');
  if (backend.length < 6) throw new Error(`רק ${backend.length} סוגי מסמכים`);
  for (const s of va.VEHICLE_SLOTS) if (!s.he || !s.renew) throw new Error(`לסוג ${s.key} חסר תיאור או פעולת חידוש`);
  // השרת נגזר מהמודול ולא מחזיק רשימה משלו
  if (!/VEHICLE_SLOTS = VEH_SLOT_DEFS\.map/.test(srv)) throw new Error('השרת מחזיק רשימת סוגים נפרדת');

  // מסמך נוסף שהמשתמש הגדיר — נכנס להתראות רק כשיש לו תוקף
  const now = new Date('2026-08-25T09:00:00Z');
  const at = (d) => { const x = new Date(now); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  const withExtras = { id: 'v', plate: 'X', alertsSent: {},
    extras: [{ id: 'x1', title: 'אישור מכון תקנים', expiry: at(5) }, { id: 'x2', title: 'בלי תוקף' }] };
  const d = va.dueAlerts([withExtras], now);
  if (d.length !== 1) throw new Error(`מסמך נוסף: ${d.length} תזכורות במקום 1`);
  if (d[0].slotHe !== 'אישור מכון תקנים') throw new Error('כותרת המסמך הנוסף לא מגיעה למייל');
  if (!d[0].key.startsWith('extra:x1:')) throw new Error('מפתח השליחה של מסמך נוסף שגוי');
  return true;
});

check('חידוש מסמך רכב מחייב תוקף חדש ומאוחר יותר', () => {
  const i = srv.indexOf("add('POST', /^\\/api\\/vehicles\\/([^/]+)\\/renew$/");
  if (i < 0) throw new Error('ראוט החידוש לא נמצא');
  const r = srv.slice(i, srv.indexOf('\n});', i));
  if (!/חסר תאריך תוקף חדש/.test(r)) throw new Error('אפשר לסמן טופל בלי תוקף חדש');
  if (!/next <= today/.test(r)) throw new Error('אפשר להזין תוקף שכבר עבר');
  if (!/next <= String\(prev\)/.test(r)) throw new Error('אפשר להזין תוקף שאינו מאוחר מהקיים');
  if (!/wrongCompany\(res, 'הרכב'\)/.test(r)) throw new Error('החידוש בלי בדיקת בעלות');
  if (!/v\.renewals = /.test(r)) throw new Error('החידוש לא נרשם בהיסטוריה');
  // הסימון "נשלח" נעשה רק אחרי שליחה מוצלחת — אחרת כישלון רשת בולע תזכורת
  const run = srv.match(/async function runVehicleAlerts[\s\S]*?\n\}/)[0];
  const iSend = run.indexOf('sendMailLogged'), iMark = run.indexOf('v.alertsSent[it.key]');
  if (iSend < 0 || iMark < 0 || iSend > iMark) throw new Error('תזכורת מסומנת כנשלחה לפני השליחה');
  if (!/ownedBy\(v, cid\)/.test(run)) throw new Error('ההתראות עוברות על רכבים של חברות אחרות');
  return true;
});

const rep = await import('./dailyReport.js');
check('דוח יומי — חברה שקטה לא מייצרת מייל', () => rep.buildReport({ companyName: 'x', overdueDays: 45 }) === null);
check('דוח יומי — אירוע מהחודש הנוכחי לא מתריע', () => rep.monthClosed('2026-08-05', new Date('2026-08-19')) === false);
check('דוח יומי — אירוע מחודש שעבר כן מתריע', () => rep.monthClosed('2026-07-28', new Date('2026-08-19')) === true);

const bk = await import('./backup.js');
check('גיבוי — מדיניות שמירה מותירה ~33 מתוך 400', () => {
  const now = new Date('2026-08-19T02:00:00Z');
  const files = Array.from({ length: 400 }, (_, i) => ({ id: 'f' + i, createdTime: new Date(now - i * 86400000).toISOString() }));
  const n = bk.planRetention(files, now).keep.length;
  if (n < 25 || n > 40) throw new Error('נשמרו ' + n);
  return true;
});
check('גיבוי — לעולם לא מוחק את האחרון', () =>
  bk.planRetention([{ id: 'x', createdTime: '2020-01-01T00:00:00Z' }], new Date()).remove.length === 0);

check('מעבר כרטיסייה — תשובה איטית של הקודמת לא נכתבת על החדשה', () => {
  // הבאג: כל רנדרר כותב ל-DOM אחרי await. מי שהחליף כרטיסייה בזמן הטעינה קיבל
  // את הנתונים של הכרטיסייה הקודמת על המסך החדש, או מסך שנתקע על תוכן ישן.
  const decl = app.match(/const rgen = [^\n]+\nconst rstale = [^\n]+/);
  if (!decl) throw new Error('עוזרי טוקן הרינדור לא נמצאו');
  const { rgen, rstale } = new Function(`${decl[0]}\nreturn { rgen, rstale };`)();

  const c = { dataset: {} };
  c.dataset.rgen = '1';            // נכנסים לכרטיסייה א'
  const gA = rgen(c);              // הרנדרר של א' לוכד את הטוקן ויוצא ל-await
  c.dataset.rgen = '2';            // המשתמש עבר לכרטיסייה ב'
  const gB = rgen(c);
  if (!rstale(c, gA)) throw new Error('הרנדרר הישן היה כותב על הכרטיסייה החדשה');
  if (rstale(c, gB)) throw new Error('הרנדרר הנוכחי נחסם בטעות');

  // render() חייב להנפיק טוקן חדש ולנקות את המסך לפני הטעינה
  const body = app.slice(app.indexOf('function render() {'), app.indexOf('function render() {') + 600);
  if (!/dataset\.rgen = String\(\+\+_renderGen\)/.test(body)) throw new Error('render() לא מנפיק טוקן חדש');
  if (!/c\.innerHTML = '<div class="panel"><div class="empty">טוען/.test(body)) throw new Error('render() לא מנקה את הכרטיסייה הקודמת');

  // כל רנדרר של לשונית — לכידה בראש הפונקציה והגנה לפני הכתיבה
  const renderers = ['renderHome', 'renderBusinessSummary', 'renderCombined', 'renderClients', 'renderQuotes',
    'renderBank', 'renderContractors', 'renderPayroll', 'renderVehicles', 'renderEventsBoard', 'renderBusiness'];
  const L = app.split('\n');
  for (const n of renderers) {
    const st = L.findIndex(l => new RegExp(`^(async )?function ${n}\\b`).test(l));
    if (st < 0) throw new Error(n + ' לא נמצא');
    if (!/const _g = rgen\(c\);/.test(L[st + 1])) throw new Error(n + ' לא לוכד את הטוקן');
    let d = 0, end = st;
    for (let i = st; i < L.length; i++) { d += (L[i].split('{').length - 1) - (L[i].split('}').length - 1); if (d === 0 && i > st) { end = i; break; } }
    let seenAwait = false, guarded = false;
    for (let i = st; i <= end; i++) {
      if (/\bawait\b/.test(L[i])) seenAwait = true;
      if (/if \(rstale\(c, _g\)\) return;/.test(L[i])) guarded = true;
      if (seenAwait && /^  c\.innerHTML\s*=|^  if \(!r \|\| !r\.ok\) \{ c\.innerHTML/.test(L[i])) {
        if (!guarded) throw new Error(n + ' כותב ל-DOM אחרי await בלי הגנה (שורה ' + (i + 1) + ')');
        break;
      }
    }
  }
  return true;
});
check('כרטיסיית האירועים לא ממתינה לסנכרון היומן', () => {
  // האימוץ מהיומן חסום לפעם ביום בשרת; המתנה לו לפני בקשת האירועים היא סיבוב
  // רשת מיותר בכל כניסה לכרטיסייה הנפוצה ביותר.
  const i = app.indexOf('async function renderCombined');
  const body = app.slice(i, i + 1200);
  if (/await autoAdoptCalendar\(\)/.test(body)) throw new Error('הרינדור עדיין חוסם על סנכרון היומן');
  if (!/autoAdoptCalendar\(\)\s*\n?\s*\.then\(/.test(body)) throw new Error('הסנכרון לא רץ ברקע');
  return true;
});

check('תוויות סוגי המסמכים זהות בכל המפות', () => {
  // בבורר המסמכים בדף הבית 300 ו-10 היו הפוכים: "חשבון עסקה" סומן כהצעת מחיר
  // ולהפך. שלוש מפות אחרות בקוד היו נכונות, ולכן אותו סוג הופיע בשני שמות.
  const truth = { 10: 'הצעת מחיר', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 330: 'חשבונית זיכוי', 400: 'קבלה' };
  const opts = app.match(/const DOC_TYPE_OPTIONS = \[([\s\S]*?)\];/);
  if (!opts) throw new Error('בורר סוגי המסמכים לא נמצא');
  for (const m of opts[1].matchAll(/\{ v: '(\d+)', label: '([^']+)' \}/g)) {
    if (truth[m[1]] && truth[m[1]] !== m[2]) throw new Error(`סוג ${m[1]} מסומן "${m[2]}" במקום "${truth[m[1]]}"`);
  }
  const names = app.match(/const DOC_TYPE_NAMES = \{([^}]*)\}/);
  for (const m of names[1].matchAll(/(\d+): '([^']+)'/g)) {
    if (truth[m[1]] && truth[m[1]] !== m[2]) throw new Error(`DOC_TYPE_NAMES: סוג ${m[1]} = "${m[2]}"`);
  }
  const srv = fs.readFileSync('server.js', 'utf8').match(/const DOC_NAMES_HE = \{([^}]*)\}/);
  for (const m of srv[1].matchAll(/(\d+): '([^']+)'/g)) {
    if (truth[m[1]] && truth[m[1]] !== m[2]) throw new Error(`DOC_NAMES_HE: סוג ${m[1]} = "${m[2]}"`);
  }
  return true;
});
check('הכנסות עסק — זיכויים ומסמכים מבוטלים יורדים מהסכום', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const i = srv.indexOf("add('GET', /^\\/api\\/home-figures$/");
  if (i < 0) throw new Error('הראוט לא נמצא');
  const body = srv.slice(i, srv.indexOf("\n});", i));
  if (!/Number\(d\.status\) !== 4/.test(body)) throw new Error('מסמכים מבוטלים נספרים כהכנסה');
  if (!/netIncVat:[^\n]*- sum\(crd/.test(body)) throw new Error('זיכויים לא מופחתים מההכנסה');
  if (!/\[305, 320\]\.includes/.test(body)) throw new Error('ההכנסה אינה מוגבלת לחשבוניות מס');
  if (/400/.test(body.match(/incomeForRange\([^)]*\)/)[0])) throw new Error('קבלות נספרות — כפילות מול החשבונית');
  // ההוצאות חייבות להשתמש באותה הגדרת שיוך כמו סיכום העסק
  if (!/matchStatus === 'manual' \|\| t\.matchStatus === 'approved'/.test(body)) throw new Error('הגדרת ההוצאות אינה תואמת לסיכום העסק');
  return true;
});

check('חלוניות הפירוט של דף הבית נבנות בלי שגיאת ריצה', () => {
  // הבדיקות הסטטיות עיוורות ל-HTML שנשבר בזמן ריצה. כאן החלוניות באמת נבנות.
  const helper = app.slice(app.indexOf('function _figModal('), app.indexOf('// "איך הגענו למספר"'));
  const stubs = `
    const money=(n)=>String(n);
    const escapeHtml=(x)=>String(x==null?'':x);
    const DOC_TYPE_SHORT = { 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 330: 'זיכוי' };
    const state = { company: 'co_moshe' };
    let captured = '';
    const document = { getElementById: () => null, createElement: () => ({ classList:{add(){},remove(){}}, style:{}, set innerHTML(v){ captured = v; }, get innerHTML(){ return captured; } }), body:{ appendChild(){} } };
    const window = {}; const topZ = () => '300';
  `;
  const fig = {
    year: 2026,
    income: { invoicesIncVat: 177000, invoicesExVat: 150000, invoiceCount: 2, creditsIncVat: 11800, creditsExVat: 10000,
      creditCount: 1, cancelledCount: 1, cancelledIncVat: 23600, netIncVat: 165200, netExVat: 140000,
      futureCount: 2, futureExVat: 35800, futureIncVat: 42244,
      futureDocs: [{ id: 'f1', number: 50501, type: 305, date: '2026-10-01', clientName: 'לקוח עתידי', exVat: 20000, incVat: 23600 },
                   { id: 'f2', number: 50502, type: 320, date: '2026-11-15', clientName: 'לקוח נוסף', exVat: 15800, incVat: 18644 }] },
    expenses: { matched: 90000, matchedCount: 12, unmatched: 4000, unmatchedCount: 2 },
  };
  const src = app.slice(app.indexOf('window.openIncomeBreakdown'), app.indexOf('async function renderHome(c)'));
  const run = new Function('fig', `${stubs}\n${helper}\n${src}\nlet _homeFig = fig;\nwindow.openIncomeBreakdown(); const a = captured; window.openExpenseBreakdown(); return [a, captured];`);
  const [incHtml, expHtml] = run(fig);
  for (const [html, want] of [[incHtml, '165,200'], [incHtml, 'הכנסות עסק'], [expHtml, 'הוצאות עסק']]) {
    if (!String(html).length) throw new Error('החלונית יצאה ריקה');
  }
  if (!/165200|165,200/.test(incHtml)) throw new Error('סכום ההכנסות לא מופיע בחלונית');
  if (!/חשבוניות זיכוי/.test(incHtml)) throw new Error('שורת הזיכויים חסרה');
  if (!/מבוטלים/.test(incHtml)) throw new Error('שורת המסמכים המבוטלים חסרה');
  if (!/ממתינות לשיוך/.test(expHtml)) throw new Error('שורת התנועות שלא שויכו חסרה');
  // רשימת המסמכים בתאריך עתידי — הדרך היחידה לראות מאיפה בא ההפרש מול חשבונית ירוקה
  if (!/50501/.test(incHtml) || !/50502/.test(incHtml)) throw new Error('המסמכים בתאריך עתידי לא נפרטו');
  if (!/01\/10\/2026/.test(incHtml)) throw new Error('התאריך אינו מוצג בפורמט ישראלי');
  if (!/לקוח עתידי/.test(incHtml)) throw new Error('שם הלקוח חסר ברשימה');
  // המצב ההפוך: אין מסמכים עתידיים. גם אז חייב להופיע חיווי, אחרת היעדר הטבלה
  // לא אומר למשתמש כלום והוא מחפש משהו שלא קיים.
  const none = JSON.parse(JSON.stringify(fig));
  none.income.futureCount = 0; none.income.futureExVat = 0; none.income.futureDocs = [];
  const [zeroHtml] = run(none);
  if (!/מסמכים בתאריך עתידי: אין/.test(zeroHtml)) throw new Error('אין חיווי כשאין מסמכים עתידיים');
  if (!/לא<\/b> נובע מטווח התאריכים/.test(zeroHtml)) throw new Error('חסר ההסבר שאפשר לפסול את טווח התאריכים');
  return true;
});

check('מטמון: לשונית מצטיירת מיד מהמטמון ומתרעננת ברקע', async () => {
  // קודם: מטמון של 60 שניות שנמחק כולו אחרי כל פעולה, ולכן בזמן עבודה כל מעבר
  // לשונית חיכה לסיבוב רשת מלא מול חשבונית ירוקה.
  const src = app.slice(app.indexOf('const API_MAX = 150;'), app.indexOf('// בידוד חברות + ניקוי מטמון'));
  let calls = 0, payload = '{"v":1}', rendered = 0;
  const stubs = `
    const _apiCache = new Map(); const API_TTL = 60000; const POST_WRITE_FRESH_MS = 30000;
    let _lastWriteAt = 0;
    const state = { company: 'co_bpm', tab: 'home' };
    const $ = () => ({ dataset: { rgen: '1' } });
    const rgen = (c) => (c && c.dataset ? c.dataset.rgen : undefined);
    const TAB_RENDERERS = { home: () => { onRender(); } };
    const fetch = (p) => { onFetch(); return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, text: () => Promise.resolve(body()) }); };
  `;
  const build = new Function('onFetch', 'onRender', 'body', `${stubs}\n${src}\nreturn { api, cache: _apiCache };`);
  const { api, cache } = build(() => calls++, () => rendered++, () => payload);

  const a = await api('/api/x');
  if (a.v !== 1 || calls !== 1) throw new Error('הקריאה הראשונה לא פנתה לשרת פעם אחת');

  const b = await api('/api/x');                       // בתוך התוקף — בלי רשת
  if (b.v !== 1 || calls !== 1) throw new Error('קריאה חוזרת בתוך התוקף פנתה לשרת');

  cache.get('/api/x?companyId=co_bpm').t -= 120000;    // הזדקנות
  payload = '{"v":2}';
  const t0 = Date.now();
  const c2 = await api('/api/x');
  if (Date.now() - t0 > 40) throw new Error('התשובה מהמטמון לא הוחזרה מיד');
  if (c2.v !== 1) throw new Error('לא הוצג הערך מהמטמון בזמן הרענון');
  if (calls !== 2) throw new Error('רענון הרקע לא יצא לדרך');
  await new Promise(r => setTimeout(r, 30));
  if (rendered !== 1) throw new Error('הנתונים השתנו והלשונית לא צוירה מחדש');

  const d = await api('/api/x');                       // עכשיו המטמון מעודכן
  if (d.v !== 2) throw new Error('המטמון לא התעדכן בתשובה הטרייה');
  return true;
});

check('הפקת מסמך אינה מבקשת מחשבונית ירוקה לשלוח ללקוח', () => {
  // המשתמש דיווח שמסמך נשלח ללקוח למרות שלא סימן שליחה. הבדיקה נועלת את הצד
  // שלנו: הגוף שנשלח ל-POST /documents מקבל emails רק כששניהם נכונים.
  const gi = fs.readFileSync('greenInvoice.js', 'utf8');
  const body = gi.slice(gi.indexOf('function documentBody'), gi.indexOf('export async function createDocument'));
  const mails = [...body.matchAll(/body\.emails\s*=/g)];
  if (mails.length !== 1) throw new Error(`יש ${mails.length} מקומות שקובעים emails בגוף המסמך`);
  if (!/if \(sendEmail && email\) body\.emails =/.test(body)) throw new Error('emails נקבע בלי תנאי שליחה מפורש');
  // ואף ראוט הפקה אינו מעביר sendEmail לחשבונית ירוקה
  const srv = fs.readFileSync('server.js', 'utf8');
  const leaks = [...srv.matchAll(/opts\.sendEmail\s*=|sendEmail:\s*Boolean\(body\.sendEmail\)/g)];
  if (leaks.length) throw new Error('ראוט מעביר בקשת שליחה לחשבונית ירוקה');
  // האבחון קיים, אחרת אין דרך להוכיח מי שלח
  if (!/api\\\/diag\\\/doc-payloads/.test(srv)) throw new Error('ראוט האבחון חסר');
  if (!/recordDocBody\(_body\)/.test(gi)) throw new Error('גוף הבקשה אינו מתועד');
  return true;
});

check('כל מסלול מסמך המשך מקשר את המסמך לאירועים של המקור', () => {
  // שלושת המסלולים שמפיקים מסמך המשך חייבים לקשר אותו לאירועים של המקור.
  // שניים מהם לא עשו זאת, ולכן חשבונית שהופקה מהצעת מחיר לא הופיעה על האירוע.
  const srv = fs.readFileSync('server.js', 'utf8');
  const starts = [...srv.matchAll(/^add\('POST', \/\^[^\n]*$/gm)].map(m => ({ i: m.index, t: m[0] }));
  const routeBody = (needle) => {
    const k = starts.findIndex(x => x.t.includes(needle));
    if (k < 0) throw new Error('ראוט לא נמצא: ' + needle);
    return srv.slice(starts[k].i, k + 1 < starts.length ? starts[k + 1].i : srv.length);
  };
  for (const [needle, label] of [['/derive$', 'מסמך המשך'], ['/quotes\\/([^/]+)\\/followup$', 'המשך מהצעת מחיר'], ['/documents\\/consolidate$', 'איחוד מסמכים']]) {
    const b = routeBody(needle);
    if (!/linkFollowupToEvents\(/.test(b)) throw new Error(`מסלול "${label}" אינו מקשר לאירועים`);
  }
  const helper = srv.slice(srv.indexOf('function linkFollowupToEvents'), srv.indexOf('function followupRemarks'));
  if (!/ownedBy\(ev, cid\)/.test(helper)) throw new Error('הלולאה על האירועים אינה מסננת לפי חברה');
  return true;
});
check('שיוך מסמך המשך — ריצה אמיתית על אירועים', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('function linkFollowupToEvents'), srv.indexOf('function followupRemarks'));
  const fn = new Function('ownedBy', `${src}\nreturn linkFollowupToEvents;`)((r, c) => !r.companyId || r.companyId === c);
  const db = { events: [
    { id: 'e1', companyId: 'co_bpm', linkedDocs: [{ id: 'q616', number: 616, type: 10 }] },
    { id: 'e2', companyId: 'co_bpm', linkedDocs: [{ id: 'q616', number: 616, type: 10 }] },
    { id: 'e3', companyId: 'co_ofek', linkedDocs: [{ id: 'q616', number: 616, type: 10 }] },
    { id: 'e4', companyId: 'co_bpm', linkedDocs: [{ id: 'zzz', number: 999, type: 10 }] },
  ] };
  const touched = fn(db, 'co_bpm', new Set(['q616', '616']), { id: 'd40468', number: 40468 }, 300);
  if (!touched) throw new Error('לא סומן שינוי');
  const e1 = db.events[0];
  if (!e1.linkedDocs.some(d => d.id === 'd40468')) throw new Error('המסמך החדש לא נוסף לאירוע');
  if (!e1.linkedDocs.find(d => d.id === 'q616').converted) throw new Error('ההצעה לא סומנה כהומרה');
  if (e1.invoiceId !== 'd40468' || e1.invoiceStatus !== 'invoiced') throw new Error('האירוע לא סומן כמחויב');
  if (!db.events[1].linkedDocs.some(d => d.id === 'd40468')) throw new Error('אירוע שני של אותה הצעה לא קושר');
  if (db.events[2].linkedDocs.some(d => d.id === 'd40468')) throw new Error('זליגה: אירוע של חברה אחרת קושר');
  if (db.events[3].linkedDocs.some(d => d.id === 'd40468')) throw new Error('אירוע ללא קשר למקור קושר');
  return true;
});

check('תיקון רטרואקטיבי: מוצא את הנגזר כששאילתת החיפוש לא מחזירה קישורים', () => {
  // כך זה בפרודקשן: חשבונית ירוקה לא מחזירה linkedDocumentIds בתוצאות החיפוש
  // (0 התאמות מתוך 140 מסמכים). הקישור קיים רק על המסמך עצמו.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('const BACKFILL_VERSION'), srv.indexOf('async function runAllFollowupBackfills'));
  const link = srv.slice(srv.indexOf('function linkFollowupToEvents'), srv.indexOf('function followupRemarks'));
  let db = { events: [{ id: 'e1', companyId: 'co_bpm', clientName: 'לקוח א', date: '2026-06-25',
    linkedDocs: [{ id: 'q616', number: 616, type: 10 }] }] };
  // הרשימה נקייה מקישורים, כמו בפועל. הקישור יושב על הצעת המחיר עצמה.
  const list = [{ id: 'd40468', number: 40468, type: 300, clientName: 'אחר לגמרי', amount: 999, linkedDocumentIds: [] },
                { id: 'dOther', number: 40100, type: 305, clientName: 'לקוח א', amount: 12345, linkedDocumentIds: [] }];
  // הקישור יושב על הנגזר ומצביע למקור — כמו בפועל. המקור עצמו מחזיר קישור ריק.
  const full = { q616: { id: 'q616', type: 10, linkedDocumentIds: [] },
                 d40468: { id: 'd40468', type: 300, linkedDocumentIds: ['q616'] },
                 dOther: { id: 'dOther', type: 305, linkedDocumentIds: [] } };
  let calls = 0;
  const run = new Function('deps', `
    const { giEnabled, greenInvoice, load, save, shiftISODays, sameClientName, ownedBy } = deps;
    ${link}
    ${src}
    return runFollowupBackfill;
  `)({
    giEnabled: () => true,
    greenInvoice: { linkedIdsOf: giLinkedIds, haveCredentials: () => true, incomeForRange: async () => ({ docs: list }),
      getDocument: async (id) => { calls++; return full[id] || list.find(d => d.id === id) || null; } },
    load: () => db, save: (x) => { db = x; },
    shiftISODays: (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); },
    sameClientName: (a, b) => String(a || '').trim() === String(b || '').trim(),
    ownedBy: (r, c) => !r.companyId || r.companyId === c,
  });
  return run('co_bpm').then(res => {
    if (res.linked !== 1) throw new Error('לא נמצא הנגזר (' + JSON.stringify(res.stat) + ')');
    if (!res.stat || res.stat.matched !== 1) throw new Error('לא נרשמה התאמה אחת');
    if (res.stat.scanned !== 2) throw new Error('לא נסרקו כל מסמכי הטווח');
    const e1 = db.events[0];
    if (!e1.linkedDocs.some(d => d.id === 'd40468')) throw new Error('המסמך לא קושר לאירוע');
    // ולא נבחר המסמך של אותו לקוח שאינו קשור — שם לקוח אינו ראיה
    if (e1.linkedDocs.some(d => d.id === 'dOther')) throw new Error('נבחר מסמך לא קשור לפי שם לקוח');
    return true;
  });
});
check('תיקון רטרואקטיבי: מקשר מסמכי המשך שלא קושרו, ולא נוגע בשאר', () => {
  // התיקון כותב לנתוני אמת. הוא חייב: לקשר את מה שצריך, לא לגעת באירוע של
  // חברה אחרת, לא לגעת באירוע שכבר יש לו חשבונית, ולא למחוק כלום.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('const BACKFILL_VERSION'), srv.indexOf('async function runAllFollowupBackfills'));
  const link = srv.slice(srv.indexOf('function linkFollowupToEvents'), srv.indexOf('function followupRemarks'));

  let db = { events: [
    // צריך תיקון: הצעת מחיר 616 בלי חשבונית על האירוע
    { id: 'e1', companyId: 'co_bpm', clientName: 'לקוח א', date: '2026-06-25',
      linkedDocs: [{ id: 'q616', number: 616, type: 10, amount: 10000 }] },
    // כבר יש חשבונית מס פעילה — אין מה לתקן
    { id: 'e2', companyId: 'co_bpm', clientName: 'לקוח ב', date: '2026-06-25',
      linkedDocs: [{ id: 'q700', number: 700, type: 10 }, { id: 'd1', number: 50001, type: 305 }] },
    // חברה אחרת — אסור לגעת
    { id: 'e3', companyId: 'co_ofek', clientName: 'לקוח א', date: '2026-06-25',
      linkedDocs: [{ id: 'q616', number: 616, type: 10 }] },
    // מסמך שהועלה ידנית — לא מקור להמשך בחשבונית ירוקה
    { id: 'e4', companyId: 'co_bpm', clientName: 'לקוח ד', date: '2026-06-25',
      linkedDocs: [{ id: 'up1', number: 5, type: 300, uploaded: true }] },
  ] };
  const income = [{ id: 'd40468', number: 40468, type: 300, clientName: 'לקוח א', amount: 10000, linkedDocumentIds: ['q616'] }];
  let getDocCalls = 0;
  const gi = {
    haveCredentials: () => true,
    incomeForRange: async () => ({ docs: income }),
    getDocument: async (id) => { getDocCalls++; return income.find(d => d.id === id) || null; },
  };
  const run = new Function('deps', `
    const { giEnabled, greenInvoice, load, save, shiftISODays, sameClientName, ownedBy } = deps;
    ${link}
    ${src}
    return { runFollowupBackfill, backfillCandidates };
  `)({
    giEnabled: () => true,
    greenInvoice: Object.assign({ linkedIdsOf: giLinkedIds }, gi),
    load: () => db,
    save: (x) => { db = x; },
    shiftISODays: (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); },
    sameClientName: (a, b) => String(a || '').trim() === String(b || '').trim(),
    ownedBy: (r, c) => !r.companyId || r.companyId === c,
  });

  const cands = run.backfillCandidates(db, 'co_bpm');
  const ids = cands.map(c => c.ev.id);
  if (!ids.includes('e1')) throw new Error('האירוע שצריך תיקון לא זוהה');
  if (ids.includes('e2')) throw new Error('אירוע שכבר יש לו חשבונית נבחר לתיקון');
  // חשבון עסקה הוא מקור לגיטימי לחשבונית מס — לא לפסול אותו
  const chain = { events: [{ id: 'x1', companyId: 'co_bpm', clientName: 'ל', date: '2026-06-25',
    linkedDocs: [{ id: 'p300', number: 40001, type: 300 }] }] };
  if (!run.backfillCandidates(chain, 'co_bpm').length) throw new Error('חשבון עסקה לא זוהה כמקור אפשרי');
  if (ids.includes('e3')) throw new Error('זליגה: אירוע של חברה אחרת נבחר');
  if (ids.includes('e4')) throw new Error('מסמך שהועלה ידנית נבחר כמקור');

  return run.runFollowupBackfill('co_bpm').then(res => {
    if (res.linked !== 1) throw new Error('קושרו ' + res.linked + ' במקום 1');
    const e1 = db.events.find(e => e.id === 'e1');
    if (!e1.linkedDocs.some(d => String(d.id) === 'd40468')) throw new Error('המסמך לא נוסף לאירוע');
    if (!e1.linkedDocs.find(d => d.id === 'q616').converted) throw new Error('ההצעה לא סומנה כהומרה');
    if (e1.invoiceNumber !== 40468) throw new Error('מספר החשבונית לא נשמר על האירוע');
    if (e1.linkedDocs.length !== 2) throw new Error('נמחק או נוסף משהו מעבר לצפוי');
    const e3 = db.events.find(e => e.id === 'e3');
    if (e3.linkedDocs.length !== 1 || e3.linkedDocs[0].converted) throw new Error('אירוע של חברה אחרת נגוע');
    const e2 = db.events.find(e => e.id === 'e2');
    if (e2.linkedDocs.length !== 2) throw new Error('אירוע שלא היה צריך תיקון שונה');
    // ריצה חוזרת לא משנה דבר (אידמפוטנטי)
    return run.runFollowupBackfill('co_bpm').then(r2 => {
      if (r2.linked !== 0) throw new Error('ריצה חוזרת קישרה שוב');
      if (db.events.find(e => e.id === 'e1').linkedDocs.length !== 2) throw new Error('ריצה חוזרת שינתה את האירוע');
      return true;
    });
  });
});

check('כל greenInvoice.X שהשרת קורא לו קיים בייצוא', () => {
  // השרת מייבא את המודול כברירת מחדל. פונקציה חדשה שנשכחה מאובייקט הייצוא
  // עוברת תחביר ובדיקות עם סטאבים, ונופלת רק בפרודקשן.
  const gi = fs.readFileSync('greenInvoice.js', 'utf8');
  const exported = new Set((gi.match(/export const greenInvoice = \{([^}]*)\}/) || [, ''])[1]
    .split(',').map(x => x.split(':')[0].trim()).filter(Boolean));
  const srv = fs.readFileSync('server.js', 'utf8');
  // לא לתפוס את המחרוזת './greenInvoice.js' של הייבוא
  const used = new Set([...srv.matchAll(/(?<![./'"])\bgreenInvoice\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  const consts = new Set([...gi.matchAll(/export const (\w+)/g)].map(m => m[1]));
  const missing = [...used].filter(n => !exported.has(n) && !consts.has(n));
  if (missing.length) throw new Error('חסר בייצוא: ' + missing.join(', '));
  return true;
});

check('סכום הזיכוי נמשך מחשבונית ירוקה לפני ההחלטה', () => {
  // בלי הסכום כל זיכוי נחשב מלא, ולכן אירוע שזוכה חלקית חזר לרשימת ההפקה.
  // ההשוואה חייבת להיות ללא מע"מ — סכום האירוע מוזן ללא מע"מ.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('async function enrichCreditAmounts'), srv.indexOf('// GET /api/invoicing/clients'));
  if (!/amountExVat/.test(src)) throw new Error('הסכום נלקח כולל מע"מ — ישווה מול סכום אירוע ללא מע"מ');
  const docs = [{ id: 'c70099', number: 70099, type: 330, amountExVat: 5000, amountIncVat: 5900 }];
  const fn = new Function('deps', `
    const { giEnabled, greenInvoice, shiftISODays } = deps;
    ${src}
    return enrichCreditAmounts;
  `)({
    giEnabled: () => true,
    greenInvoice: { haveCredentials: () => true, incomeForRange: async () => ({ docs }) },
    shiftISODays: (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); },
  });
  const base = { id: 'e', clientName: 'לקוח', price: 26000, date: '2026-07-26', invoiceStatus: 'pending' };
  const evs = [{ ...base, linkedDocs: [
    { id: 'i', type: 305, number: '50425', credited: true },
    { id: 'c70099', number: 70099, type: 330, credit: true },   // בלי סכום, כמו בפועל
  ] }];
  // לפני ההעשרה — הזיכוי נחשב מלא והאירוע חוזר לרשימה
  if (invMod.eventsByClient(evs)[0].events[0].issued) throw new Error('בלי סכום האירוע כבר לא חוזר לרשימה — הבדיקה איבדה משמעות');
  return fn(evs, 'co_bpm').then(out => {
    const c = out[0].linkedDocs.find(d => d.id === 'c70099');
    if (Number(c.amount) !== 5000) throw new Error('הסכום לא נמשך: ' + c.amount);
    if (!invMod.eventsByClient(out)[0].events[0].issued) throw new Error('זיכוי חלקי עדיין מחזיר את האירוע לרשימה');
    // וזיכוי מלא כן מחזיר
    docs[0].amountExVat = 26000;
    return fn([{ ...base, linkedDocs: [
      { id: 'i', type: 305, number: '50425', credited: true },
      { id: 'c70099', number: 70099, type: 330, credit: true }] }], 'co_bpm').then(full => {
      if (invMod.eventsByClient(full)[0].events[0].issued) throw new Error('זיכוי מלא לא מחזיר את האירוע לרשימה');
      return true;
    });
  });
});

check('מסך לד — מחיר בלי כמות נחשב כמות 1', () => {
  // הוזן מחיר לד בלי כמות מטרים: השורה נעדרה מהחשבונית, והסכום הכולל של
  // האירוע יצא נמוך מהמוסכם — בשקט, בלי שום חיווי.
  const ev = { id: 'e', artist: 'אמן', date: '2026-07-26', ledPricePerMeter: 5000 };
  if (invMod.eventTotal(ev) !== 5000) throw new Error('סכום האירוע: ' + invMod.eventTotal(ev));
  const lines = invMod.invoiceItemsFromEvents([ev]);
  const led = lines.find(l => /מסך לד/.test(l.description));
  if (!led) throw new Error('שורת הלד לא נכנסה לחשבונית');
  if (led.quantity !== 1 || led.price !== 5000) throw new Error(`כמות ${led.quantity} מחיר ${led.price}`);
  // כמות מפורשת גוברת
  const ev2 = { ...ev, ledMeters: 4 };
  if (invMod.eventTotal(ev2) !== 20000) throw new Error('כמות מפורשת לא נלקחה: ' + invMod.eventTotal(ev2));
  // כמות בלי מחיר — אין שורה ואין סכום
  const ev3 = { id: 'e3', ledMeters: 6 };
  if (invMod.eventTotal(ev3) !== 0) throw new Error('כמות בלי מחיר יצרה סכום');
  if (invMod.invoiceItemsFromEvents([ev3]).some(l => /מסך לד/.test(l.description))) throw new Error('כמות בלי מחיר יצרה שורה');

  // המסך והחשבונית חייבים להסכים על אותו סכום
  const evGrossSrc = app.slice(app.indexOf('const evLedQty ='), app.indexOf('\n', app.indexOf('const evGross =')));
  const gross = new Function(`${evGrossSrc}\nreturn evGross;`)();
  for (const t of [ev, ev2, ev3, { ...ev, price: 1200, priceExtras: 300 }]) {
    if (gross(t) !== invMod.eventTotal(t)) throw new Error(`המסך מראה ${gross(t)} והחשבונית ${invMod.eventTotal(t)}`);
  }
  return true;
});

check('יומית וחצי מתפרקת לתשלום ובונוס גם בהגדרה ידנית', async () => {
  // הפירוק נעשה רק כשהביטוי זוהה בהערת האירוע. הגדרה ידנית של הפקטור הציגה
  // סכום אחד בלי בונוס, ולכן בטבלת העובד לא נראה מאיפה מגיעה התוספת.
  const pr = await import('./payroll.js');
  const mk = (det) => ({ id: 'e1', date: '2026-08-20', artist: 'הופעה', location: 'תל אביב', employeeDetails: [det] });
  const emps = [{ name: 'כפיר', baseRate: 800 }];
  const run = (det) => pr.employeePayForMonth([mk(det)], '2026-08', emps)[0];

  const half = run({ name: 'כפיר', factor: 1.5 });
  const s1 = half.shifts[0];
  if (s1.base !== 800 || s1.bonus !== 400) throw new Error(`יומית וחצי: תשלום ${s1.base} בונוס ${s1.bonus}`);
  if (s1.factorLabel !== 'יומית וחצי') throw new Error('חסרה תווית: ' + s1.factorLabel);
  if (half.total !== 1200) throw new Error('הסכום הכולל השתנה: ' + half.total);

  const dbl = run({ name: 'כפיר', factor: 2 });
  if (dbl.shifts[0].base !== 800 || dbl.shifts[0].bonus !== 800) throw new Error('כפולה לא התפרקה');
  if (dbl.total !== 1600) throw new Error('הסכום הכולל של כפולה השתנה: ' + dbl.total);

  // יומית רגילה — בלי תווית ובלי בונוס
  const one = run({ name: 'כפיר', factor: 1 });
  if (one.shifts[0].bonus !== 0 || one.shifts[0].factorLabel) throw new Error('יומית רגילה סומנה');

  // שכר שהוזן ידנית למשמרת הוא סכום מפורש — לא מפורק
  const manual = run({ name: 'כפיר', factor: 1.5, rate: 1000 });
  if (manual.shifts[0].base !== 1000 || manual.shifts[0].bonus !== 0) throw new Error('שכר ידני פורק בטעות');

  // בונוס קיים אינו נמחק — הוא מצטבר
  const withBonus = run({ name: 'כפיר', factor: 1.5, bonus: 100 });
  if (withBonus.shifts[0].bonus !== 500) throw new Error('בונוס קיים נדרס: ' + withBonus.shifts[0].bonus);

  // התווית מגיעה לטבלה במסך
  if (!/factorLabel: s\.factorLabel/.test(app)) throw new Error('התווית לא מועברת לשורות הדוח');
  if (!/r\.factorLabel \?/.test(app)) throw new Error('התווית לא מוצגת בשורה');
  return true;
});

check('תצוגת חיוב — החלונית נבנית ומציגה את מסמכי האירוע', () => {
  // ממסך הספקים, כשכתוב "ממתין לתשלום מהלקוח", צריך להגיע לחשבונית עצמה.
  const src = app.slice(app.indexOf('window.openBillingView'), app.indexOf('function clientPaidBadge'));
  let captured = '', url = '';
  const stubs = `
    const money=(n)=>String(n), escapeHtml=(x)=>String(x==null?'':x), ddmy=(d)=>String(d||'');
    const DOC_TYPE_SHORT = { 300: 'חשבון עסקה', 305: 'חשבונית מס', 330: 'זיכוי' };
    const api = (p) => { url = p; return Promise.resolve(payload); };
    const document = { getElementById: () => null, body: { appendChild(){} },
      createElement: () => ({ classList:{add(){},remove(){}}, style:{}, set innerHTML(v){ captured = v; }, get innerHTML(){ return captured; } }) };
    const window = {}; const topZ = () => '300';
  `;
  const build = (payload) => new Function('payload', `${stubs}\n${src}\nreturn window.openBillingView('ev1').then(() => [captured, url]);`)(payload);

  return build({ ok: true, eventId: 'ev1', clientName: 'לקוח א', artist: 'אמן', date: '2026-08-20', amount: 5000,
    docs: [{ id: 'd1', number: 40468, type: 300, credit: false, converted: false, credited: false, amount: 5000 },
           { id: 'd2', number: 70099, type: 330, credit: true, amount: 1000 }] }).then(([html, u]) => {
    if (!/\/api\/events\/ev1\/billing/.test(u)) throw new Error('נקרא ראוט שגוי: ' + u);
    if (!/40468/.test(html)) throw new Error('החשבונית לא מוצגת');
    if (!/previewLinkedDoc\('d1'/.test(html)) throw new Error('אין כפתור צפייה למסמך');
    if (!/זיכוי/.test(html)) throw new Error('מצב הזיכוי לא מסומן');
    if (!/לקוח א/.test(html)) throw new Error('שם הלקוח חסר');
    // מסמך שהועלה ידנית נפתח מהקבצים ולא מחשבונית ירוקה
    return build({ ok: true, eventId: 'ev1', clientName: 'ל', amount: 0,
      docs: [{ id: 'f1', number: 5, type: 305, uploaded: true }] }).then(([h2]) => {
      if (!/api\/files\/f1/.test(h2)) throw new Error('מסמך שהועלה לא נפתח מהקבצים');
      // ואירוע בלי מסמכים מסביר מה לעשות
      return build({ ok: true, eventId: 'ev1', clientName: 'ל', amount: 0, docs: [] }).then(([h3]) => {
        if (!/שייך מסמכים/.test(h3)) throw new Error('אין הכוונה כשאין מסמכים');
        return true;
      });
    });
  });
});

check('"תצוגת חיוב" מופיע בכל מסך שמציג את חיווי תשלום הלקוח', () => {
  // הכפתור נוסף תחילה לכרטיס הקבלנים בלבד, ולכן נעדר ממסך "ספקים לתשלום".
  // עכשיו הוא נבנה בתוך החיווי עצמו — מקום אחד שמשרת את כל המסכים.
  const src = app.slice(app.indexOf('function clientPaidBadge('), app.indexOf('window.filterReadyToPay'));
  const fn = new Function('payDateFmt', `${src}\nreturn clientPaidBadge;`)(() => '');
  for (const st of ['paid', 'charged', 'pending', 'uninvoiced']) {
    const html = fn({ status: st }, 'ev1');
    if (!/openBillingView\('ev1'\)/.test(html)) throw new Error(`מצב ${st}: אין כפתור תצוגת חיוב`);
  }
  // בלי מזהה אירוע אין כפתור, ובאירוע ללא חיוב גם לא
  if (/openBillingView/.test(fn({ status: 'pending' }))) throw new Error('כפתור נוצר בלי מזהה אירוע');
  if (/openBillingView/.test(fn({ status: 'noinvoice' }, 'ev1'))) throw new Error('כפתור נוצר לאירוע ללא חיוב');
  // ושני המסכים באמת מעבירים מזהה
  const calls = [...app.matchAll(/clientPaidBadge\(([^)]*)\)/g)].map(m => m[1]).filter(x => !/^cp, eventId$/.test(x));
  const bad = calls.filter(c => c.split(',').length < 2);
  if (bad.length) throw new Error('קריאה בלי מזהה אירוע: ' + bad.join(' | '));
  return true;
});

check('נושא המייל של מסמך שהועלה ידנית נושא סוג ומספר', () => {
  // אצל אופק רוב המסמכים מועלים ידנית. מסלול השליחה שלהם העביר ערכים ריקים
  // קבועים, ולכן הנושא יצא "מסמך" בלי סוג המסמך ובלי מספרו.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('function uploadedDocMeta'), srv.indexOf('function mailSubjectFor'));
  const fn = new Function('ownedBy', 'DOC_NAMES_HE', `${src}\nreturn uploadedDocMeta;`)(
    (r, c) => !r.companyId || r.companyId === c,
    { 10: 'הצעת מחיר', 300: 'חשבון עסקה', 305: 'חשבונית מס', 320: 'חשבונית מס-קבלה', 330: 'חשבונית זיכוי', 400: 'קבלה' });
  const db = {
    events: [{ id: 'e1', companyId: 'co_ofek', clientName: 'לקוח א',
      linkedDocs: [{ id: 'up1', number: 512, type: 305, uploaded: true }] },
      { id: 'e2', companyId: 'co_bpm', clientName: 'לא רלוונטי',
      linkedDocs: [{ id: 'up9', number: 999, type: 305, uploaded: true }] }],
    oldInvoices: [{ id: 'o1', companyId: 'co_ofek', clientName: 'לקוח ב',
      linkedDocs: [{ id: 'up2', number: 77, type: 300, uploaded: true }] }],
  };
  const a = fn(db, 'co_ofek', 'up1');
  if (a.docType !== 'חשבונית מס' || a.number !== '512' || a.clientName !== 'לקוח א') throw new Error(JSON.stringify(a));
  const b = fn(db, 'co_ofek', 'up2');
  if (b.docType !== 'חשבון עסקה' || b.number !== '77') throw new Error('חשבונית ישנה: ' + JSON.stringify(b));
  // בידוד חברות — מסמך של חברה אחרת אינו נקרא
  const c = fn(db, 'co_ofek', 'up9');
  if (c.docType !== 'מסמך' || c.number !== '') throw new Error('זליגה בין חברות: ' + JSON.stringify(c));
  // מסמך שלא נמצא — נפילה חיננית ולא קריסה
  const d = fn(db, 'co_ofek', 'לא-קיים');
  if (d.docType !== 'מסמך') throw new Error('מסמך לא מוכר החזיר ' + d.docType);
  // ומסלול השליחה באמת משתמש בזה
  const bStart = srv.indexOf('// מסמך שהועלה ידנית (אינו בחשבונית ירוקה)');
  if (bStart < 0) throw new Error('מסלול המסמך שהועלה לא נמצא');
  const branch = srv.slice(bStart, bStart + 1800);
  if (!/uploadedDocMeta\(_db, _ucid, params\[0\]\)/.test(branch)) throw new Error('מסלול השליחה לא קורא את פרטי המסמך');
  if (/docType: 'מסמך' \}\)/.test(branch)) throw new Error('נשארו ערכים ריקים קבועים בנושא');
  return true;
});

check('הפקת קבלה בבנק — על הסכום שנותר אחרי הזיכויים', () => {
  // חשבונית 61,360 עם זיכויים 590 ו-9,440 — הקבלה חייבת להיות על 51,330.
  // הכפתור העביר את הסכום המקורי, ולכן הקבלה נפתחה על סכום שכבר לא קיים.
  const src = app.slice(app.indexOf('recNo = stack(units.map('), app.indexOf('invAmt = stack(units.map('));
  if (/incProduce\('\$\{i\.id\}',305,'\$\{t\.id\}',\$\{Number\(i\.amount\)/.test(src))
    throw new Error('הקבלה עדיין מבוססת על סכום החשבונית לפני הזיכוי');
  if (!/incProduce\('\$\{i\.id\}',305,'\$\{t\.id\}',\$\{Number\(u\.net\)/.test(src))
    throw new Error('הקבלה אינה מבוססת על הסכום נטו');

  // u.net באמת מחושב כסכום פחות הזיכויים
  const build = app.slice(app.indexOf('  const isExp = (x) => x.kind'), app.indexOf('for (const o of others)'));
  const fn = new Function('list', 'sameClient', `${build}\nreturn units;`);
  const units = fn([
    { id: 'i1', number: 50425, type: 305, amount: 61360, clientName: 'גאגא' },
    { id: 'c1', number: 70098, type: 330, amount: 590, clientName: 'גאגא' },
    { id: 'c2', number: 70099, type: 330, amount: 9440, clientName: 'גאגא' },
  ], (a, b) => a === b);
  const u = units.find(x => x.inv.id === 'i1');
  if (!u) throw new Error('היחידה לא נבנתה');
  if (u.credits.length !== 2) throw new Error('הזיכויים לא צורפו: ' + u.credits.length);
  if (u.net !== 51330) throw new Error('נטו שגוי: ' + u.net);
  // בלי זיכויים — הנטו הוא הסכום המלא
  const plain = fn([{ id: 'i2', number: 1, type: 305, amount: 1000, clientName: 'ל' }], (a, b) => a === b);
  if (plain[0].net !== 1000) throw new Error('נטו בלי זיכוי: ' + plain[0].net);
  return true;
});

check('קבלה מהבנק — שורות הזיכוי מקטינות את סכום המסמך', () => {
  // הכפתור העביר את הנטו, אבל העורך בנה את המסמך משורות החשבונית המלאה,
  // ולכן הקבלה יצאה על 61,360 במקום 51,330.
  const src = app.slice(app.indexOf('  // זיכויים שיצאו על מסמך המקור'), app.indexOf('  const date = opts.date || todayIso();'));
  const run = (items, credits, srcAmount) => new Function('items', 'opts', 'r', 'VAT_RATE', `${src}\nreturn items;`)(
    items, { credits }, { srcAmount }, 0.18);

  // המקרה האמיתי: 52,000 ללא מע"מ (61,360 כולל), זיכויים 590 ו-9,440 כולל מע"מ
  const items = [{ description: 'הגברה', quantity: 1, price: 52000 }];
  const out = run(items, [{ number: 70098, amount: 590 }, { number: 70099, amount: 9440 }], 61360);
  const exTotal = out.reduce((a, it) => a + it.price * it.quantity, 0);
  const incTotal = Math.round(exTotal * 1.18 * 100) / 100;
  if (Math.abs(incTotal - 51330) > 1) throw new Error('סה"כ כולל מע"מ: ' + incTotal + ' במקום 51330');
  if (out.length !== 3) throw new Error('מספר שורות: ' + out.length);
  if (!/70098/.test(out[1].description)) throw new Error('שורת הזיכוי לא מזוהה: ' + out[1].description);
  if (out[1].price >= 0) throw new Error('שורת הזיכוי אינה שלילית');

  // בלי זיכויים — השורות לא נגעו
  const plain = run([{ description: 'x', quantity: 1, price: 100 }], [], 118);
  if (plain.length !== 1) throw new Error('שורות נוספו בלי זיכוי');

  // בלי סכום מקור — נפילה לשיעור המע"מ המוגדר, ולא קריסה
  const noSrc = run([{ description: 'x', quantity: 1, price: 1000 }], [{ number: 1, amount: 118 }], null);
  if (Math.abs(noSrc[1].price + 100) > 0.5) throw new Error('המרה בלי סכום מקור: ' + noSrc[1].price);

  // והכפתור באמת מעביר את הזיכויים
  const btnLine = app.split('\n').find(l => l.includes('incProduce(') && l.includes("',305,'"));
  if (!btnLine) throw new Error('כפתור הפקת הקבלה לא נמצא');
  if (!/\(u\.credits \|\| \[\]\)\.map/.test(btnLine)) throw new Error('הכפתור אינו מעביר את הזיכויים');
  const ip = app.slice(app.indexOf('window.incProduce ='), app.indexOf('window.issuePaidReceipt'));
  if (!/credits,/.test(ip)) throw new Error('incProduce אינו מעביר את הזיכויים לעורך');
  return true;
});

check('שיוך אירועים לספק — אירוע שכבר שויך לחשבונית אחרת יורד מהאפשרויות', () => {
  // בלי זה אותה עבודה נקשרת לשתי חשבוניות של אותו ספק.
  const src = app.slice(app.indexOf('function renderLinkEvRows()'), app.indexOf('window.toggleLinkShowLinked'));
  const stubs = `
    const money=(n)=>String(n), escapeHtml=(x)=>String(x==null?'':x), ddmy=(d)=>String(d||'');
    const MONTHS_HE = [];
    const _linkNorm = (x)=>String(x||'').trim();
    let __h = '';
    const document = { getElementById: () => ({ set innerHTML(v){ __h = v; }, get innerHTML(){ return __h; } }) };
  `;
  const run = (showLinked) => {
    const _linkPay = { pid: 'p1', name: 'ספק', q: '', year: 'all', month: 'all', sel: new Set(), showLinked,
      events: [
        { eventId: 'e1', index: 0, date: '2026-07-02', artist: 'פנוי', contractor: 'ספק', amount: 1000, linkedPayableId: null },
        { eventId: 'e2', index: 0, date: '2026-07-09', artist: 'משויך לאחרת', contractor: 'ספק', amount: 2000, linkedPayableId: 'p2' },
        { eventId: 'e3', index: 0, date: '2026-07-10', artist: 'משויך לזו', contractor: 'ספק', amount: 3000, linkedPayableId: 'p1' },
      ] };
    return new Function('_linkPay', `${stubs}\n${src}\nrenderLinkEvRows();\nreturn __h;`)(_linkPay);
  };

  const hidden = run(false);
  if (!/פנוי/.test(hidden)) throw new Error('אירוע פנוי לא מוצג');
  if (/משויך לאחרת/.test(hidden)) throw new Error('אירוע שכבר שויך לחשבונית אחרת עדיין מוצע');
  if (/משויך לזו/.test(hidden)) throw new Error('אירוע של ההוצאה הנוכחית מוצע שוב');
  if (!/הוסתרו/.test(hidden)) throw new Error('אין חיווי כמה אירועים הוסתרו');
  if (!/הצג בכל זאת/.test(hidden)) throw new Error('אין דרך להציג בכל זאת — מבוי סתום');

  const shown = run(true);
  if (!/משויך לאחרת/.test(shown)) throw new Error('הצגה מפורשת לא החזירה את האירוע');
  if (!/>משויך</.test(shown)) throw new Error('האירוע המשויך אינו מסומן כשהוא מוצג');
  if (/משויך לזו/.test(shown)) throw new Error('אירוע של ההוצאה הנוכחית חזר להצעות');
  return true;
});

check('תנאי תשלום — ניסוח חלופי מחליף את ההערה הקבועה ולא מתווסף אליה', () => {
  // ההערה הקבועה של העסק נדחפת לכל מסמך. כשנבחר ניסוח אחר, שני הניסוחים היו
  // מופיעים יחד וסותרים זה את זה.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('const PAY_TERMS_TEXT'), srv.indexOf('function followupRemarks'));
  const fn = new Function(`${src}\nreturn applyPaymentTerms;`)();

  const def = fn({ remarks: 'הערה שלי' }, { paymentTerms: { mode: 'default' } });
  if (def.noDefaultRemark) throw new Error('ברירת המחדל השתיקה את ההערה הקבועה');
  if (def.remarks !== 'הערה שלי') throw new Error('ברירת המחדל שינתה את ההערה');

  const day = fn({ remarks: 'הערה שלי' }, { paymentTerms: { mode: 'eventday' } });
  if (!day.noDefaultRemark) throw new Error('ניסוח ליום האירוע לא השתיק את הקבועה');
  if (!/ביום האירוע/.test(day.remarks)) throw new Error('הניסוח לא נוסף: ' + day.remarks);
  if (!/הערה שלי/.test(day.remarks)) throw new Error('ההערה של המשתמש נמחקה');

  const cus = fn({}, { paymentTerms: { mode: 'custom', text: '  מזומן מראש  ' } });
  if (cus.remarks !== 'מזומן מראש' || !cus.noDefaultRemark) throw new Error('טקסט חופשי: ' + JSON.stringify(cus));

  // "אחר" בלי טקסט — לא משתיקים את הקבועה בלי תחליף, אחרת המסמך יוצא בלי תנאים
  const empty = fn({ remarks: 'x' }, { paymentTerms: { mode: 'custom', text: '   ' } });
  if (empty.noDefaultRemark) throw new Error('הקבועה הושתקה בלי תחליף');
  if (fn({}, {}).noDefaultRemark) throw new Error('בקשה בלי תנאים השתיקה את הקבועה');

  // הדגל באמת מונע את ההוספה בבניית המסמך
  const gi = fs.readFileSync('greenInvoice.js', 'utf8');
  if (!/const defRemark = noDefaultRemark \? '' :/.test(gi)) throw new Error('הדגל אינו משפיע על בניית המסמך');
  if (!/function documentBody\(\{ noDefaultRemark,/.test(gi)) throw new Error('הדגל אינו מתקבל ב-documentBody');

  // ושלושת ראוטי ההפקה מחילים אותו
  const applied = (srv.match(/applyPaymentTerms\(opts, body\)/g) || []).length;
  if (applied < 3) throw new Error('רק ' + applied + ' ראוטים מחילים תנאי תשלום');
  return true;
});

check('בורר תנאי התשלום נבנה ומופיע רק בהצעת מחיר וחשבון עסקה', () => {
  const src = app.slice(app.indexOf('const PAY_TERMS_DOCS'), app.indexOf('function renderNewQuote('));
  const build = new Function(`const escapeHtml=(x)=>String(x==null?'':x);\n${src}\nreturn { payTermsBlock, PAY_TERMS_DOCS };`)();
  const def = build.payTermsBlock({ mode: 'default', text: '' }, 'nq');
  if (!/תשלום ביום האירוע/.test(def)) throw new Error('חסרה אפשרות ליום האירוע');
  if (!/הניסוח הקבוע מפרטי העסק יופיע/.test(def)) throw new Error('אין חיווי שהקבועה תופיע');
  if (!/nqSetPayTerms\('custom'\)/.test(def)) throw new Error('חסרה אפשרות "אחר"');
  if (!/display:none/.test(def)) throw new Error('שדה הטקסט החופשי פתוח בברירת מחדל');
  const cus = build.payTermsBlock({ mode: 'custom', text: 'מזומן' }, 'der');
  if (/display:none/.test(cus)) throw new Error('שדה הטקסט סגור במצב "אחר"');
  if (!/מזומן/.test(cus)) throw new Error('הטקסט שהוזן לא נשמר');
  if (!/derSetPayTermsText/.test(cus)) throw new Error('הקידומת לא הוחלה');
  if (!/לא יופיע במסמך הזה/.test(cus)) throw new Error('אין חיווי שהקבועה מושתקת');
  // רק הצעת מחיר וחשבון עסקה
  for (const t of [10, 300]) if (!build.PAY_TERMS_DOCS.has(t)) throw new Error('סוג ' + t + ' חסר');
  for (const t of [305, 320, 400, 330]) if (build.PAY_TERMS_DOCS.has(t)) throw new Error('סוג ' + t + ' נכלל בטעות');
  // וההגדרות באמת נשלחות לשרת משלושת המסלולים
  const sends = (app.match(/paymentTerms: e\.payTerms \|\| null/g) || []).length;
  if (sends < 3) throw new Error('רק ' + sends + ' מסלולים שולחים תנאי תשלום');
  // חלק ממסלולי החלונית יוצרים _nq בלי type (שכפול הצעה, יצירה רגילה). היעדר
  // סוג בחלונית הזו פירושו הצעת מחיר, ולכן הבורר חייב להופיע גם שם.
  const cond = app.split('\n').find(l => l.includes("payTermsBlock(e.payTerms, 'nq')"));
  if (!/Number\(e\.type \|\| 10\)/.test(cond || '')) throw new Error('הבורר נעלם כשאין סוג מפורש בחלונית');
  const inits = app.split('\n').filter(l => l.includes('_nq = {'));
  const noType = inits.filter(l => !/type:/.test(l)).length;
  if (noType && !/Number\(e\.type \|\| 10\)/.test(cond || '')) throw new Error('יש אתחול בלי סוג והתנאי אינו מכסה אותו');
  return true;
});

const boardMod = await import('./eventBoard.js');
check('לוח האירועים — התפקידים זהים בשרת ובממשק', () => {
  const ui = app.match(/const BOARD_ROLES = \[([\s\S]*?)\];/);
  if (!ui) throw new Error('רשימת התפקידים לא נמצאה בממשק');
  const uiRoles = [...ui[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const srvRoles = boardMod.BOARD_ROLES;
  if (uiRoles.join('|') !== srvRoles.join('|')) throw new Error(`שרת: ${srvRoles.join(',')} · ממשק: ${uiRoles.join(',')}`);
  if (srvRoles.length !== 14) throw new Error('מספר תפקידים: ' + srvRoles.length);
  return true;
});
check('לוח האירועים — עוסק פטור אינו מנופח במע״מ', () => {
  const reg = boardMod.rowTotals({ priceExVat: 1000 });
  if (reg.inc !== 1180 || reg.vat !== 180) throw new Error('ספק רגיל: ' + JSON.stringify(reg));
  const ex = boardMod.rowTotals({ priceExVat: 1000, vatExempt: true });
  if (ex.inc !== 1000 || ex.vat !== 0) throw new Error('עוסק פטור: ' + JSON.stringify(ex));
  if (boardMod.rowTotals({}).inc !== 0) throw new Error('שורה ריקה יצרה סכום');
  return true;
});
check('לוח האירועים — סיכומי אירוע וחודש', () => {
  const ev = { id: 'e1', date: '2026-10-08', artist: 'בת מצווה', price: 20000, contractorDetails: [
    { role: 'קלידן', name: 'דני', priceExVat: 1500 },
    { role: 'מתופף', name: 'רון', priceExVat: 1200, vatExempt: true },
    { role: 'הסעה', name: '', priceExVat: null },
    { role: 'צילום', name: 'סטודיו', priceExVat: 800 },
  ] };
  const t = boardMod.eventTotals(ev);
  if (t.expenseEx !== 3500) throw new Error('הוצאה ללא מע״מ: ' + t.expenseEx);
  if (t.expenseInc !== 3914) throw new Error('הוצאה כולל מע״מ: ' + t.expenseInc);  // 1500*1.18 + 1200 + 800*1.18
  // ההכנסה היא מה שנשאר אחרי עמלת 15%: 20000 − 3000 = 17000, ומזה ההוצאות
  if (t.clientPriceEx !== 20000) throw new Error('מחיר ללקוח: ' + t.clientPriceEx);
  if (t.commissionPct !== 15 || t.commissionEx !== 3000) throw new Error('עמלה: ' + JSON.stringify([t.commissionPct, t.commissionEx]));
  if (t.incomeEx !== 17000) throw new Error('תשלום למשה: ' + t.incomeEx);
  if (t.profitEx !== 13500) throw new Error('רווח: ' + t.profitEx);
  if (t.filledRows !== 3) throw new Error('שורות מלאות: ' + t.filledRows);
  const rows = boardMod.boardRows(ev);
  if (rows.fixed.length !== 14) throw new Error('תפקידים קבועים: ' + rows.fixed.length);
  if (rows.extras.length !== 1 || rows.extras[0].role !== 'צילום') throw new Error('שורה חופשית לא זוהתה');
  const b = boardMod.boardByMonth([ev], '2026');
  if (b.months.length !== 1 || b.months[0].month !== '2026-10') throw new Error('קיבוץ לחודשים נכשל');
  if (b.totals.profitEx !== 13500) throw new Error('סיכום שנתי: ' + JSON.stringify(b.totals));
  if (b.totals.commissionEx !== 3000) throw new Error('העמלה לא נצברת לחודש: ' + b.totals.commissionEx);
  if (boardMod.boardByMonth([ev], '2025').months.length) throw new Error('סינון שנה לא עבד');
  return true;
});
check('לוח האירועים — עריכה אינה מוחקת מעקב תשלום קיים', () => {
  // השורות נשמרות ב-contractorDetails, ולכן עריכה חייבת לשמר את שדות המעקב
  // (שולם, שיוך לחשבונית) — אחרת כל עריכה מאפסת את מעקב התשלומים לספק.
  const prev = [{ role: 'קלידן', name: 'דני', priceExVat: 1500, amount: 1770, paid: true, paidPayableId: 'pay1', paidSource: 'manual' }];
  const out = boardMod.normalizeRows([{ role: 'קלידן', name: 'דני', priceExVat: 1600 }], prev);
  if (out.length !== 1) throw new Error('שורות: ' + out.length);
  if (!out[0].paid || out[0].paidPayableId !== 'pay1') throw new Error('מעקב התשלום נמחק');
  if (out[0].amount !== 1888) throw new Error('הסכום לא עודכן: ' + out[0].amount);
  // שורה ריקה לגמרי אינה נשמרת
  if (boardMod.normalizeRows([{ role: 'בסיסט', name: '', priceExVat: null, note: '' }]).length) throw new Error('שורה ריקה נשמרה');
  // שורה עם הערה בלבד כן נשמרת
  if (!boardMod.normalizeRows([{ role: 'בסיסט', name: '', priceExVat: null, note: 'בהמתנה' }]).length) throw new Error('הערה בלבד לא נשמרה');
  return true;
});
// בנק לאומי מייצא HTML עם סיומת xls, כמו מזרחי, אבל במבנה עמודות אחר: שתי
// עמודות מקדימות (סניף, חשבון), תאריך ב-2, חובה/זכות ב-5/6. הפרסר של מזרחי
// החזיר עליו רשימה ריקה — הקובץ פשוט "לא נקלט".
check('בנק לאומי — פרסור תנועות, כיוונים ויתרה', async () => {
  const bank = await import('./bankParser.js');
  const row = (c) => '<tr>' + c.map(x => `<td>${x}</td>`).join('') + '</tr>';
  const html = `<html><body><table>
    ${row(['בנק לאומי | תאריך שמירה/הדפסה: 22/9/2026'])}
    ${row(['תנועות עו"ש שקלים  נכון לתאריך: 22.09.2026'])}
    ${row(['יתרה: 20,980.42 ₪'])}
    ${row(['680', '47458/32', '15/09/2026', 'מקס איט פיננ-י', '34685', '1,624.29', '', '20,980.42', '', ''])}
    ${row(['680', '47458/32', '14/09/2026', 'העברה דיגיטל', '13148', '2,832', '', '22,604.71', 'העברה אל: גניפר חלמי 11-526-164133153 תשלום', ''])}
    ${row(['680', '47458/32', '09/09/2026', 'זיכוי', '77001', '', '20,844', '43,448.71', 'העברה מאת: גניש אלי,גניש צי 11-090-121012370 אירוע', ''])}
    ${row(['680', '47458/32', '08/09/2026', 'שורה בלי סכום', '1', '', '', '43,448.71', '', ''])}
  </table></body></html>`;

  const t = bank.parseBank(html);
  if (t.length !== 3) throw new Error('מספר תנועות שגוי: ' + t.length);
  // כיוונים: חובה שלילי, זכות חיובי — אחרת כל ההתאמות וסיכומי ההכנסה יתהפכו
  const debit = t.find(x => x.reference === '34685');
  if (debit.amount !== -1624.29 || debit.direction !== 'debit') throw new Error('חובה לא נקראה כיוצאת');
  if (debit.balance !== 20980.42) throw new Error('יתרת השורה שגויה');
  if (debit.date !== '15/09/2026') throw new Error('תאריך שגוי: ' + debit.date);
  const credit = t.find(x => x.reference === '77001');
  if (credit.amount !== 20844 || credit.direction !== 'credit') throw new Error('זכות לא נקראה כנכנסת');
  // שם הצד השני מעמודת הפרטים — בלעדיו אין התאמה ללקוח/ספק
  if (credit.nameHint !== 'גניש אלי,גניש צי') throw new Error('שם המעביר לא חולץ: ' + credit.nameHint);
  const out = t.find(x => x.reference === '13148');
  if (out.nameHint !== 'גניפר חלמי') throw new Error('שם המוטב לא חולץ: ' + out.nameHint);
  // שורה בלי סכום אינה הופכת לתנועה על אפס
  if (t.some(x => !(x.absAmount > 0))) throw new Error('נוצרה תנועה בלי סכום');

  const bal = bank.extractAccountBalance(html);
  if (!bal || bal.balance !== 20980.42) throw new Error('יתרת החשבון לא זוהתה');
  if (bal.date !== '22/09/2026') throw new Error('תאריך היתרה שגוי: ' + bal.date);

  // המבנה של מזרחי ממשיך לעבוד — התאריך אצלו בעמודה 0
  const miz = bank.parseBank(`<table>${row(['05/01/2026', '1234', 'העברה', '5,000', '', '10,000', '999'])}</table>`);
  if (miz.length !== 1 || miz[0].direction !== 'credit' || miz[0].amount !== 5000)
    throw new Error('פורמט מזרחי נשבר: ' + JSON.stringify(miz[0] || null));
  return true;
});

// לוח האירועים מוצג לחברות שמוגדרות ככאלה (משה, טל) ומוסתר לשאר. הרשימה היא
// מקור אמת אחד — פיזור של מזהי חברה בקוד הוא מה שהופך הוספת חברה לסיכון.
check('לוח האירועים — לחברות הלוח בלבד, מרשימה אחת', () => {
  const list = app.match(/const BOARD_COMPANIES = \[([^\]]*)\]/);
  if (!list) throw new Error('BOARD_COMPANIES לא נמצאה');
  const ids = list[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const id of ['co_moshe', 'co_tal']) if (!ids.includes(id)) throw new Error('חסרה חברת לוח: ' + id);

  const fn = app.slice(app.indexOf('function companyTabsFor'), app.indexOf('const currentCompanyName'));
  if (!/k === 'eventsboard'.*isBoard/s.test(fn)) throw new Error('הלשונית אינה נגזרת מרשימת חברות הלוח');
  if (!/\['events', 'payroll'\].*!isBoard/s.test(fn)) throw new Error('אירועים/עובדים אינם מוסתרים בחברות הלוח');
  const apply = app.slice(app.indexOf('function applyCompanyTabs'), app.indexOf('// ---- ניהול משתמשים'));
  if (!/data-tab="eventsboard".*isBoard/s.test(apply)) throw new Error('הלשונית אינה מוסתרת לשאר החברות');
  if (!/state\.tab === 'eventsboard'/.test(apply)) throw new Error('מעבר חברה משאיר את המשתמש בלשונית שאינה שלו');
  // מזהי החברות מופיעים רק בהגדרת הרשימות עצמן, לא פזורים בקוד
  const lists = (app.match(/const (?:BOARD_COMPANIES|GROUP_SPLIT_COMPANIES|LEGACY_IMPORT_COMPANIES|NO_FLEET_COMPANIES) = \[[^\]]*\]/g) || []).join('\n');
  const inLists = (lists.match(/co_moshe|co_tal/g) || []).length;
  const total = (app.match(/co_moshe|co_tal/g) || []).length;
  if (total > inLists) throw new Error(`מזהה חברה מקובע מחוץ לרשימות: ${total - inLists}`);

  // "רכבי חברה" — מוסתרת בעסקים שהרכבים בהם פרטיים
  const fleet = app.match(/const NO_FLEET_COMPANIES = \[([^\]]*)\]/);
  if (!fleet) throw new Error('NO_FLEET_COMPANIES לא נמצאה');
  for (const id of ['co_tal', 'co_moshe']) if (!fleet[1].includes(id)) throw new Error('חסרה חברה בלי צי רכב: ' + id);
  if (!/k === 'vehicles' && NO_FLEET_COMPANIES\.includes\(cid\)/.test(app)) throw new Error('הלשונית אינה מוסרת מהרשאות המשתמש');
  if (!/data-tab="vehicles".*noFleet/s.test(app)) throw new Error('הלשונית אינה מוסתרת במסך');
  if (!/noFleet && state\.tab === 'vehicles'/.test(app)) throw new Error('מעבר חברה משאיר בלשונית שאינה קיימת');

  // פיצול מוזיקה/דיגיטל — משה בלבד; אצל טל אין חלוקה כזו
  const split = app.match(/const GROUP_SPLIT_COMPANIES = \[([^\]]*)\]/);
  if (!split) throw new Error('GROUP_SPLIT_COMPANIES לא נמצאה');
  if (/co_tal/.test(split[1])) throw new Error('טל נכללה בפיצול מוזיקה/דיגיטל');
  if (!/GROUP_SPLIT_COMPANIES\.includes\(state\.company\)/.test(app)) throw new Error('דף הבית אינו נגזר מהרשימה');

  // בשרת: החברה קיימת, מקבלת מפתחות GI משלה, וקבוצות הכנסה/הוצאה רגילות
  const srv = fs.readFileSync('server.js', 'utf8');
  if (!/id: 'co_tal'/.test(srv)) throw new Error('החברה אינה ב-COMPANY_SEED');
  if (!/ensureCompaniesSeeded\(db\)/.test(srv)) throw new Error('אין מיגרציה שמוסיפה חברה למסד קיים');
  if (!/INCEXP_GROUP_COMPANIES = \['co_bpm', 'co_ofek', 'co_tal'\]/.test(srv))
    throw new Error('טל אינה מקבלת קבוצות הכנסה/הוצאה רגילות');
  const groups = srv.slice(srv.indexOf('function ensureGroupsSeeded'), srv.indexOf('function ensureRulesSeeded'));
  if (/co_tal/.test(groups.slice(0, groups.indexOf('INCEXP_GROUP_COMPANIES') + 1)) && /MOSHE_DEFAULT_GROUPS/.test(groups.split('co_tal')[0] || ''))
    throw new Error('טל קיבלה את קבוצות הפיצול של משה');
  const gi = fs.readFileSync('greenInvoice.js', 'utf8');
  if (!/co_tal:\s*\['GREENINVOICE_TAL_API_KEY_ID'/.test(gi)) throw new Error('אין מיפוי מפתחות לחברה החדשה');

  // ייבוא מסמכים ממערכת קודמת — אופק (פייפרלס) וטל (הכוורת). גם כאן רשימה אחת
  // ולא בדיקת מזהה מפוזרת, אחרת כפתור אחד נפתח והשני נשכח.
  const imp = app.match(/const LEGACY_IMPORT_COMPANIES = \[([^\]]*)\]/);
  if (!imp) throw new Error('LEGACY_IMPORT_COMPANIES לא נמצאה');
  for (const id of ['co_ofek', 'co_tal']) if (!imp[1].includes(id)) throw new Error('חסרה חברת ייבוא: ' + id);
  for (const fn of ['openOldInvoice', 'openBulkOldInvoices']) {
    if (!app.includes(`window.${fn} =`)) throw new Error('חסרה פונקציית ייבוא: ' + fn);
  }
  // שלושת הכפתורים נגזרים מהרשימה ולא ממזהה מקובע
  if (/state\.company === 'co_ofek' \? `<button class="btn primary"[^`]*openOldInvoice/.test(app))
    throw new Error('כפתור ההעלאה עדיין נעול לאופק');
  if (/state\.company === 'co_ofek' \? `<button type="button"[^`]*openAttachDoc/.test(app))
    throw new Error('כפתור המסמך הישן באירוע עדיין נעול לאופק');
  if ((app.match(/LEGACY_IMPORT_COMPANIES\.includes\(state\.company\)/g) || []).length < 3)
    throw new Error('לא כל נקודות הייבוא נגזרות מהרשימה');
  // השרת אינו חוסם חברה מסוימת בקליטת מסמך ישן
  const oi = srv.slice(srv.indexOf("add('POST', /^\\/api\\/old-invoices$/"), srv.indexOf("// ---- ייבוא רשימת מסמכים ממערכת קודמת"));
  if (/co_ofek/.test(oi)) throw new Error('ראוט המסמכים הישנים נעול לאופק');
  return true;
});

// מסמך שיובא ממערכת קודמת היה בלתי נגיש לשיוך בבנק: הבורר דורש לבחור לקוח
// מחשבונית ירוקה, והלקוחות של מסמכים מיובאים אינם קיימים שם.
check('שיוך בבנק — מסמכים שהועלו נגישים בלי לקוח מחשבונית ירוקה', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('GET', /^\\/api\\/local-documents$/"), srv.indexOf("// GET /api/clients —"));
  if (!route) throw new Error('ראוט המסמכים המקומיים לא נמצא');
  if (!/reqCompany\(q\)/.test(route)) throw new Error('הראוט אינו נגזר מ-reqCompany');
  if ((route.match(/ownedBy\(/g) || []).length < 2) throw new Error('אין בידוד חברה על אירועים ועל חשבוניות ישנות');
  if (!/db\.oldInvoices/.test(route) || !/db\.events/.test(route)) throw new Error('לא נאספים שני המקורות');
  if (!/d\.noFile \? null/.test(route)) throw new Error('נבנית כתובת קובץ למסמך בלי קובץ');

  // הדלף שתוקן אגב: הבורר לפי לקוח הציע מסמכים של חברות אחרות
  const byClient = srv.slice(srv.indexOf("add('GET', /^\\/api\\/clients\\/([^/]+)\\/documents$/"), srv.indexOf("add('GET', /^\\/api\\/local-documents$/") + 1 || srv.length);
  const loops = srv.slice(srv.indexOf('const push = (d, clientName) => {'), srv.indexOf('const push = (d, clientName) => {') + 1200);
  if (!/ownedBy\(e, _cid\)/.test(loops) || !/ownedBy\(rec, _cid\)/.test(loops))
    throw new Error('בורר המסמכים לפי לקוח אינו מסנן לפי חברה');

  // הפרונט: מצב שלישי בבורר, שנטען ישירות ולא דרך בחירת לקוח
  if (!/seg\('local', '📥 מסמכים שהועלו'\)/.test(app)) throw new Error('אין כפתור למסמכים שהועלו');
  if (!/if \(mode === 'local'\) \{ await loadLocalLinkDocs\(\); return; \}/.test(app))
    throw new Error('המצב אינו נטען ישירות');
  const fn = app.slice(app.indexOf('window.loadLocalLinkDocs'), app.indexOf('// מסמכים שכבר משויכים'));
  if (!/\/api\/local-documents\$\{q \? `\?q=/.test(fn)) throw new Error('החיפוש נשלח בפרמטר שגוי');
  if (!/אין מסמכים שהועלו/.test(fn)) throw new Error('אין הודעה כשאין מסמכים');
  if (!/_linkMode === 'local'/.test(app.slice(app.indexOf('window.onLinkSearch'), app.indexOf('window.onLinkSearch') + 500)))
    throw new Error('החיפוש אינו מרענן את רשימת המסמכים במצב הזה');
  return true;
});

// כסף שהגיע ממט"ח לעולם לא יהיה זהה לסכום שבחשבונית, ולכן לא הוצע כהתאמה כלל.
// ההשוואה היא בין השער המשתמע מהחשבונית לשער שהבנק כתב — מדויק ומוסבר.
check('התאמת בנק — מט״ח: השוואת שערים, ורק לחברות שמקבלות מחו״ל', async () => {
  const P = await import('./bankParser.js');
  const M = await import('./bankMatch.js');

  // פרטי ההמרה נקראים מהשורה של לאומי
  const fx = P.parseFxMemo('המרה מ: 1980.00  דולר,שע"ח:3.1275  בניכוי עמלה בסך 18.32 ש"ח');
  if (!fx) throw new Error('פרטי ההמרה לא נקראו');
  if (fx.amount !== 1980 || fx.rate !== 3.1275 || fx.fee !== 18.32) throw new Error('פרטי ההמרה שגויים: ' + JSON.stringify(fx));
  if (Math.abs(fx.gross - 6192.45) > 0.01) throw new Error('הסכום לפני עמלה שגוי: ' + fx.gross);
  if (P.parseFxMemo('העברה מאת: גניש אלי 11-090-121012370') !== null) throw new Error('שורה רגילה זוהתה כהמרה');

  const tx = { date: '05/01/2026', direction: 'credit', absAmount: 6174.13, nameHint: null, memo: '', fx };
  const inv = (amt) => [{ id: 'd', number: '1210', type: 320, clientName: 'FIVE STAR', amountIncVat: amt, date: '2026-01-05' }];
  const sug = (amt, opts) => (M.matchCredits([tx], inv(amt), 0.05, opts)[0].suggestions || []);

  // בלי מט"ח אין הצעה בכלל — זה המצב שהיה
  if (sug(6301, { fx: false }).length) throw new Error('הצעה ניתנה בלי הפעלת מט״ח');
  // עם מט"ח — הצעה עם הסבר שכולל את שני השערים
  const s = sug(6301, { fx: true });
  if (s.length !== 1) throw new Error('לא הוצעה התאמת מט״ח');
  const why = (s[0].reasons || []).join(' ');
  if (!/3\.1823/.test(why) || !/3\.1275/.test(why)) throw new Error('ההסבר אינו כולל את שני השערים: ' + why);
  if (!/1980 דולר/.test(why)) throw new Error('ההסבר אינו כולל את הסכום במט״ח');

  // חשבונית בשער רחוק מדי אינה מוצעת — אחרת כל סכום דומה היה נתפס
  if (sug(7500, { fx: true }).length) throw new Error('שער רחוק (18%) התקבל כהתאמה');
  // ושער קרוב מאוד כן
  if (!sug(6250, { fx: true }).length) throw new Error('שער קרוב נדחה');
  // לקוח חו"ל (מע"מ 0) מקבל סף רחב יותר: הוא משלם במט"ח, וההפרש סופג גם תנודת
  // שער וגם תשלום-חסר. המקרה האמיתי: חשבונית 1225 על ₪7,890 מול €2,100 ב-3.5571.
  const foreignInv = (amt) => [{ id: 'f', number: '1225', type: 320, clientName: 'SKY EVENTS',
    amountIncVat: amt, amountExVat: amt, date: '2026-02-19' }];
  const eurTx = { date: '10/03/2026', direction: 'credit', absAmount: 7451.97, nameHint: null, memo: '',
    fx: { currency: 'אירו', amount: 2100, rate: 3.5571, fee: 17.94, gross: 7469.91 } };
  const fs2 = (amt) => (M.matchCredits([eurTx], foreignInv(amt), 0.05, { fx: true })[0].suggestions || []);
  const hit = fs2(7890);
  if (!hit.length) throw new Error('לקוח חו״ל בפער 5.6% לא הוצע');
  const r2 = (hit[0].reasons || []).join(' ');
  if (!/לקוח חו״ל/.test(r2)) throw new Error('לא סומן כלקוח חו״ל');
  if (!/חסר ₪438\.03/.test(r2)) throw new Error('הפער שלא התקבל אינו מדווח: ' + r2);
  // אותו פער בחשבונית עם מע"מ ישראלי — נדחה, היא לא אמורה להשתלם באירו
  const local = [{ id: 'l', number: '9', type: 320, clientName: 'x', amountIncVat: 7890, amountExVat: 6686.44, date: '2026-02-19' }];
  if ((M.matchCredits([eurTx], local, 0.05, { fx: true })[0].suggestions || []).length)
    throw new Error('חשבונית עם מע״מ ישראלי קיבלה את הסף הרחב');
  // גם ללקוח חו"ל יש גבול — 12% אינו תנודת שער
  if (fs2(9400).length) throw new Error('פער של 12% התקבל אצל לקוח חו״ל');

  // שורה בלי פרטי המרה אינה נהנית מהסבילות המורחבת
  const plain = M.matchCredits([{ ...tx, fx: null }], inv(6301), 0.05, { fx: true })[0];
  if ((plain.suggestions || []).length) throw new Error('שורה רגילה קיבלה סבילות של מט״ח');

  // מופעל פר-חברה בלבד
  const srv = fs.readFileSync('server.js', 'utf8');
  if (!/const FX_COMPANIES = \['co_tal'\]/.test(srv)) throw new Error('רשימת חברות המט״ח חסרה');
  if ((srv.match(/FX_COMPANIES\.includes\(companyId\)/g) || []).length !== 2)
    throw new Error('לא כל מסלולי ההתאמה מעבירים את דגל המט״ח');
  return true;
});

// ברירת המחדל של מסך הבנק היא "רק זכות", וכל ההוצאות נעלמות בלי סימן — מה
// שנקרא כאילו הן לא נקלטו בייבוא כלל. המונה הוא ההבדל בין "לא יובא" ל"מוסתר".
check('התאמת בנק — המסנן מדווח כמה שורות הוא מסתיר', () => {
  const fn = app.slice(app.indexOf('function bankSummaryHtml'), app.indexOf('const BANK_DIR_HE'));
  if (!/const hidden = Math\.max\(0, \(_bankList \|\| \[\]\)\.length - rows\.length\)/.test(fn))
    throw new Error('לא נספר כמה שורות מוסתרות');
  if (!/שורות מוסתרות במסנן הנוכחי/.test(fn)) throw new Error('אין אזהרה על שורות מוסתרות');
  if (!/הן קיימות במערכת/.test(fn)) throw new Error('האזהרה אינה מבהירה שהשורות קיימות');
  if (!/setBankFilter\('all'\)/.test(fn)) throw new Error('אין דרך מהירה להציג הכל');
  if (!/BANK_DIR_HE/.test(fn)) throw new Error('שם המסנן אינו מוצג');
  // ברירת המחדל מציגה הכל: שורה שלא נראית נקראת כשורה שלא נקלטה
  if (/state\.bankFilter \|\| 'credit'/.test(app)) throw new Error('ברירת המחדל עדיין מסתירה הוצאות');
  if (!/state\.bankFilter \|\| 'all'/.test(app)) throw new Error('ברירת המחדל אינה "הכל"');
  return true;
});

// "טרם שולם" נגזר מהתאמות הבנק: מסמך שמצורף לשורה ומותאם לתנועת חובה = שולם.
// הלוגיקה קראה רק את השדות הישנים ולא את docs[] — ולכן שורות עם קבלה מצורפת
// הופיעו כולן "טרם שולם" אף שהכסף יצא.
check('תשלום לספק — מסמך שמצורף לשורה בלוח נספר מהתאמות הבנק', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const fn = srv.match(/function applyBankSupplierPayments\(db, want\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('applyBankSupplierPayments לא נמצאה');
  const build = (debits, dates = {}) => new Function('supplierBankDebitByKey', '_nrmExpKey', 'giCompanyId', 'save', 'bankDebitDates', '_dateKey',
    fn[0] + '; return applyBankSupplierPayments;')(
    () => debits, (x) => String(x || '').replace(/\s+/g, '').replace(/^0+/, ''), () => 'c', () => {},
    dates, (d) => { const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || ''); });

  // שורה שכל הקישור שלה הוא מסמך ב-docs, והמסמך מותאם בבנק
  const mk = () => ({ supplierPayables: [], events: [{ id: 'e1', companyId: 'c',
    contractorDetails: [{ role: 'קלידן', name: 'יואב', amount: 2100,
      docs: [{ id: 'd1', number: '80298', type: 400 }] }] }] });
  let db = mk();
  build({ 'num:80298': 2100 })(db, 'c');
  const row = db.events[0].contractorDetails[0];
  if (!row.paid) throw new Error('מסמך שמצורף לשורה ומותאם בבנק לא נספר כתשלום');
  if (row.paidSource !== 'bank') throw new Error('מקור התשלום אינו הבנק: ' + row.paidSource);

  // בלי התאמה בבנק — נשאר טרם שולם
  db = mk();
  build({})(db, 'c');
  if (db.events[0].contractorDetails[0].paid) throw new Error('שורה בלי התאמת בנק סומנה כשולמה');

  // מזהה הוצאה של חשבונית ירוקה (gi:<id>) נבדק גם הוא
  db = { supplierPayables: [], events: [{ id: 'e1', companyId: 'c',
    contractorDetails: [{ name: 'מאיה', amount: 1800, docs: [{ id: 'd', payableId: 'gi:X1' }] }] }] };
  build({ 'id:X1': 1800 })(db, 'c');
  if (!db.events[0].contractorDetails[0].paid) throw new Error('מסמך מחשבונית ירוקה לא נספר כתשלום');

  // כיסוי חלקי נחשב שולם: חשבונית אחת מכסה כמה אירועים, ותנועה אחת משלמת
  // כמה חשבוניות — ולכן השוואת סכומים סימנה תשלומים אמיתיים כלא שולמו
  db = { supplierPayables: [{ id: 'p1', companyId: 'c', number: '500', amount: 5000 }],
    events: [{ id: 'e1', companyId: 'c', contractorDetails: [{ name: 'ספק', amount: 1000, paidPayableId: 'p1' }] }] };
  build({ 'num:500': 1200 })(db, 'c');
  if (!db.events[0].contractorDetails[0].paid) throw new Error('כיסוי חלקי לא נחשב שולם');

  // והחישוב רץ גם בטעינת הלוח, ולא רק במסך הספקים
  const board = srv.slice(srv.indexOf("add('GET', /^\\/api\\/event-board$/"), srv.indexOf("// GET /api/event-board/expenses"));
  if (!/applyBankSupplierPayments\(db, cid\)/.test(board))
    throw new Error('הלוח אינו מחשב מחדש סטטוס תשלום — הדגלים יישארו ישנים');
  // ותנועה בלי תיוג חברה אינה נופלת מהחישוב
  if (!/if \(want && !ownedBy\(t, want\)\) continue;/.test(srv))
    throw new Error('מפת החובה משתמשת בהשוואה נוקשה ומפילה תנועות בלי תיוג');

  // תאריך התשלום נשמר על השורה — מהתנועה שמותאמת למסמך שלה
  db = mk();
  build({ 'num:80298': 2100 }, { 'num:80298': '16/09/2026' })(db, 'c');
  if (db.events[0].contractorDetails[0].paidDate !== '16/09/2026')
    throw new Error('תאריך התשלום לא נשמר: ' + db.events[0].contractorDetails[0].paidDate);

  // סימון ידני אינו מבוטל בהיעדר התאמה
  db = mk(); db.events[0].contractorDetails[0].paid = true; db.events[0].contractorDetails[0].paidSource = 'manual';
  build({})(db, 'c');
  if (!db.events[0].contractorDetails[0].paid) throw new Error('סימון ידני בוטל');
  return true;
});

// הוצאה שחיה בחשבונית ירוקה בלבד — שיוך לאירועים חייב לעבוד גם עליה. בלי זה
// הראוט החזיר 404, הסכומים נראו מעודכנים במסך, והאירוע לא הציג שום מסמך.
check('שיוך הוצאה לאירועים — עובד גם על הוצאה שקיימת רק בחשבונית ירוקה', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const i = srv.indexOf("add('POST', /^\\/api\\/supplier-payables\\/([^/]+)\\/event-amounts$/");
  if (i < 0) throw new Error('ראוט השיוך לאירועים לא נמצא');
  const ea = srv.slice(i, i + 3500);
  if (!/replace\(\/\^gi:\/, ''\)/.test(ea)) throw new Error('הראוט אינו מקבל מזהה של חשבונית ירוקה');
  if (!/greenInvoice\.getExpense\(rawId\)/.test(ea)) throw new Error('פרטי ההוצאה אינם נשלפים מחשבונית ירוקה');
  if (!/row\.paidInvoice = String\(pay\.number\)/.test(ea)) throw new Error('מספר המסמך אינו נשמר על השורה');
  if (!/async \(req, res, params, q, body\)/.test(ea)) throw new Error('הראוט אינו אסינכרוני');

  // והלוח משלים את פרטי ההוצאה, אחרת התגית תציג "מסמך" ריק
  const j = srv.indexOf("add('GET', /^\\/api\\/event-board$/");
  const board = srv.slice(j, j + 2500);
  if (!/^add\('GET', \/\^\\\/api\\\/event-board\$\/, async/.test(board)) throw new Error('ראוט הלוח אינו אסינכרוני');
  if (!/String\(x\)\.startsWith\('gi:'\)/.test(board)) throw new Error('הלוח אינו מזהה שורות שמקושרות לחשבונית ירוקה');
  if (!/payablesById\.set\(gid/.test(board)) throw new Error('פרטי ההוצאה אינם מושלמים לתגית');
  if (!/slice\(0, 40\)/.test(board)) throw new Error('אין תקרה למספר השליפות מחשבונית ירוקה');
  return true;
});

// המסמך המרוכז נבנה בסדר שבו סומנו התיבות, והיה חסר שדות שיש בעורך מסמך המשך.
// ללקוח הוא נראה מבולגן וחסר, אף שזה אותו עורך.
check('מסמך מרוכז — מיון לפי תאריך, וכל השדות של מסמך המשך', () => {
  const key = new Function(app.match(/function docSortKey\(d\) \{[\s\S]*?\n\}/)[0] + '; return docSortKey;')();
  if (key('15/03/2026') !== '2026-03-15') throw new Error('DD/MM/YYYY לא מומר למיון');
  if (key('2026-02-10') !== '2026-02-10') throw new Error('ISO לא נתמך');
  if (key('') !== '9999') throw new Error('מסמך בלי תאריך אינו נדחק לסוף');
  const rows = [{ date: '15/03/2026' }, { date: '01/01/2026' }, { date: '2026-02-10' }, { date: '' }];
  const sorted = rows.slice().sort((a, b) => String(key(a.date)).localeCompare(String(key(b.date))));
  if (sorted[0].date !== '01/01/2026' || sorted[3].date !== '') throw new Error('המיון שגוי: ' + sorted.map(x => x.date).join(','));

  const subj = new Function(app.match(/function docSortKey\(d\) \{[\s\S]*?\n\}/)[0] + ';'
    + app.match(/function consolSubject\(clientName, gi, up\) \{[\s\S]*?\n\}/)[0] + '; return consolSubject;')();
  if (subj('c', rows, []) !== 'מסמך מרוכז 01.01.26–15.03.26') throw new Error('נושא לפי טווח תאריכים שגוי: ' + subj('c', rows, []));
  if (subj('c', [{ date: '05/05/2026' }], []) !== 'מסמך מרוכז 05.05.26') throw new Error('נושא ליום אחד שגוי');
  if (subj('c', [{}], []) !== 'מסמך מרוכז') throw new Error('נושא בלי תאריכים שגוי');

  // המקורות ממוינים לפני בניית השורות
  const open = app.slice(app.indexOf('window.openConsolidate ='), app.indexOf('window.openConsolidateEditor'));
  if ((open.match(/\.sort\(byDate\)/g) || []).length !== 2) throw new Error('לא שני סוגי המקורות ממוינים');
  if (!/data-date=/.test(app)) throw new Error('תאריך המסמך אינו נשמר על תיבת הסימון');

  // אותם שדות כמו בעורך מסמך המשך
  const ed = app.slice(app.indexOf('window.openConsolidateEditor'), app.indexOf('function followupRemarks'));
  for (const f of ['payTerms', 'sendEmail', 'description']) {
    if (!new RegExp(`${f}:`).test(ed)) throw new Error('שדה חסר במסמך המרוכז: ' + f);
  }
  if (!/client-email/.test(ed)) throw new Error('מייל הלקוח אינו נשלף לשליחה אוטומטית');
  // והם נשלחים בפועל בהפקה
  const conf = app.slice(app.indexOf("fetch('/api/documents/consolidate'"), app.indexOf("fetch('/api/documents/consolidate'") + 700);
  for (const f of ['paymentTerms', 'sendEmail', 'email']) {
    if (!conf.includes(f)) throw new Error('לא נשלח בהפקת המסמך המרוכז: ' + f);
  }

  // מזהה הלקוח חייב להגיע לתצוגה המקדימה: בלעדיו חשבונית ירוקה מרנדרת שם בלבד,
  // בלי פרטי איש הקשר, והתצוגה נראית חסרה לעומת המסמך שיופק בפועל.
  if (!/clientId: e\.clientId \|\| null, clientName: e\.clientName \|\| null/.test(app))
    throw new Error('התצוגה המקדימה של עורך המסמך אינה מעבירה clientId');
  if (!/clientId: r\.client\?\.id \|\| null/.test(app)) throw new Error('עורך מסמך המשך אינו שומר את מזהה הלקוח');
  if (!/if \(!clientId && r && r\.client && r\.client\.id\) clientId = r\.client\.id/.test(app))
    throw new Error('המסמך המרוכז אינו שולף את מזהה הלקוח ממסמכי המקור');
  if (!/clientId: e\.clientId \|\| null, clientName: e\.clientName, type: e\.type/.test(app))
    throw new Error('הפקת המסמך המרוכז אינה שולחת clientId');
  // והשרת אכן מעדיף מזהה על שם
  if (!/body\.clientId \? \{ id: body\.clientId \} : \{ name: String\(body\.clientName/.test(fs.readFileSync('server.js', 'utf8')))
    throw new Error('התצוגה המקדימה בשרת אינה מכבדת clientId');

  // חשבון עסקה מסכם — מותר בשרת ומוצע במסך
  const srv = fs.readFileSync('server.js', 'utf8');
  if (!/!\[300, 305, 320\]\.includes\(type\)/.test(srv)) throw new Error('השרת אינו מאפשר חשבון עסקה מסכם');
  if (!/openConsolidateEditor\(300\)/.test(app)) throw new Error('אין אפשרות לחשבון עסקה במסך');
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/documents\\/consolidate$/"), srv.indexOf("add('POST', /^\\/api\\/documents\\/consolidate$/") + 9000);
  if (!/applyPaymentTerms\(opts, body\)/.test(route)) throw new Error('תנאי התשלום אינם מוחלים במסמך המרוכז');
  return true;
});

// תנועה שאושרה בלי מסמך אינה מופיעה ב"לא מותאמות" (היא מאושרת) ואינה מעוררת
// חשד (היא ירוקה) — ונספרת במלואה בהכנסות/הוצאות. זו הדרך היחידה לראות אותה.
check('התאמת בנק — תנועות שאושרו בלי אף מסמך מוצגות', () => {
  const fn = app.slice(app.indexOf('function bankNoDocRows'), app.indexOf('function bankVisibleRows'));
  if (!fn) throw new Error('bankNoDocRows לא נמצאה');
  const rows = new Function('_bankList', 'ddmy', 'escapeHtml', 'escAttr', 'money',
    fn + '; return { bankNoDocRows, bankNoDocHtml };')(
    [{ id: 'a', date: '10/09/2026', absAmount: 55106, direction: 'debit', matchStatus: 'approved', matchedInvoices: [] },
     { id: 'b', date: '01/09/2026', absAmount: 900, direction: 'credit', matchStatus: 'approved', matchedInvoices: [{ id: 'd' }] },
     { id: 'c', date: '02/09/2026', absAmount: 7000, direction: 'debit', matchStatus: 'unmatched', matchedInvoices: [] },
     { id: 'd', date: '03/09/2026', absAmount: 90000, direction: 'credit', matchStatus: 'approved', matchedInvoices: [] }],
    (d) => String(d), (x) => String(x == null ? '' : x), (x) => String(x == null ? '' : x),
    (n) => '₪' + Number(n || 0).toLocaleString('he-IL'));

  const r = rows.bankNoDocRows();
  if (r.length !== 2) throw new Error('נבחרו שורות שגויות: ' + r.length);
  if (r[0].id !== 'd') throw new Error('אינן ממוינות לפי סכום — הגדולה ביותר ראשונה');
  if (r.some(x => x.matchStatus !== 'approved')) throw new Error('נכללה שורה שאינה מאושרת');
  if (r.some(x => (x.matchedInvoices || []).length)) throw new Error('נכללה שורה עם מסמך');

  const html = rows.bankNoDocHtml();
  if (!/2 תנועות אושרו בלי אף מסמך/.test(html)) throw new Error('הכותרת אינה מדווחת את המספר');
  if (!/145,106/.test(html)) throw new Error('הסכום הכולל שגוי');
  if (!/bankShowTx/.test(html)) throw new Error('אין דרך לקפוץ לשורה');
  // בלי שורות כאלה — אין רעש על המסך
  const empty = new Function('_bankList', 'ddmy', 'escapeHtml', 'escAttr', 'money',
    fn + '; return bankNoDocHtml;')([], String, String, String, String)();
  if (empty !== '') throw new Error('הרכיב מוצג גם כשאין מה להציג');
  if (!/\$\{bankNoDocHtml\(\)\}/.test(app)) throw new Error('הרכיב אינו מוצג במסך הבנק');
  return true;
});

// שורה ששויכה מפסיקה להיות "לא מותאמת" ויוצאת מהמסנן — וזה נראה כאילו התנועה
// נמחקה. ההודעה היא ההבדל בין "נעלם לי כסף" לבין "עבר למותאמות".
check('התאמת בנק — שורה שיצאה מהתצוגה אחרי שיוך מוסברת ולא נעלמת בשקט', () => {
  if (!/id="bankNotice"/.test(app)) throw new Error('אין מקום להודעה מעל הטבלה');
  const fn = app.slice(app.indexOf('window.bankNoticeIfHidden'), app.indexOf('window.bankShowTx'));
  if (!fn) throw new Error('bankNoticeIfHidden לא נמצאה');
  if (!/bankVisibleRows\(\)\.some\(x => x\.id === id\)/.test(fn))
    throw new Error('ההודעה אינה נגזרת מהשאלה אם השורה באמת נעלמה מהתצוגה');
  if (!/לא נמחקה/.test(fn)) throw new Error('ההודעה אינה אומרת במפורש שהתנועה קיימת');
  // שני מסלולי השיוך מפעילים אותה — הכפתור בשורה, והחלונית
  if ((app.match(/bankNoticeIfHidden\(/g) || []).length < 2)
    throw new Error('לא כל מסלולי השיוך מודיעים על היעלמות');
  // המעבר לשורה מנקה את כל המסננים, אחרת "הצג אותה" לא יראה כלום
  const show = app.slice(app.indexOf('window.bankShowTx'), app.indexOf('window.bankShowTx') + 800);
  for (const f of ['bankFilter', 'bankPer', 'bankSearch']) {
    if (!show.includes(f)) throw new Error('המעבר אינו מנקה את המסנן: ' + f);
  }
  if (!/btr-/.test(show)) throw new Error('השורה אינה מאותרת לפי המזהה שלה');
  return true;
});

// ייבוא רשימת המסמכים מהמערכת הקודמת. שגיאת מיפוי כאן מכניסה היסטוריה שגויה
// שתיראה אמיתית בדוחות ובהתאמות הבנק, ולכן כל מיפוי נבדק בפועל.
check('ייבוא ממערכת קודמת — סוגים, תאריכים, סגור/פתוח וכפילויות', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const blk = srv.slice(srv.indexOf('const LEGACY_DOC_TYPES'), srv.indexOf("// POST /api/legacy-import"));
  const f = new Function(blk + '; return { legacyDocType, legacyIso };')();

  // הסוגים כפי שהכוורת כותבת אותם
  for (const [name, want] of [['חשבונית מס קבלה', 320], ['חשבונית מס-קבלה', 320], ['חשבונית מס', 305],
    ['קבלה', 400], ['חשבונית זיכוי', 330], ['חשבון עסקה', 300]]) {
    if (f.legacyDocType(name) !== want) throw new Error(`סוג "${name}" → ${f.legacyDocType(name)} במקום ${want}`);
  }
  if (f.legacyDocType('משהו אחר') !== null) throw new Error('סוג לא מוכר לא נדחה');
  // "חשבונית מס" לא תיבלע לתוך "חשבונית מס קבלה" — ההבדל הוא 305 מול 320
  if (f.legacyDocType('חשבונית מס') === f.legacyDocType('חשבונית מס קבלה')) throw new Error('שני סוגים שונים מופו לאותו קוד');

  // תאריכים: DD.MM.YYYY של הכוורת, וגם ספרה בודדת
  for (const [raw, want] of [['05.01.2026', '2026-01-05'], ['31.08.2026', '2026-08-31'],
    ['1.2.2026', '2026-02-01'], ['2026-03-05', '2026-03-05']]) {
    if (f.legacyIso(raw) !== want) throw new Error(`תאריך ${raw} → ${f.legacyIso(raw)}`);
  }
  if (f.legacyIso('שטות') !== null) throw new Error('תאריך לא תקין לא נדחה');

  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/legacy-import$/"), srv.indexOf("// POST /api/old-invoices/:id/attach-doc"));
  if (!/reqCompany\(q, b\)/.test(route)) throw new Error('הייבוא אינו נגזר מ-reqCompany');
  if (!/role !== 'admin'/.test(route)) throw new Error('משתמש צפייה יכול לייבא היסטוריה');
  if (!/existing\.has\(key\)/.test(route)) throw new Error('אין מניעת כפילות — ייבוא חוזר ישכפל הכל');
  if (!/סגור\|שולם\|נסגר/.test(route)) throw new Error('סטטוס "מסמך סגור" אינו נקרא');
  if (!/noFile: true/.test(route)) throw new Error('רשומה בלי קובץ אינה מסומנת ככזו');
  // מסמך שסומן סגור אינו נספר כחוב פתוח
  if (!/d\.closed \|\| !\[300, 305\]/.test(srv)) throw new Error('מסמך סגור מהייבוא יופיע כחשבונית פתוחה');
  // ובבורר המסמכים של הבנק לא נבנית כתובת קובץ למסמך שאין לו קובץ
  if (!/d\.noFile \? null : '\/api\/files\/' \+ d\.id/.test(srv)) throw new Error('נבנית כתובת קובץ למסמך בלי קובץ');

  // הפרונט: זיהוי עמודות לפי שמות, ולא לפי מיקום קבוע
  const ui = app.slice(app.indexOf('const LEGACY_HEADERS'), app.indexOf('window.openBulkOldInvoices ='));
  for (const h of ['מספר המסמך', 'סוג מסמך', 'שם הלקוח', 'תאריך המסמך', 'סטטוס', 'חשבונית רגילה']) {
    if (!ui.includes(h)) throw new Error('כותרת חסרה בזיהוי: ' + h);
  }
  if (!/cand\.number != null && cand\.type != null && cand\.date != null/.test(ui))
    throw new Error('שורת הכותרת מזוהה בלי לוודא שהעמודות החיוניות קיימות');
  if (!/legacyTypeNum/.test(ui)) throw new Error('אין תצוגה מקדימה של הסוגים לפני ייבוא');
  return true;
});

check('מסמכי ספק — הסוגים המותרים לפי סוג העוסק', () => {
  const lic = boardMod.supDocTypesFor({ vatExempt: false });
  // קבלה כלולה גם לעוסק מורשה: היא אינה מסמך המס שלו, אבל היא הוכחת התשלום
  if (lic.join(',') !== '300,305,320,400') throw new Error('עוסק מורשה: ' + lic);
  const ex = boardMod.supDocTypesFor({ vatExempt: true });
  if (ex.join(',') !== '400') throw new Error('עוסק פטור: ' + ex);
  // הממשק חייב להסכים עם השרת, אחרת המסך יציע סוג שהשרת ידחה
  const uiNames = app.match(/const SUP_DOC_NAMES = \{([^}]*)\}/);
  if (!uiNames) throw new Error('שמות המסמכים חסרים בממשק');
  for (const [t, n] of Object.entries(boardMod.SUP_DOC_NAMES)) {
    if (!new RegExp(`${t}:\\s*'${n}'`).test(uiNames[1])) throw new Error(`סוג ${t} אינו "${n}" בממשק`);
  }
  const uiFn = app.match(/const supDocTypes = \(r\) => [^\n]+/);
  if (!uiFn || !/\[400\]/.test(uiFn[0]) || !/\[300, 305, 320\]/.test(uiFn[0])) throw new Error('כללי הסוגים בממשק אינם תואמים');
  // השרת אוכף — לא רק מציג
  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/event-board\\/([^/]+)\\/row"));
  const body = route.slice(0, 4200);
  if (!/const allowed = eventBoard\.supDocTypesFor\(r\.row\)/.test(body)) throw new Error('השרת אינו מחשב את הסוגים המותרים');
  // בשיוך, האימות חייב להיות על הסוג האמיתי של ההוצאה ולא על מה שנשלח בבקשה
  if (!/allowed\.includes\(eventBoard\.normDocType\(p\.documentType\)\)/.test(body)) throw new Error('שיוך אינו מאמת את סוג ההוצאה עצמה');
  // הוצאה שמגיעה מחשבונית ירוקה עצמה (gi:<id>) — מסך הבנק תמיד ידע לשייך אותה,
  // והלוח לא. היא עוברת באותו מסלול ועם אותה אכיפת סוג.
  if (!/String\(b\.payableId\)\.startsWith\('gi:'\)/.test(body)) throw new Error('הלוח אינו מקבל הוצאה מחשבונית ירוקה');
  if (!/if \(!allowed\.includes\(et\)\) return reject\(\)/.test(body)) throw new Error('הוצאת חשבונית ירוקה אינה עוברת אכיפת סוג');
  // והבורר מציע אותן — אחרת אין מה לשייך
  const picker = srv.slice(srv.indexOf("add('GET', /^\\/api\\/event-board\\/expenses$/"), srv.indexOf("// POST /api/event-board —"));
  if (!/expensesInRange/.test(picker)) throw new Error('הבורר אינו קורא את ההוצאות של חשבונית ירוקה');
  if (!/seenNum\.has/.test(picker)) throw new Error('אין מניעת כפילות בין המראה המקומית לחשבונית ירוקה');
  // והקובץ ניתן לצפייה מהשורה
  if (!/d\.giExpenseId \|\| \(d\.payableId && String\(d\.payableId\)\.startsWith\('gi:'\)/.test(app))
    throw new Error('מסמך מחשבונית ירוקה אינו ניתן לצפייה מהשורה');
  // הוצאות ספק שומרות חשבון עסקה כסוג 20 ולא 300 — בלי נרמול הוא לא מזוהה כלל
  if (boardMod.normDocType(20) !== 300) throw new Error('סוג 20 אינו מנורמל לחשבון עסקה');
  if (boardMod.normDocType(305) !== 305) throw new Error('נרמול שינה סוג תקין');
  if (boardMod.normDocType(null) !== null) throw new Error('נרמול של ריק אינו ריק');
  const pay = new Map([['p1', { id: 'p1', documentType: 20, number: '88' }]]);
  const d = boardMod.rowDocs({ paidPayableId: 'p1' }, pay)[0];
  if (d.type !== 300) throw new Error('חשבון עסקה ששויך אינו מזוהה: ' + d.type);
  if (!/allowed\.includes\(type\)/.test(body)) throw new Error('העלאת קובץ אינה מאומתת');
  return true;
});
check('מסמכי ספק — עריכת שורה אינה מוחקת מסמכים', () => {
  const prev = [{ role: 'קלידן', name: 'דני', priceExVat: 1500, docs: [{ id: 'd1', type: 300, number: '1204' }] }];
  const out = boardMod.normalizeRows([{ role: 'קלידן', name: 'דני', priceExVat: 1600 }], prev);
  if ((out[0].docs || []).length !== 1) throw new Error('המסמכים נמחקו בעריכה');
  if (out[0].docs[0].number !== '1204') throw new Error('המסמך השתנה');
  // שורה חדשה מתחילה בלי מסמכים
  if (boardMod.normalizeRows([{ role: 'בסיסט', name: 'א', priceExVat: 100 }])[0].docs.length) throw new Error('שורה חדשה קיבלה מסמכים');
  return true;
});
// תגית המסמך בשורה הייתה טקסט בלבד: כדי לראות את המסמך היה צריך לפתוח "פירוט"
// ורק אז ללחוץ. עכשיו התגית עצמה פותחת אותו בפאנל הצד.
// קובץ שהועלה על שורה היה מסמך של האירוע בלבד: לא נספר בהוצאות, לא הופיע במסך
// הספקים, ולא היה ניתן לשיוך בהתאמות בנק. עכשיו הוא נרשם כהוצאת ספק אמיתית.
check('העלאת מסמך בשורה — נרשמת גם כהוצאת ספק', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const i = srv.indexOf("add('POST', /^\\/api\\/event-board\\/([^/]+)\\/row\\/(\\d+)\\/doc$/");
  const route = srv.slice(i, i + 5000);
  const up = route.slice(route.indexOf('} else if (b.data) {'));
  if (!/db\.supplierPayables\.push\(payable\)/.test(up)) throw new Error('לא נוצרת רשומת הוצאה');
  if (!/localFileId: saved\.id/.test(up)) throw new Error('הקובץ אינו מחובר להוצאה');
  if (!/payableId: payable\.id/.test(up)) throw new Error('המסמך בשורה אינו מצביע להוצאה');
  if (!/companyId: cid/.test(up)) throw new Error('ההוצאה נוצרת בלי שיוך חברה');
  if (!/const dupe = db\.supplierPayables\.find/.test(up)) throw new Error('אין מניעת כפילות — העלאה חוזרת תשכפל הוצאה');
  if (/\(1 \+ VAT_RATE\)/.test(up)) throw new Error('VAT_RATE אינו בהיקף — ייפול בזמן ריצה');
  if (!/eventBoard\.VAT_RATE/.test(up)) throw new Error('שיעור המע״מ אינו נלקח ממקור אחד');
  // ושורה בלי מסמך מציעה מיד את שתי הדרכים
  const chips = app.slice(app.indexOf('function bDocChips'), app.indexOf('function bDocPanel'));
  if (!/bDocLink\(/.test(chips) || !/bDocUpload\(/.test(chips))
    throw new Error('שורה בלי מסמך אינה מציעה שיוך והעלאה');
  return true;
});

check('מסמכי ספק — התגית בשורה פותחת את המסמך בפאנל הצד', () => {
  const src = app.slice(app.indexOf('function bDocChips'), app.indexOf('function bDocPanel'));
  if (!/onclick="event\.stopPropagation\(\);bDocShow\(/.test(src)) throw new Error('התגית אינה פותחת את המסמך');
  if (!/_bvDoc === d\.id/.test(src)) throw new Error('המסמך הפתוח אינו מסומן בתגית');
  if (!/<button class="tag invoiced"/.test(src)) throw new Error('התגית אינה לחיצה');
  // וההצגה עוברת דרך הפאנל הקיים ולא פותחת חלונית חדשה
  const show = app.slice(app.indexOf('window.bDocShow'), app.indexOf('window.bDocUpload'));
  if (/document\.createElement\('div'\)[\s\S]{0,80}modal/.test(show)) throw new Error('נפתחת חלונית חדשה');
  if (!/openBoardView\(ev\.id, true\)/.test(show)) throw new Error('הפאנל אינו מרונדר באותה חלונית');
  return true;
});

check('מסמכי ספק — לוח הצפייה נבנה ומציג את מה שמקושר', () => {
  const src = app.slice(app.indexOf('const SUP_DOC_NAMES ='), app.indexOf('window.bDocToggle'));
  const fns = new Function(`const escapeHtml=(x)=>String(x==null?'':x), escAttr=(x)=>String(x==null?'':x), money=(n)=>String(n), ddmy=(d)=>String(d||'');
    const window = {}; const openBoardView = () => {}; const state = { company: 'co_moshe' };
\n${src}\nreturn { bDocChips, bDocPanel };`)();
  const ev = { id: 'e1' };
  const licensed = { index: 0, role: 'קלידן', name: 'דני', vatExempt: false,
    docs: [{ id: 'd1', type: 300, number: '1204', payableId: 'pay1' }] };
  const chips = fns.bDocChips(ev, licensed);
  if (!/1204/.test(chips)) throw new Error('התג לא מציג את המסמך');
  if (!/חסר/.test(chips)) throw new Error('אין חיווי מה עוד חסר');
  const panel = fns.bDocPanel(ev, licensed);
  if (!/supplier-payables\/pay1\/file/.test(panel)) throw new Error('מסמך משויך אינו נפתח מהוצאות המערכת');
  if (!/עוסק מורשה/.test(panel)) throw new Error('סוג העוסק לא מוצג');
  const exempt = { index: 1, role: 'מתופף', name: 'רון', vatExempt: true, docs: [{ id: 'd2', type: 400, fileId: 'f9' }] };
  const p2 = fns.bDocPanel(ev, exempt);
  if (!/עוסק פטור/.test(p2)) throw new Error('עוסק פטור לא מסומן');
  if (!/api\/files\/f9/.test(p2)) throw new Error('קובץ שהועלה אינו נפתח מהקבצים');
  // שורה ריקה מסבירה ולא נראית שבורה
  if (!/עדיין לא שויך מסמך/.test(fns.bDocPanel(ev, { index: 2, role: 'תאורן', name: '', docs: [] }))) throw new Error('אין הסבר כשאין מסמכים');
  return true;
});

check('מחיר בשורת ספק — שלושת מצבי המע״מ', () => {
  const p = (o) => boardMod.rowTotals(o);
  const a = p({ priceExVat: 1000 });
  if (a.ex !== 1000 || a.inc !== 1180) throw new Error('ברירת מחדל: ' + JSON.stringify(a));
  const b = p({ priceExVat: 1180, priceIncVat: true });
  if (b.ex !== 1000 || b.inc !== 1180) throw new Error('כולל מע״מ: ' + JSON.stringify(b));
  const c = p({ priceExVat: 1000, vatExempt: true });
  if (c.ex !== 1000 || c.inc !== 1000 || c.vat !== 0) throw new Error('פטור: ' + JSON.stringify(c));
  // פטור גובר — לעוסק פטור אין מע"מ לחלץ
  const d = p({ priceExVat: 1000, vatExempt: true, priceIncVat: true });
  if (d.inc !== 1000) throw new Error('פטור לא גבר: ' + JSON.stringify(d));
  if (boardMod.normalizeRows([{ role: 'קלידן', name: 'א', priceExVat: 1000, vatExempt: true, priceIncVat: true }])[0].priceIncVat)
    throw new Error('נרמול לא ניטרל "כולל מע״מ" אצל פטור');
  // הממשק מחשב זהה לשרת
  const uiSrc = app.slice(app.indexOf('const bRowInc ='), app.indexOf('const bMonthName'));
  const ui = new Function(`const VAT_RATE=0.18;\n${uiSrc}\nreturn { bRowInc, bRowEx };`)();
  for (const row of [{ priceExVat: 1000 }, { priceExVat: 1180, priceIncVat: true }, { priceExVat: 1000, vatExempt: true }, { priceExVat: 0 }]) {
    const srv = boardMod.rowTotals(row);
    if (ui.bRowInc(row) !== srv.inc) throw new Error(`כולל מע״מ: ממשק ${ui.bRowInc(row)} שרת ${srv.inc}`);
    if (ui.bRowEx(row) !== srv.ex) throw new Error(`ללא מע״מ: ממשק ${ui.bRowEx(row)} שרת ${srv.ex}`);
  }
  // ושני הסימונים קיימים בטופס
  if (!/class="bd-inc"/.test(app)) throw new Error('סימון "כולל מע״מ" חסר בטופס');
  if (!/if \(r\.vatExempt\) r\.priceIncVat = false;/.test(app)) throw new Error('הטופס לא מנטרל "כולל מע״מ" אצל פטור');
  return true;
});
check('העלאת מסמך ספק — חלונית ולא prompt', () => {
  const src = app.slice(app.indexOf('window.bDocUpload ='), app.indexOf('window.bDocLink ='));
  if (/\bprompt\(/.test(src)) throw new Error('עדיין נעשה שימוש ב-prompt');
  for (const id of ['bduType', 'bduNum', 'bduDate', 'bduAmt', 'bduDrop']) {
    if (!src.includes(id)) throw new Error('חסר שדה: ' + id);
  }
  if (!/z-index|zIndex/.test(src)) throw new Error('החלונית עלולה להיפתח מתחת לחלונית האירוע');
  if (!/ondrop=/.test(src)) throw new Error('אין גרירת קובץ');
  return true;
});

check('מסמכי ספק — שיוך ממסך הספקים נראה גם בלוח', () => {
  // שני מנגנוני שיוך: הלוח שומר ב-docs, ומסך הספקים שומר ב-paidPayableId.
  // בלי איחוד, מסמך ששויך במסך הספקים פשוט לא נראה בלוח.
  const pay = new Map([['pay1', { id: 'pay1', documentType: 305, number: '1391', date: '2026-10-01', amount: 1770 }]]);
  const row = { role: 'חדר חזרות', name: 'מוסטקי', priceExVat: 1500, paidPayableId: 'pay1', paidInvoice: '1391' };
  const docs = boardMod.rowDocs(row, pay);
  if (docs.length !== 1) throw new Error('מסמכים: ' + docs.length);
  if (docs[0].type !== 305 || docs[0].number !== '1391') throw new Error('פרטי המסמך: ' + JSON.stringify(docs[0]));
  if (!docs[0].fromPayables) throw new Error('המקור לא מסומן');
  if (docs[0].id !== 'pay:pay1') throw new Error('מזהה לניתוק: ' + docs[0].id);
  // בלי מפת הוצאות — עדיין מוצג, עם מה שיש על השורה
  const bare = boardMod.rowDocs(row, null);
  if (bare.length !== 1 || bare[0].number !== '1391') throw new Error('נפילה בלי מפה: ' + JSON.stringify(bare));
  // לא כופלים מסמך שכבר ברשימה
  const both = boardMod.rowDocs({ ...row, docs: [{ id: 'd1', payableId: 'pay1', type: 305 }] }, pay);
  if (both.length !== 1) throw new Error('המסמך הוכפל');
  // שורה בלי שיוך — ריקה
  if (boardMod.rowDocs({ role: 'קלידן' }, pay).length) throw new Error('נוצר מסמך יש מאין');
  // והשרת יודע לנתק שיוך כזה
  const srv = fs.readFileSync('server.js', 'utf8');
  const del = srv.slice(srv.indexOf("add('DELETE', /^\\/api\\/event-board\\/([^/]+)\\/row"));
  if (!/\^pay:\(\.\+\)\$/.test(del.slice(0, 1200))) throw new Error('ניתוק שיוך ממסך הספקים אינו נתמך');
  if (!/paidPayableId = null/.test(del.slice(0, 1200))) throw new Error('הניתוק אינו מנקה את השדה');
  return true;
});

check('צפייה במסמך ספק — בתוך חלונית האירוע ולא בחלון חדש', () => {
  const src = app.slice(app.indexOf('function bDocPanel('), app.indexOf('window.bDocToggle'));
  if (/previewDoc\(/.test(src)) throw new Error('הצפייה עדיין פותחת חלונית נפרדת');
  if (!/bDocShow\(/.test(src)) throw new Error('אין כפתור שמציג את המסמך בחלונית');
  // התצוגה עצמה היא לוח צד בתוך חלונית האירוע
  const view = app.slice(app.indexOf('window.openBoardView ='), app.indexOf('// הפקת מסמך לאירוע'));
  if (!/<iframe/.test(view)) throw new Error('אין תצוגה מוטמעת בחלונית');
  if (!/bvFindDoc\(ev, _bvDoc\)/.test(view)) throw new Error('המסמך המוצג אינו מאותר');
  if (!/flex:0 0 \$\{_bvWide \? 'min\(74%/.test(view)) throw new Error('התצוגה אינה לוח צד');
  if (!/min\(1480px,98vw\)/.test(view)) throw new Error('החלונית אינה מתרחבת כשמסמך פתוח');
  // הכפתור בשורה מרחיב פירוט ואינו מתחזה לצפייה במסמך
  const rowBtn = app.split('\n').find(l => l.includes('bDocToggle(${r.index})'));
  if (!rowBtn) throw new Error('כפתור הפירוט לא נמצא');
  if (/👁/.test(rowBtn)) throw new Error('כפתור הפירוט מסומן כעין ומטעה');
  if (!/פירוט/.test(rowBtn)) throw new Error('הכפתור אינו אומר מה הוא עושה');
  // סגירת הפירוט סוגרת גם תצוגה פתוחה, אחרת נשאר מסמך תלוי באוויר
  const tog = app.slice(app.indexOf('window.bDocToggle ='), app.indexOf('window.bDocShow ='));
  if (!/_bvDoc = null/.test(tog)) throw new Error('סגירת הפירוט משאירה תצוגה פתוחה');
  return true;
});

check('חלונית האירוע נבנית תקין גם עם מסמך פתוח בצד', () => {
  const view = app.slice(app.indexOf('let _bvEvent = null;'), app.indexOf('// הפקת מסמך לאירוע'));
  const helpers = app.slice(app.indexOf('const SUP_DOC_NAMES ='), app.indexOf('window.bDocToggle'));
  const stubs = `
    const escapeHtml=(x)=>String(x==null?'':x), escAttr=(x)=>String(x==null?'':x);
    const money=(n)=>String(n), ddmy=(d)=>String(d||'');
    let __h='';
    const document = { getElementById: () => null, body:{ appendChild(){} },
      createElement: () => ({ classList:{add(){},remove(){}}, style:{}, set innerHTML(v){ __h=v; }, get innerHTML(){ return __h; } }) };
    const window = {}; const state = { company: 'co_moshe' };
    const boardFind = () => ev;
  `;
  const ev = { id: 'e1', date: '2026-10-08', artist: 'רידינג 3', clientName: 'לקוח', notes: '',
    totals: { incomeEx: 5000, incomeInc: 5900, expenseEx: 1500, expenseInc: 1770, profitEx: 3500, unpaidRows: 1 },
    linkedDocs: [],
    rows: [{ index: 0, role: 'חדר חזרות', name: 'מוסטקי', priceExVat: 1500, ex: 1500, inc: 1770, vatExempt: false, note: '',
      docs: [{ id: 'pay:p1', type: 300, number: '88', payableId: 'p1', fromPayables: true }] }] };
  const run = (openDoc) => new Function('ev', 'openDoc', `${stubs}\n${helpers}\n${view}\n_bvOpen={0:true}; _bvDoc=openDoc;\nwindow.openBoardView('e1', true);\nreturn __h;`)(ev, openDoc);

  const closed = run(null);
  if (/<iframe/.test(closed)) throw new Error('התצוגה פתוחה בלי שנלחצה');
  if (!/88/.test(closed)) throw new Error('המסמך לא מופיע בשורה');

  const open = run('pay:p1');
  if (!/<iframe/.test(open)) throw new Error('לוח הצד לא נפתח');
  if (!/bv-side/.test(open)) throw new Error('לוח הצד בלי המחלקה שמטפלת במסך צר');
  if (!/min\(1480px,98vw\)/.test(open)) throw new Error('החלונית לא התרחבה');
  if (!/חדר חזרות/.test(open)) throw new Error('תוכן האירוע נעלם כשנפתח מסמך');
  // ה-HTML מאוזן — שחזור מבנה שבור כאן היה מפיל את כל החלונית
  const opens = (open.match(/<div\b/g) || []).length, closes = (open.match(/<\/div>/g) || []).length;
  if (opens !== closes) throw new Error(`div לא מאוזן: ${opens} נפתחו, ${closes} נסגרו`);
  return true;
});

check('צפיין המסמך — פתיחה לרוחב, וזום שנשלט מהצפיין עצמו', () => {
  // ברירת המחדל של צפיין ה-PDF היא "התאם לעמוד", ובפאנל צר המסמך יוצא זעיר.
  const view = app.slice(app.indexOf('let _bvDoc = null;'), app.indexOf('// הפקת מסמך לאירוע'));
  const frag = new Function(`let _bvZoom = 0;
    ${app.slice(app.indexOf('const bDocFrag ='), app.indexOf('window.bDocZoom ='))}
    return (z) => { _bvZoom = z; return bDocFrag(); };`)();
  if (!/view=FitH/.test(frag(0))) throw new Error('ברירת המחדל אינה מילוי רוחב: ' + frag(0));
  if (!/zoom=150/.test(frag(150))) throw new Error('הזום אינו מועבר לצפיין: ' + frag(150));
  // הזום נשלט מהכתובת ולא ממתיחת תמונה — אחרת PDF יוצא מטושטש
  if (/transform:\s*scale/.test(view)) throw new Error('הזום נעשה במתיחה במקום בצפיין');

  // גבולות — לא להיתקע על זום בלתי שמיש
  const zoomFn = new Function(`let _bvZoom = 0; const _bvEvent = null; const openBoardView = () => {};
    const window = {};
    ${app.slice(app.indexOf('window.bDocZoom ='), app.indexOf('window.bDocWide ='))}
    return { set: (v) => { _bvZoom = v; }, run: (d) => { window.bDocZoom(d); return _bvZoom; } };`)();
  zoomFn.set(40); if (zoomFn.run(-25) !== 40) throw new Error('ירידה מתחת למינימום');
  zoomFn.set(400); if (zoomFn.run(25) !== 400) throw new Error('עלייה מעל המקסימום');
  zoomFn.set(150); if (zoomFn.run(0) !== 0) throw new Error('כפתור ההתאמה לרוחב לא מאפס');

  // הכפתורים קיימים בפועל
  for (const [pat, what] of [[/bDocZoom\(-25\)/, 'הקטנה'], [/bDocZoom\(25\)/, 'הגדלה'],
      [/bDocZoom\(0\)/, 'התאמה לרוחב'], [/bDocWide\(\)/, 'הרחבת הפאנל'], [/target="_blank"[^>]*title="פתיחה בלשונית/, 'פתיחה במסך מלא']]) {
    if (!pat.test(view)) throw new Error('חסר כפתור: ' + what);
  }
  // פתיחה חדשה מאפסת זום ורוחב, אחרת הגדרה מאירוע קודם נדבקת
  if (!/_bvZoom = 0; _bvWide = false;/.test(view)) throw new Error('פתיחה חדשה לא מאפסת את הצפיין');
  return true;
});

check('תצוגת מסמך — עוברת דרך השרת ולא מול קישור חיצוני', () => {
  // הקישור של חשבונית ירוקה הוא חיצוני, והדפדפן חסום מלמשוך אותו (CORS).
  // תצוגה שנשענה עליו נכשלה ונפלה ל"לא ניתן להציג את המסמך כאן".
  const pl = app.slice(app.indexOf('window.previewLinkedDoc ='), app.indexOf('window.previewDeriveFromDoc'));
  if (/previewDoc\(r\.url/.test(pl)) throw new Error('התצוגה עדיין נשענת על הקישור החיצוני');
  if (!/\/api\/documents\/\$\{encodeURIComponent\(docId\)\}\/download/.test(pl)) throw new Error('התצוגה אינה עוברת דרך השרת');
  if (!/fallbackUrl: r\.url/.test(pl)) throw new Error('אין נפילה לקישור החיצוני כשאי אפשר להגיש');
  // רשת ביטחון גם לכל קורא אחר שמעביר docId
  const pd = app.slice(app.indexOf('window.previewDoc = async'), app.indexOf('window.closePreview ='));
  if (!/viaServer/.test(pd)) throw new Error('אין ניסיון חוזר דרך השרת אחרי כשל');
  if (!/!String\(url\)\.startsWith\('\/api\/documents\/'\)/.test(pd)) throw new Error('הניסיון החוזר עלול להיכנס ללולאה');
  return true;
});
check('צפיין המסמכים המשותף — לרוחב, עם זום והרחבה', () => {
  const src = app.slice(app.indexOf('function previewShell('), app.indexOf('window.previewDoc = async'));
  const body = new Function(`let _pv = { blobUrl: 'blob:x', type: '', zoom: 0, wide: false, url: 'u', opts: {} };
    const escAttr = (x) => String(x == null ? '' : x);
    ${src}
    return (type, zoom) => { _pv.type = type; _pv.zoom = zoom; return previewBody(); };`)();
  if (!/view=FitH/.test(body('application/pdf', 0))) throw new Error('PDF אינו נפתח לרוחב');
  if (!/zoom=150/.test(body('application/pdf', 150))) throw new Error('הזום אינו מועבר לצפיין');
  if (!/max-width:100%/.test(body('image/png', 0))) throw new Error('תמונה אינה מותאמת');
  if (!/width:150%/.test(body('image/png', 150))) throw new Error('תמונה אינה מוגדלת');
  // שורת הכלים
  const shell = app.slice(app.indexOf('function previewShell('), app.indexOf('function previewBody('));
  for (const [pat, what] of [[/pvZoom\(-25\)/, 'הקטנה'], [/pvZoom\(25\)/, 'הגדלה'], [/pvZoom\(0\)/, 'התאמה לרוחב'], [/pvWide\(\)/, 'הרחבה']]) {
    if (!pat.test(shell)) throw new Error('חסר כפתור: ' + what);
  }
  // כל הכפתורים הוותיקים נשמרו — הצפיין משרת מסכים רבים
  for (const [pat, what] of [[/openDocLinks/, 'מסמכים מקושרים'], [/openDocSendHistory/, 'היסטוריית שליחה'],
      [/deleteDraft/, 'מחיקת טיוטה'], [/opts\.extraActions/, 'כפתורים נוספים'], [/closePreview\(\)/, 'סגירה']]) {
    if (!pat.test(shell)) throw new Error('אבד כפתור קיים: ' + what);
  }
  return true;
});

check('פלאפון — טפסים ברשת פיקסלים נערמים ולא חורגים מהמסך', () => {
  // נמדד בדפדפן אמיתי ברוחב 390: שורת פריט במסמך גלשה ל-426px וכפתור מחיקת
  // השורה נפל מחוץ למסך; שורת התפקיד בלוח גלשה ל-683px ושדה ההערה נעלם.
  const mob = css.slice(css.indexOf('@media (max-width: 640px)'));
  for (const [sel, what] of [['.nq-item', 'שורת פריט במסמך'], ['.bd-row', 'שורת תפקיד בלוח']]) {
    const i = mob.indexOf(sel + ' {');
    if (i < 0) throw new Error(`אין כלל פלאפון ל${what}`);
    const block = mob.slice(i, mob.indexOf('}', i));
    if (!/grid-template-columns:[^;]*!important/.test(block)) throw new Error(`${what} לא נערמת בפלאפון`);
  }
  // כותרות העמודות מוסתרות כשאין עמודות
  if (!/\.bd-head\s*\{\s*display:\s*none/.test(mob)) throw new Error('כותרת העמודות נשארת בפלאפון בלי עמודות');
  // טבלת פירוט ההוצאות הפכה לכרטיסים, אחרת כפתור "פירוט" נופל מחוץ למסך
  if (!/class="tbl cardify bv-rows"/.test(app)) throw new Error('פירוט ההוצאות אינו הופך לכרטיסים');
  const labels = (app.match(/<td data-label="[^"]+"/g) || []).length;
  if (labels < 6) throw new Error('חסרות תוויות לשדות בכרטיס: ' + labels);
  return true;
});
check('כפתורי השמירה בחלונית גבוהה נשארים על המסך', () => {
  // בלוח האירועים יש 14 שורות תפקיד, והכפתורים נדחפו אל מתחת לקצה המסך —
  // גם במחשב (נמדד: top=917 על מסך 900). בפלאפון כבר היה כלל דביק.
  if (!/class="modal-card tall-form"/.test(app)) throw new Error('חלונית האירוע אינה מסומנת כגבוהה');
  if (!/<div class="tall-body">/.test(app)) throw new Error('אין אזור גלילה נפרד מהכפתורים');
  const rule = css.slice(css.indexOf('.modal-card.tall-form'));
  if (!/position:sticky/.test(rule.slice(0, 900))) throw new Error('הכפתורים אינם דביקים');
  // הכלל מוגבל למסך רחב — בפלאפון יש כלל משלו עם שוליים צרים יותר
  const at = css.indexOf('.modal-card.tall-form > .modal-actions');
  const before = css.slice(Math.max(0, at - 400), at);
  if (!/@media \(min-width: 641px\)/.test(before)) throw new Error('הכלל אינו מוגבל למסך רחב, והשוליים השליליים חורגים בפלאפון');
  return true;
});

check('סדר החלוניות — חלונית שנפתחת מתוך אחרת יושבת מעליה', () => {
  // כל חלונית נשאה מספר שכבה קבוע. ברגע שנוסף מסלול פתיחה חדש — תצוגת מסמך
  // מתוך "תצוגת חיוב" — המספר הנמוך גרם לה להיפתח מאחור.
  const src = app.slice(app.indexOf('function topZ('), app.indexOf('window.openDocSendHistory'));
  const topZ = new Function(`${src}\nreturn topZ;`)();
  const mk = (z, hidden) => ({ classList: { contains: () => !!hidden }, __z: z });
  const docAll = (list) => { global.document = { querySelectorAll: () => list }; };
  global.getComputedStyle = (el) => ({ zIndex: String(el.__z) });

  docAll([]);
  if (topZ(200) !== '200') throw new Error('בלי חלוניות פתוחות לא נשמר המינימום');
  docAll([mk(300)]);
  if (topZ(200) !== '310') throw new Error('לא עלה מעל חלונית פתוחה: ' + topZ(200));
  docAll([mk(300), mk(310)]);
  if (topZ(200) !== '320') throw new Error('לא עלה מעל העליונה: ' + topZ(200));
  docAll([mk(9999, true)]);
  if (topZ(200) !== '200') throw new Error('חלונית מוסתרת נספרה');
  const self = mk(500);
  docAll([self, mk(300)]);
  if (topZ(200, self) !== '310') throw new Error('החלונית עצמה נספרה ומטפסת בכל פתיחה');

  // אין יותר מספרים קבועים בחלוניות שנפתחות מעל אחרות
  for (const id of ['docPreview', 'docSendHistModal', 'docLinks', 'billViewModal', 'bDocUpModal']) {
    const i = app.indexOf(`id = '${id}'`);
    if (i < 0) continue;
    const near = app.slice(i, i + 900);
    const fixed = near.match(/style\.zIndex = '(\d+)'/);
    if (fixed) throw new Error(`${id} עדיין עם שכבה קבועה (${fixed[1]})`);
  }
  return true;
});

check('מסמך המשך נצמד גם לאירוע שחויב במסלול ישן', () => {
  // אירוע שחויב בעבר נושא את המסמך ב-invoiceId/invoiceNumber בלבד, ו-linkedDocs
  // שלו ריק. המסך מציג אותו כמחויב, אבל התאמה לפי linkedDocs בלבד פספסה אותו,
  // ולכן מסמך המשך שהופק ממנו לא נצמד לשום אירוע.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('function linkFollowupToEvents'), srv.indexOf('function followupRemarks'));
  const fn = new Function('ownedBy', `${src}\nreturn linkFollowupToEvents;`)((r, c) => !r.companyId || r.companyId === c);

  const db = { events: [
    { id: 'legacy', companyId: 'co_ofek', linkedDocs: [], invoiceId: 'gi-10200', invoiceNumber: 10200, invoiceType: 300, invoiceStatus: 'invoiced' },
    { id: 'modern', companyId: 'co_ofek', linkedDocs: [{ id: 'gi-999', number: 999, type: 300 }] },
    { id: 'other',  companyId: 'co_bpm',  linkedDocs: [], invoiceId: 'gi-10200', invoiceNumber: 10200, invoiceType: 300 },
  ] };
  const ok = fn(db, 'co_ofek', new Set(['gi-10200', '10200']), { id: 'gi-30266', number: 30266 }, 320);
  if (!ok) throw new Error('לא סומן שינוי');
  const ev = db.events[0];
  if (!ev.linkedDocs.some(d => d.id === 'gi-30266')) throw new Error('מסמך ההמשך לא נוסף לאירוע');
  if (!ev.linkedDocs.some(d => String(d.number) === '10200' && d.converted)) throw new Error('המקור מהשדות הישנים לא הועבר לרשימה');
  if (ev.invoiceNumber !== 30266) throw new Error('האירוע לא עודכן למסמך החדש: ' + ev.invoiceNumber);
  if (ev.clientPaid !== true) throw new Error('מס-קבלה אינה סוגרת את האירוע');
  if (db.events[1].linkedDocs.length !== 1) throw new Error('אירוע שאינו קשור שונה');
  if (db.events[2].linkedDocs.length) throw new Error('זליגה: אירוע של חברה אחרת קושר');

  // התיקון הרטרואקטיבי מזהה גם אותם
  const bc = srv.slice(srv.indexOf('function backfillCandidates'), srv.indexOf('async function runFollowupBackfill'));
  const cand = new Function('ownedBy', 'FOLLOWUP_SRC_TYPES', 'FOLLOWUP_DERIVED_TYPES', `${bc}\nreturn backfillCandidates;`)(
    (r, c) => !r.companyId || r.companyId === c, [10, 300], [300, 305, 320]);
  const got = cand({ events: [{ id: 'legacy', companyId: 'co_ofek', linkedDocs: [], invoiceId: 'gi-1', invoiceNumber: 1, invoiceType: 300 }] }, 'co_ofek');
  if (!got.length) throw new Error('אירוע עם שדות ישנים אינו מועמד לתיקון');
  return true;
});

check('לוח האירועים — עמלה 15% והתשלום שנשאר למשה', () => {
  const ev = { price: 20000, contractorDetails: [] };
  const d = boardMod.eventTotals(ev);
  if (d.commissionPct !== 15 || d.commissionEx !== 3000 || d.incomeEx !== 17000)
    throw new Error('ברירת מחדל: ' + JSON.stringify(d));
  // אחוז אחר לאירוע בודד
  const ten = boardMod.eventTotals({ ...ev, commissionPct: 10 });
  if (ten.commissionEx !== 2000 || ten.incomeEx !== 18000) throw new Error('אחוז מותאם: ' + JSON.stringify(ten));
  // אפס הוא ערך לגיטימי ולא "לא הוגדר"
  const zero = boardMod.eventTotals({ ...ev, commissionPct: 0 });
  if (zero.commissionEx !== 0 || zero.incomeEx !== 20000) throw new Error('עמלה אפס: ' + JSON.stringify(zero));
  // ריק חוזר לברירת המחדל
  for (const v of ['', null, undefined, 'abc']) {
    if (boardMod.commissionPctOf({ commissionPct: v }) !== 15) throw new Error('ערך ריק לא חזר ל-15: ' + String(v));
  }
  if (boardMod.commissionPctOf({ commissionPct: 150 }) !== 100) throw new Error('אחוז מעל 100 לא נחסם');
  if (boardMod.commissionPctOf({ commissionPct: -5 }) !== 0) throw new Error('אחוז שלילי לא נחסם');

  // הממשק מחשב זהה לשרת, אחרת החלונית מראה סכום אחד והשרת שומר אחר
  const uiSrc = app.slice(app.indexOf('function bdCommPct('), app.indexOf('function bdIncomeLine('));
  const ui = new Function(`${uiSrc}\nreturn bdCommPct;`)();
  for (const v of ['', null, 15, 10, 0, 'abc']) {
    const got = ui({ commissionPct: v }), want = boardMod.commissionPctOf({ commissionPct: v });
    if (got !== want) throw new Error(`אחוז ${String(v)}: ממשק ${got} שרת ${want}`);
  }
  // התוויות שביקש המשתמש
  if (!/עמלה — שורה ראשונה/.test(app)) throw new Error('חסרה התווית "עמלה — שורה ראשונה"');
  if (!/תשלום — משה כורסיה/.test(app)) throw new Error('חסרה התווית "תשלום — משה כורסיה"');
  return true;
});

check('הפקת מסמך מהלוח — על הסכום שאחרי העמלה', () => {
  // המסמך ללקוח נבנה מהמחיר המלא, ולכן כלל גם את חלקו של גורם אחר.
  const src = app.slice(app.indexOf('window.boardIssueDoc ='), app.indexOf('window.boardIssueDoc =') + 2200);
  if (/price: Number\(ev\.price\) \|\| 0/.test(src)) throw new Error('המסמך עדיין נבנה מהמחיר המלא');
  if (!/t\.incomeEx/.test(src)) throw new Error('המסמך אינו משתמש בסכום שאחרי העמלה');
  if (!/boardNote/.test(src)) throw new Error('אין חיווי על איזה סכום המסמך יוצא');
  // נפילה לאחור כשאין סיכום — עדיף מסמך על המחיר מאשר מסמך על אפס
  if (!/\(Number\(ev\.price\) \|\| 0\)/.test(src)) throw new Error('אין נפילה למחיר כשאין סיכום');
  // החיווי באמת מוצג בחלונית
  if (!/e\.boardNote \?/.test(app)) throw new Error('החיווי לא מוצג בחלונית המסמך');
  return true;
});

check('עמלות נוספות — שם, אחוז או סכום, וסכום גובר על אחוז', () => {
  const ev = { price: 20000, extraCommissions: [{ name: 'הפקות אורן', pct: 5 }, { name: 'מפיק', amount: 800 }] };
  const t = boardMod.eventTotals(ev);
  if (t.commissions.length !== 3) throw new Error('מספר עמלות: ' + t.commissions.length);
  if (t.commissions[0].amount !== 3000 || !t.commissions[0].primary) throw new Error('עמלת ברירת המחדל: ' + JSON.stringify(t.commissions[0]));
  if (t.commissions[1].amount !== 1000 || t.commissions[1].pct !== 5) throw new Error('עמלה באחוז: ' + JSON.stringify(t.commissions[1]));
  if (t.commissions[2].amount !== 800 || t.commissions[2].pct !== null) throw new Error('עמלה בסכום: ' + JSON.stringify(t.commissions[2]));
  if (t.commissionEx !== 4800 || t.incomeEx !== 15200) throw new Error('סיכום: ' + JSON.stringify([t.commissionEx, t.incomeEx]));

  // סכום גובר על אחוז כששניהם הוזנו
  const both = boardMod.eventTotals({ price: 10000, extraCommissions: [{ name: 'x', pct: 50, amount: 300 }] });
  if (both.commissions[1].amount !== 300) throw new Error('הסכום לא גבר על האחוז: ' + both.commissions[1].amount);
  // שורה ריקה אינה נספרת
  if (boardMod.eventTotals({ price: 1000, extraCommissions: [{ name: '', pct: '', amount: '' }] }).commissions.length !== 1)
    throw new Error('שורה ריקה נספרה');
  // עמלות מעל המחיר — תשלום אפס ולא שלילי, עם דגל
  const over = boardMod.eventTotals({ price: 1000, extraCommissions: [{ name: 'x', amount: 5000 }] });
  if (over.incomeEx !== 0 || !over.commissionOver) throw new Error('חריגה: ' + JSON.stringify([over.incomeEx, over.commissionOver]));

  // הממשק מחשב זהה לשרת
  const uiSrc = app.slice(app.indexOf('function bdCommPct('), app.indexOf('function bdIncomeLine('));
  const ui = new Function(`${uiSrc}\nreturn bdCommList;`)();
  for (const fixture of [ev, { price: 10000, extraCommissions: [{ name: 'x', pct: 50, amount: 300 }] }, { price: 500 }]) {
    const a = ui(fixture).map(c => c.amount).join(',');
    const b = boardMod.commissionsOf(fixture).map(c => c.amount).join(',');
    if (a !== b) throw new Error(`ממשק ${a} · שרת ${b}`);
  }
  // והשרת שומר אותן
  const srv = fs.readFileSync('server.js', 'utf8');
  if (!/ev\.extraCommissions = /.test(srv)) throw new Error('השרת אינו שומר עמלות נוספות');
  if (!/\.slice\(0, 10\)/.test(srv.slice(srv.indexOf('ev.extraCommissions = '), srv.indexOf('ev.extraCommissions = ') + 700)))
    throw new Error('אין גבול למספר העמלות');
  return true;
});

check('מסמך בלי קובץ — הסבר ולא תשובת שגיאה גולמית', () => {
  // הוצאה שנרשמה בלי קובץ מחזירה JSON. ה-iframe הציג אותו כטקסט, ונראה
  // כאילו הצפיין שבור.
  const pv = app.slice(app.indexOf('window.previewDoc = async'), app.indexOf('window.closePreview ='));
  if (!/ct\.includes\('application\/json'\)/.test(pv)) throw new Error('הצפיין המשותף אינו מזהה תשובת שגיאה');
  if (!/throw new Error\(msg/.test(pv)) throw new Error('השגיאה אינה מועברת להודעה');
  if (!/e && e\.message/.test(pv)) throw new Error('סיבת השגיאה אינה מוצגת למשתמש');

  const show = app.slice(app.indexOf('window.bDocShow = async'), app.indexOf('function bvRow('));
  if (!/ct\.includes\('application\/json'\)/.test(show)) throw new Error('לוח האירועים אינו בודק לפני ההצגה');
  if (!/_bvDocErr = msg/.test(show)) throw new Error('ההסבר אינו נשמר');
  if (!/if \(closing\) return;/.test(show)) throw new Error('סגירה מפעילה בדיקה מיותרת');

  const view = app.slice(app.indexOf('let _bvEvent = null;'), app.indexOf('// הפקת מסמך לאירוע'));
  if (!/_bvDocErr \?/.test(view)) throw new Error('לוח הצד אינו מציג את ההסבר');
  if (!/לא נשמר קובץ למסמך הזה/.test(view)) throw new Error('אין הסבר קריא');
  if (!/bDocUpload\(/.test(view)) throw new Error('אין דרך להעלות את הקובץ החסר');
  // פתיחה חדשה מאפסת את ההסבר, אחרת הוא נדבק למסמך הבא
  if (!/_bvDocErr = null; _bvZoom = 0/.test(view)) throw new Error('ההסבר נדבק בין מסמכים');
  return true;
});

check('הוצאה כפולה — נבחרת זו שיש לה קובץ', () => {
  // אותו מסמך נפתח במסך הספקים ולא נפתח בלוח. הסיבה: שתי רשומות הוצאה לאותו
  // מסמך, והשורה מצביעה לזו שאין לה קובץ.
  const srv = fs.readFileSync('server.js', 'utf8');
  const i = srv.indexOf('const hasFileSrc =');
  const src = srv.slice(i, srv.indexOf('const out = eventBoard.boardByMonth'));
  const mine = [
    { id: 'pay_nofile', supplierName: 'פיש סאונד', number: '50032' },
    { id: 'pay_withfile', supplierName: 'פיש סאונד', number: '50032', localFileId: 'f1' },
    { id: 'pay_gi', supplierName: 'אחר', number: '777', giExpenseId: 'g1' },
  ];
  const normName = (x) => String(x || '').replace(/בע["'׳]?מ/g, '').replace(/\s+/g, ' ').trim();
  const find = new Function('mine', 'normName', `${src}\nreturn findPayable;`)(mine, normName);
  const row = { name: 'פיש סאונד', paidInvoice: '50032' };

  const better = find(row, mine[0]);
  if (!better || better.id !== 'pay_withfile') throw new Error('לא נבחרה הרשומה עם הקובץ: ' + (better && better.id));
  if (find(row, mine[1])) throw new Error('רשומה שיש לה קובץ הוחלפה שלא לצורך');
  const missing = find(row, null);
  if (!missing || missing.id !== 'pay_withfile') throw new Error('רשומה חסרה לא אותרה מחדש');
  // ספק שאין לו כפילות — לא מומצאת התאמה
  if (find({ name: 'לא קיים', paidInvoice: '' }, null)) throw new Error('נבחרה רשומה בלי בסיס');

  // והצד השני מפעיל את החיפוש גם כשהרשומה קיימת
  const eb = fs.readFileSync('eventBoard.js', 'utf8');
  const rd = eb.slice(eb.indexOf('export function rowDocs'), eb.indexOf('export function boardRows'));
  if (/if \(!p && typeof findPayable/.test(rd)) throw new Error('החיפוש רץ רק כשהרשומה חסרה');
  if (!/findPayable\(d, p\)/.test(rd)) throw new Error('הרשומה הנוכחית אינה מועברת לבחירה');
  return true;
});

check('כתובת קובץ של הוצאה — כל צורות השדה, ולא רק url', () => {
  // חשבונית ירוקה אינה עקבית בשם השדה בין סוגי רשומות. קריאה של url בלבד
  // החזירה "אין קובץ" גם כשהקובץ קיים תחת שם אחר.
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('function expenseFileUrl'), srv.indexOf('// GET /api/supplier-payables/:id/file'));
  const f = new Function(`${src}\nreturn expenseFileUrl;`)();
  const cases = [
    [{ url: 'https://a/b.pdf' }, 'https://a/b.pdf'],
    [{ url: { he: 'https://x/he.pdf' } }, 'https://x/he.pdf'],
    [{ file: 'https://y/f.pdf' }, 'https://y/f.pdf'],
    [{ files: [{ url: 'https://z/1.pdf' }] }, 'https://z/1.pdf'],
    [{ attachments: ['https://w/a.jpg'] }, 'https://w/a.jpg'],
    [{ documents: [{ link: 'https://q/d.pdf' }] }, 'https://q/d.pdf'],
    [{ url: '' }, null], [{ url: 'לא-כתובת' }, null], [{}, null], [null, null],
  ];
  for (const [input, want] of cases) {
    const got = f(input);
    if (got !== want) throw new Error(`${JSON.stringify(input)} → ${got} במקום ${want}`);
  }
  // וכשלא נמצאה כתובת, נרשם מה ההוצאה באמת החזירה
  const route = srv.slice(srv.indexOf("add('GET', /^\\/api\\/supplier-payables\\/([^/]+)\\/file$/"));
  if (!/Object\.keys\(e\)/.test(route.slice(0, 2500))) throw new Error('שדות ההוצאה אינם נרשמים כשאין כתובת');
  if (!/expenseFields/.test(route.slice(0, 3000))) throw new Error('השדות אינם מוחזרים בתשובה');
  return true;
});

check('כתובת שנטענת ישירות נושאת companyId', () => {
  // העטיפה שמזריקה companyId עוטפת את fetch בלבד. כתובת שנטענת ב-iframe או
  // בקישור הורדה עוקפת אותה, והשרת נופל לחברת ברירת המחדל — ומחפש את ההוצאה
  // של חברה אחת בחשבון של אחרת. כך אותו מסמך נפתח במסך אחד ולא באחר.
  const src = app.slice(app.indexOf('const bDocUrl ='), app.indexOf('let _bvOpen'));
  const fn = new Function('state', `${src}\nreturn bDocUrl;`)({ company: 'co_moshe' });
  const a = fn({ payableId: 'pay_1' });
  if (!/companyId=co_moshe/.test(a)) throw new Error('הוצאה בלי companyId: ' + a);
  if (!/^\/api\/supplier-payables\/pay_1\/file\?/.test(a)) throw new Error('כתובת שגויה: ' + a);
  const b = fn({ fileId: 'f 1' });
  if (!/companyId=co_moshe/.test(b)) throw new Error('קובץ בלי companyId: ' + b);
  if (!/f%201/.test(b)) throw new Error('מזהה הקובץ אינו מקודד: ' + b);
  // בלי חברה נבחרת — לא מוסיפים פרמטר ריק
  const none = new Function('state', `${src}\nreturn bDocUrl;`)({ company: '' })({ payableId: 'p' });
  if (/companyId/.test(none)) throw new Error('נוסף companyId ריק: ' + none);
  // הפרגמנט של הזום מגיע אחרי ה-query, אחרת הוא בולע אותו
  const view = app.slice(app.indexOf('let _bvEvent = null;'), app.indexOf('// הפקת מסמך לאירוע'));
  if (!/bDocUrl\(shown\.doc\)\}\$\{bDocFrag\(\)\}/.test(view)) throw new Error('סדר ה-query והפרגמנט שגוי');
  return true;
});

check('הפקת מסמך מהלוח — בחירת סוג, וקישור לאירוע', () => {
  // הסוג היה קבוע על חשבון עסקה, והמסמך שנוצר לא נקשר לאירוע — ולכן האירוע
  // המשיך להיראות כאילו לא הופקה עליו חשבונית.
  const issue = app.slice(app.indexOf('window.boardIssueDoc ='), app.indexOf('window.boardIssueDoc =') + 2200);
  if (!/boardEventId: ev\.id/.test(issue)) throw new Error('מזהה האירוע אינו נשמר בחלונית');

  // בורר הסוג מוצג רק כשהחלונית נפתחה מהלוח
  const rq = app.slice(app.indexOf('function renderNewQuote()'), app.indexOf('function renderNewQuote()') + 4000);
  if (!/\(e\.boardEventId \|\| e\.boardEventIds\) \?/.test(rq)) throw new Error('בורר הסוג אינו מותנה בפתיחה מהלוח');
  if (!/\[10, 300, 305, 320\]/.test(rq)) throw new Error('רשימת הסוגים אינה מלאה');
  if (!/nqSetType\(this\.value\)/.test(rq)) throw new Error('הבורר אינו מחליף סוג');

  // החלפת סוג שומרת את שאר השדות
  const setType = app.slice(app.indexOf('window.nqSetType ='), app.indexOf('window.nqSetPayTerms ='));
  if (!/nqSync\(\)/.test(setType)) throw new Error('החלפת סוג מאבדת את מה שהוזן');

  // שני מסלולי היצירה מקשרים לאירוע
  const links = (app.match(/\/api\/invoicing\/link'/g) || []).length;
  if (links < 2) throw new Error('רק ' + links + ' מסלולי יצירה מקשרים לאירוע');
  const create = app.slice(app.indexOf('window.createNewQuote'), app.indexOf('window.createNewQuote') + 6000);
  if (!/eventIds: _evIds/.test(create) && !/eventIds: _qIds/.test(create)) throw new Error('הקישור אינו משתמש במזהי האירועים');
  if (!/type: Number\(e\.type\)/.test(create)) throw new Error('סוג המסמך אינו מועבר לקישור');
  return true;
});

check('כפתורי פעולה בחלונית — נשברים לשורה במקום להיחתך', () => {
  // בעורך מסמך המשך עם פאנל מסמך מקור, שלושת הכפתורים דרשו כמעט בדיוק את
  // רוחב הטור. כל הבדל קטן בעיבוד הגופן דחף את כפתור ההפקה מחוץ לתצוגה,
  // ונשאר רק "ביטול".
  const rule = css.slice(css.indexOf('.modal-actions{'), css.indexOf('.modal-actions{') + 200);
  if (!/flex-wrap:\s*wrap/.test(rule)) throw new Error('שורת הפעולות אינה נשברת לשורה');
  // הכלל חייב להיות גלובלי ולא רק בפלאפון
  const mobileStart = css.indexOf('@media (max-width: 640px)');
  if (css.indexOf('.modal-actions{') > mobileStart) throw new Error('הכלל נמצא רק בתוך מדיה של פלאפון');
  // ופאנל המקור אינו בולע את הטור
  const der = app.slice(app.indexOf('const srcPane = (e.linked'), app.indexOf('const srcPane = (e.linked') + 200);
  const m = der.match(/flex:0 0 (\d+)%/);
  if (!m || Number(m[1]) > 42) throw new Error('פאנל המקור רחב מדי: ' + (m && m[1]));
  return true;
});

check('עורך מסמך המשך — כפתורי ההפקה נעוצים ותמיד על המסך', () => {
  // דווח שנשאר רק "ביטול". הכפתורים היו בתחתית תוכן נגלל, ולכן כל מצב שדחף
  // אותם מתחת לקיפול הסתיר אותם בלי שום רמז שהם קיימים.
  const der = app.slice(app.indexOf('function renderDeriveEditor'), app.indexOf('window.derPreviewPdf'));
  if (!/class="modal-card tall-form"/.test(der)) throw new Error('החלונית אינה מסומנת כגבוהה');
  if (!/<div class="tall-body">/.test(der)) throw new Error('אין אזור גלילה נפרד מהכפתורים');
  // הכפתורים מחוץ לאזור הגלילה
  const bodyEnd = der.indexOf('</div></div></div>');
  const actionsAt = der.indexOf('<div class="modal-actions">');
  if (bodyEnd < 0 || actionsAt < 0 || actionsAt < bodyEnd) throw new Error('שורת הפעולות בתוך אזור הגלילה');
  for (const b of ['derConfirmBtn', 'derPreviewPdf', 'ביטול']) {
    if (!der.slice(actionsAt).includes(b)) throw new Error('חסר כפתור: ' + b);
  }
  // תגיות מאוזנות — רמה נוספת כאן הייתה מפילה את כל החלונית
  const tpl = der.slice(der.indexOf('m.innerHTML = `'), der.indexOf('m.onclick'));
  const o = (tpl.match(/<div\b/g) || []).length, c = (tpl.match(/<\/div>/g) || []).length;
  if (o !== c) throw new Error(`div לא מאוזן בעורך: ${o} נפתחו, ${c} נסגרו`);
  return true;
});

check('מצב צפייה — חלונית בלי כפתורי פעולה מסבירה למה', () => {
  // משתמש צפייה מקבל display:none על כל כפתורי הפעולה. בחלונית זה הותיר את
  // "ביטול" לבדו, ונראה כאילו הכפתור להפקה נעלם מתקלה.
  const rule = css.slice(css.indexOf('.viewer-mode .btn.primary'), css.indexOf('.viewer-mode .btn.primary') + 700);
  if (!/\.viewer-mode \.modal-actions::before/.test(rule)) throw new Error('אין חיווי בחלונית במצב צפייה');
  if (!/מצב צפייה/.test(rule)) throw new Error('החיווי אינו מסביר שמדובר בהרשאה');
  // המחלקה נקבעת לפי התפקיד ולא לפי משהו אחר
  if (!/classList\.toggle\('viewer-mode', !isAdmin\)/.test(app)) throw new Error('מצב הצפייה אינו נגזר מהתפקיד');
  return true;
});

check('פרטי בנק נשמרים ללקוח ומוצעים בפעם הבאה', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const src = srv.slice(srv.indexOf('const clientBankKey ='), srv.indexOf('// GET /api/client-bank'));
  const f = new Function(`${src}\nreturn { clientBankKey, rememberClientBank };`)();
  const pay = [{ type: 4, price: 100, bankName: 'מזרחי', bankBranch: '550', bankAccount: '345488' }];

  const db = {};
  if (!f.rememberClientBank(db, 'co_moshe', { id: 'c1', name: 'מועצה' }, pay)) throw new Error('לא נשמר');
  const saved = db.clientBank.co_moshe['id:c1'];
  if (saved.bankAccount !== '345488' || saved.bankBranch !== '550') throw new Error('נשמר חלקית: ' + JSON.stringify(saved));
  // מזהה קודם לשם, כדי ששינוי שם לקוח לא ינתק את ההיסטוריה
  if (f.clientBankKey({ id: 'c1', name: 'אחר' }) !== 'id:c1') throw new Error('השם גובר על המזהה');
  if (f.clientBankKey({ name: 'רק שם' }) !== 'nm:רק שם') throw new Error('נפילה לשם לא עובדת');
  if (f.clientBankKey({}) !== null) throw new Error('לקוח ריק קיבל מפתח');

  // רק העברה בנקאית וצ'ק, ורק כשיש פרטים
  if (f.rememberClientBank({}, 'c', { id: 'x' }, [{ type: 1, price: 5 }])) throw new Error('מזומן נשמר');
  if (f.rememberClientBank({}, 'c', { id: 'x' }, [{ type: 4, price: 5 }])) throw new Error('תקבול בלי פרטים נשמר');
  if (f.rememberClientBank({}, 'c', { id: 'x' }, null)) throw new Error('בלי תקבולים נשמר');

  // בידוד בין חברות
  const db2 = {};
  f.rememberClientBank(db2, 'co_bpm', { id: 'c1' }, pay);
  if (db2.clientBank.co_moshe) throw new Error('נשמר לחברה הלא נכונה');

  // השמירה מופעלת בכל מסלול שמקבל תקבולים
  const calls = (srv.match(/rememberClientBank\(_d/g) || []).length;
  if (calls < 4) throw new Error('רק ' + calls + ' מסלולי הפקה שומרים פרטי בנק');

  // ההצעה ממלאת רק שדות ריקים — מה שהוזן ידנית גובר
  const fill = app.slice(app.indexOf('// פרטי הבנק האחרונים של הלקוח'), app.indexOf('if (opts.bankReceived != null)'));
  if (!/!String\(pay\[k\] \|\| ''\)\.trim\(\)/.test(fill)) throw new Error('ההצעה דורסת ערכים שהוזנו');
  if (!/\[2, 4\]\.includes\(Number\(pay\.type\)\)/.test(fill)) throw new Error('ההצעה חלה גם על סוגי תקבול שאינם בנק');
  if (!/bankSuggested/.test(app)) throw new Error('אין חיווי שהפרטים הושלמו אוטומטית');
  return true;
});

check('עמלות — הסרת השורה הראשונה ובחירת בסיס החישוב', () => {
  const rows = [{ role: 'קלידן', name: 'א', priceExVat: 2000 }, { role: 'מתופף', name: 'ב', priceExVat: 3000 }];
  const base = { price: 20000, contractorDetails: rows };   // הוצאות 5,000

  // ברירת מחדל — בדיוק כמו קודם: 15% מהמחיר ללקוח
  const d = boardMod.eventTotals(base);
  if (d.commissionEx !== 3000 || d.incomeEx !== 17000) throw new Error('ברירת המחדל השתנתה: ' + JSON.stringify(d));

  // בסיס "אחרי ההוצאות": 15% מ-15,000
  const net = boardMod.eventTotals({ ...base, commissionBase: 'net' });
  if (net.commissionEx !== 2250 || net.incomeEx !== 17750) throw new Error('בסיס אחרי הוצאות: ' + JSON.stringify(net));

  // הסרה — הפיכה, ואינה משנה את ברירת המחדל
  const off = boardMod.eventTotals({ ...base, commissionOff: true });
  if (off.commissionEx !== 0 || off.incomeEx !== 20000) throw new Error('ההסרה לא עבדה');
  if (off.commissions.length) throw new Error('שורת העמלה נותרה ברשימה');
  if (boardMod.eventTotals({ ...base, commissionOff: false }).commissionEx !== 3000) throw new Error('ההחזרה לא עובדת');
  if (boardMod.DEFAULT_COMMISSION_PCT !== 15) throw new Error('ברירת המחדל במערכת השתנתה');

  // עמלה נוספת עם בסיס משלה
  const mix = boardMod.eventTotals({ ...base, commissionOff: true, extraCommissions: [{ name: 'מפיק', pct: 10, base: 'net' }] });
  if (mix.commissionEx !== 1500) throw new Error('עמלה נוספת אחרי הוצאות: ' + mix.commissionEx);
  if (mix.commissions[0].base !== 'net') throw new Error('הבסיס אינו מוחזר לתצוגה');

  // סכום קבוע אינו מושפע מהבסיס
  for (const b of ['client', 'net']) {
    const f = boardMod.eventTotals({ ...base, commissionOff: true, extraCommissions: [{ name: 'x', amount: 700, base: b }] });
    if (f.commissionEx !== 700) throw new Error('סכום קבוע הושפע מהבסיס');
  }
  // הוצאות גדולות מהמחיר — הבסיס לא יורד מתחת לאפס
  const neg = boardMod.eventTotals({ price: 1000, commissionBase: 'net', contractorDetails: [{ role: 'x', name: 'y', priceExVat: 5000 }] });
  if (neg.commissionEx !== 0) throw new Error('בסיס שלילי יצר עמלה: ' + neg.commissionEx);

  // הממשק מחשב זהה לשרת
  const uiSrc = app.slice(app.indexOf('const BD_BASES ='), app.indexOf('function bdIncomeLine('));
  const ui = new Function(`const bRowEx=(r)=>Number(r.ex)||0; const bdCommPct=(e)=>{const v=e&&e.commissionPct; return (v===''||v==null||isNaN(Number(v)))?15:Math.min(100,Math.max(0,Number(v)));};\n${uiSrc}\nreturn bdCommList;`)();
  for (const fx of [base, { ...base, commissionBase: 'net' }, { ...base, commissionOff: true }]) {
    const e = { price: fx.price, commissionPct: fx.commissionPct, commissionOff: fx.commissionOff,
      commissionBase: fx.commissionBase, extraCommissions: [], rows: rows.map(r => ({ ex: r.priceExVat })) };
    const a = ui(e).reduce((x, c) => x + c.amount, 0);
    const b = boardMod.eventTotals(fx).commissionEx;
    if (Math.abs(a - b) > 0.01) throw new Error(`ממשק ${a} · שרת ${b}`);
  }

  // עריכה חוזרת לא מחזירה את שורה ראשונה: הפתיחה חייבת להעתיק את commissionOff
  // ואת הבסיס מהאירוע. בלעדיהם כל שמירה החזירה את העמלה שהוסרה.
  const init = app.slice(app.indexOf('_boardEdit = {'), app.indexOf('renderBoardEdit();', app.indexOf('_boardEdit = {')));
  if (!/commissionOff: !!\(ev && ev\.commissionOff\)/.test(init))
    throw new Error('commissionOff לא נטען לעריכה — שורה ראשונה תחזור בכל שמירה');
  if (!/commissionBase: \(ev && ev\.commissionBase === 'net'\)/.test(init))
    throw new Error('בסיס העמלה לא נטען לעריכה');
  // וכל שדות העמלה שנשמרים הם בדיוק אלה שנטענים — אחרת שדה חדש ייעלם באותו אופן
  const body = app.slice(app.indexOf('commissionOff: !!e.commissionOff'), app.indexOf('commissionOff: !!e.commissionOff') + 200);
  for (const f of ['commissionOff', 'commissionBase']) {
    if (!body.includes(f)) throw new Error('שדה שנשמר ואינו נטען: ' + f);
  }
  return true;
});

check('דוחות לוח האירועים — לאירוע ולחודש, נבנים בלי שגיאת ריצה', () => {
  const src = app.slice(app.indexOf('const _repMoney ='), app.indexOf('async function _boardPdf'));
  const stubs = `
    const escapeHtml=(x)=>String(x==null?'':x), ddmy=(d)=>String(d||''), todayIso=()=>'2026-09-17';
    const currentCompanyName=()=>'משה כורסיה';
    const SUP_DOC_NAMES={300:'חשבון עסקה',305:'חשבונית מס',320:'חשבונית מס-קבלה',400:'קבלה'};
    const SHORT_BILL={10:'הצעה',300:'עסקה',305:'מס',320:'מס-קבלה',400:'קבלה',330:'זיכוי'};
    const MONTHS_FULL=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const bMonthName=(k)=>{const [y,m]=String(k).split('-');return MONTHS_FULL[(+m)-1]+' '+y;};
  `;
  const fns = new Function(`${stubs}\n${src}\nreturn { boardEventReportHtml, boardMonthReportHtml, boardGroupReportHtml };`)();
  const ev = { id: 'e1', date: '2026-10-08', artist: 'בת מצווה', location: 'האחוזה', clientName: 'לקוח', notes: 'הערה',
    linkedDocs: [{ id: 'd1', number: 40468, type: 300 }],
    rows: [{ role: 'קלידן', name: 'דני', priceExVat: 1500, ex: 1500, inc: 1770, paid: false, note: 'מקדמה',
             docs: [{ type: 305, number: '50032' }] },
           { role: 'מתופף', name: 'רון', priceExVat: 1200, ex: 1200, inc: 1200, vatExempt: true, paid: true, docs: [] }],
    totals: { clientPriceEx: 20000, commissionEx: 3000, incomeEx: 17000, expenseEx: 2700, expenseInc: 2970,
      profitEx: 14300, unpaidRows: 1, commissions: [{ name: 'שורה ראשונה', pct: 15, base: 'client', amount: 3000 }] } };

  const one = fns.boardEventReportHtml(ev);
  for (const [pat, what] of [[/בת מצווה/, 'שם האירוע'], [/20,000/, 'מחיר ללקוח'], [/שורה ראשונה/, 'העמלה'],
      [/17,000/, 'תשלום למשה'], [/14,300/, 'רווח'], [/דני/, 'ספק'], [/50032/, 'מסמך ספק'], [/40468/, 'מסמך ללקוח'],
      [/פטור/, 'סימון עוסק פטור'], [/טרם שולם/, 'סטטוס תשלום']]) {
    if (!pat.test(one)) throw new Error('חסר בדוח האירוע: ' + what);
  }
  const o = (one.match(/<t(able|r|d|h|body|head|foot)\b/g) || []).length;
  if (!o) throw new Error('דוח האירוע ריק');

  const m = { month: '2026-10', clientPriceEx: 20000, commissionEx: 3000, incomeEx: 17000, expenseEx: 2700, profitEx: 14300, events: [ev] };
  const rep = fns.boardMonthReportHtml(m);
  for (const [pat, what] of [[/אוקטובר 2026/, 'שם החודש'], [/ריכוז ספקים/, 'ריכוז הספקים'],
      [/דני/, 'ספק ברשימה'], [/רון/, 'ספק שני'], [/1 אירועים|1 אירוע/, 'מספר האירועים']]) {
    if (!pat.test(rep)) throw new Error('חסר בדוח החודשי: ' + what);
  }
  // ריכוז הספקים מסכם נכון: דני 1,770 פתוח, רון שולם
  if (!/1,770/.test(rep)) throw new Error('סכום הספק אינו מופיע');
  if (!/✓ שולם/.test(rep)) throw new Error('ספק ששולם אינו מסומן');
  // הדוח בעברית — הכל מיושר לימין. text-align:left נראה זר בתוך טקסט עברי.
  const repSrc = app.slice(app.indexOf('const _repMoney ='), app.indexOf('async function _boardPdf'))
    + app.slice(app.indexOf('function evMonthReportHtml'), app.indexOf('window.evMonthReport ='));
  if (/text-align:\s*left/.test(repSrc)) throw new Error('נשארה עמודה מיושרת לשמאל בדוח');

  // חודש ריק אינו מפיל את הדוח
  const empty = fns.boardMonthReportHtml({ month: '2026-11', events: [] });
  if (!/אין ספקים בחודש זה/.test(empty)) throw new Error('חודש ריק אינו מטופל');

  // דוח לאירועים שנבחרו — אותו מקור, ולכן אותם מספרים
  const two = { ...ev, id: 'e2', artist: 'חתונה', totals: { ...ev.totals, clientPriceEx: 10000, commissionEx: 1500, incomeEx: 8500, expenseEx: 900, profitEx: 7600 } };
  const grp = fns.boardGroupReportHtml('דוח אירועים נבחרים', '2 אירועים', [ev, two]);
  if (!/דוח אירועים נבחרים/.test(grp)) throw new Error('כותרת הדוח הקבוצתי שגויה');
  if (!/30,000/.test(grp)) throw new Error('המחיר אינו מסוכם על פני האירועים');   // 20000 + 10000
  if (!/25,500/.test(grp)) throw new Error('התשלום אינו מסוכם');                   // 17000 + 8500
  if (!/21,900/.test(grp)) throw new Error('הרווח אינו מסוכם');                    // 14300 + 7600
  if (!/חתונה/.test(grp) || !/בת מצווה/.test(grp)) throw new Error('לא כל האירועים בטבלה');
  // הסיכומים נגזרים מהאירועים, ולכן דוח חודשי על אותם אירועים זהה
  const asMonth = fns.boardMonthReportHtml({ month: '2026-10', events: [ev, two] });
  for (const n of ['30,000', '25,500', '21,900']) if (!asMonth.includes(n)) throw new Error('דוח חודשי ודוח נבחרים התפצלו: ' + n);

  // פירוט עמלות בכל שורת אירוע — לא רק הסכום הכולל
  const withComm = { ...ev, totals: { ...ev.totals, commissionEx: 4500,
    commissions: [{ name: 'שורה ראשונה', pct: 15, base: 'client', amount: 3000 },
      { name: 'מפיק חיצוני', pct: 10, base: 'net', amount: 1500 }] } };
  const det = fns.boardGroupReportHtml('דוח אירועים נבחרים', '1 אירועים', [withComm]);
  if (!/שורה ראשונה 15%/.test(det)) throw new Error('שם ואחוז העמלה חסרים בשורת האירוע');
  if (!/מפיק חיצוני 10% \(לאחר הוצאות ספקים\)/.test(det)) throw new Error('עמלה נוספת או בסיס החישוב חסרים');
  if (/\(נטו\)/.test(det)) throw new Error('נשאר הניסוח "נטו" במקום "לאחר הוצאות ספקים"');
  if (!/3,000/.test(det) || !/1,500/.test(det)) throw new Error('סכומי העמלות אינם מפורטים');
  // אירוע בלי עמלה כלל — נאמר במפורש ולא נשאר תא ריק
  const noComm = fns.boardGroupReportHtml('x', 'y', [{ ...ev, totals: { ...ev.totals, commissionEx: 0, commissions: [] } }]);
  if (!/ללא עמלה/.test(noComm)) throw new Error('אירוע בלי עמלה אינו מסומן');
  return true;
});

// הדוח החודשי בלשונית האירועים (BPM/אופק) — פירוט לכל אירוע בלבד, בלי סיכומים
// חודשיים. ההוצאה היא תשלומי קבלנים ועלות עובדים, והסטטוס נגזר מ-evPayState.
check('דוח אירועים חודשי — פירוט לכל אירוע, ומחובר לכפתור בכותרת החודש', () => {
  const helpers = app.slice(app.indexOf('const _repMoney ='), app.indexOf('function boardEventReportHtml'));
  const src = app.slice(app.indexOf('const evShiftTotal ='), app.indexOf('window.evMonthReport ='));
  const stubs = `
    const escapeHtml=(x)=>String(x==null?'':x), ddmy=(d)=>String(d||''), todayIso=()=>'2026-09-19';
    const currentCompanyName=()=>'BPM', VAT_RATE=0.18;
    const MONTHS_HE=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const monthKeyLabel=(k)=>{const [y,m]=String(k).split('-');return MONTHS_HE[(+m)-1]+' '+y;};
    const SHORT_BILL={10:'הצעה',300:'עסקה',305:'מס',320:'מס-קבלה',400:'קבלה',330:'זיכוי'};
    const EV_PAY_LABEL={green:'שולם',yellow:'ממתין לתשלום',red:'ללא חשבונית',none:'ללא חיוב'};
    const EV_PAY_COLOR={green:'#0a7d33',yellow:'#b45309',red:'#b42318',none:'#6b7488'};
    const evLedQty=(e)=>(Number(e.ledMeters)||0)||((Number(e.ledPricePerMeter)||0)?1:0);
    const evGross=(e)=>(Number(e.price)||0)+(Number(e.priceLighting)||0)+((Number(e.ledPricePerMeter)||0)*evLedQty(e));
    const activeLinkedDocs=(e)=>(e.linkedDocs||[]).filter(d=>!d.credited&&!d.credit&&!d.converted);
    const evPayState=(e)=>e._state;
  `;
  const build = new Function(`${stubs}\n${helpers}\n${src}\nreturn evMonthReportHtml;`)();
  const ev = (o) => ({ id: 'e1', date: '2026-10-08', artist: 'זמר', location: 'אולם', clientName: 'לקוח', price: 10000,
    employees: ['דנה'], employeeDetails: [{ name: 'דנה', factor: 1.5, note: 'הגיעה מוקדם' }],
    contractorDetails: [{ name: 'סאונד בע״מ', amount: 2000, paid: false }],
    linkedDocs: [{ type: 320, number: 30268 }], _state: 'green', ...o });
  const second = ev({ id: 'e2', artist: 'זמרת', price: 5000, _state: 'red', linkedDocs: [], employees: [], employeeDetails: [],
    contractorDetails: [{ name: 'סאונד בע״מ', amount: 500, paid: true, paidSource: 'bank' }] });
  // משמרות כפי שהן חוזרות מ-/api/payroll: יומית וחצי מפורקת לתשלום + בונוס
  const shifts = new Map([['e1', [{ name: 'דנה', base: 800, bonus: 400, food: 50, travel: 30, factor: 1.5, factorLabel: 'יומית וחצי', note: 'הגיעה מוקדם' }]]]);

  const rep = build('2026-10', 'approved', [ev(), second], shifts);
  for (const [pat, what] of [[/אוקטובר 2026/, 'שם החודש'], [/אירועים מאושרים/, 'סוג הרשימה'],
      [/סאונד/, 'שם הקבלן'], [/מס-קבלה #30268/, 'מסמך החיוב'],
      [/דנה/, 'עובד'], [/יומית וחצי/, 'תווית היומית'], [/הגיעה מוקדם/, 'הערת המשמרת'],
      [/התאמת בנק/, 'מקור התשלום לקבלן']]) {
    if (!pat.test(rep)) throw new Error('חסר בדוח: ' + what);
  }
  // אין סיכומים חודשיים — הדוח הוא פירוט לאירועים בלבד
  for (const [pat, what] of [[/מצב החיוב/, 'פילוח מצב חיוב'], [/אירועי החודש/, 'טבלת סיכום חודשית'],
      [/ריכוז קבלנים/, 'ריכוז קבלנים'], [/>עלות עובדים</, 'שורת סיכום עלות עובדים'],
      [/סה״כ לאחר קבלנים/, 'שורת סיכום חודשית']]) {
    if (pat.test(rep)) throw new Error('נשאר סיכום כללי בדוח: ' + what);
  }
  // כרטיס נפרד לכל אירוע, כל אחד עם הקבלנים והעובדים שלו
  if ((rep.match(/class="pdf-keep"/g) || []).length !== 2) throw new Error('הפירוט אינו כרטיס נפרד לכל אירוע');
  if ((rep.match(/קבלנים \/ ספקים/g) || []).length !== 2) throw new Error('חסרה טבלת קבלנים באחד האירועים');
  if (!/אין עובדים באירוע זה/.test(rep)) throw new Error('אירוע בלי עובדים אינו מסומן ככזה');
  // הפירוק של יומית וחצי מגיע מהשכר ולא מחושב מחדש: 800 + 400 + 50 + 30 = 1,280
  if (!/1,280/.test(rep)) throw new Error('סה״כ המשמרת שגוי');
  if (!/טרם שולם/.test(rep) || !/✓ שולם/.test(rep)) throw new Error('סטטוס התשלום לקבלן חסר בפירוט');
  // "נותר" מוריד גם קבלנים וגם עובדים: 10,000 − 2,000 − 1,280 = 6,720
  if (!/6,720/.test(rep)) throw new Error('השורה התחתונה של האירוע אינה מורידה את עלות העובדים');
  // בלי נתוני שכר הדוח עדיין יוצא — עם העובדים, בלי הסכומים
  const noPay = build('2026-10', 'approved', [ev()], null);
  if (!/דנה/.test(noPay)) throw new Error('בלי שכר העובד נעלם לגמרי');
  if (!/ללא עלות עובדים/.test(noPay)) throw new Error('חסר חיווי שעלות העובדים אינה כלולה');
  // פירוק התמחור מופיע לכל אירוע, ורק הרכיבים שמולאו
  const led = build('2026-10', 'approved', [ev({ priceLighting: 1200, ledPricePerMeter: 300, ledMeters: 4 })], shifts);
  if (!/תאורה/.test(led) || !/מסך לד \(4מ׳\)/.test(led)) throw new Error('פירוק התמחור חסר');
  if (/סאונד <b>/.test(led)) throw new Error('רכיב תמחור ריק נדפס');
  // אירוע בלי קבלנים/עובדים לא מפיל את הדוח
  const bare = build('2026-11', 'pending', [{ id: 'e9', date: '2026-11-02', artist: 'א', price: 1000, _state: 'yellow' }], new Map());
  if (!/אירועים לאישור/.test(bare)) throw new Error('רשימת הלאישור אינה מסומנת');
  if (!/אין קבלנים באירוע זה/.test(bare)) throw new Error('אירוע בלי קבלנים אינו מסומן ככזה');
  if (!/נובמבר 2026/.test(bare)) throw new Error('חודש בלי קבלנים נשבר');

  // הכפתור בכותרת החודש קיים, בשני המצבים, ומחוץ ל-onclick שמקפל את החודש
  const grp = app.slice(app.indexOf('function eventsByMonthHtml'), app.indexOf('function hebPhon'));
  if (!/onclick="evMonthReport\('\$\{mode\}'/.test(grp)) throw new Error('כפתור הדוח חסר בכותרת החודש');
  if (!/_evMonthGroups\[_evmKey\(mode, k\)\] = list/.test(grp)) throw new Error('אירועי החודש לא נשמרים לדוח');
  const head = grp.slice(grp.indexOf('<div class="row-between"'), grp.indexOf('</div>\n        <span'));
  if (head.indexOf('evMonthReport') < head.indexOf('</h3>')) throw new Error('הכפתור בתוך הכותרת — לחיצה עליו תקפל את החודש');
  return true;
});

// חיתוך העמודים ב-PDF: html2canvas מרנדר הכל לתמונה אחת שנחתכת לפי גובה עמוד,
// ולכן כרטיס אירוע היה נחתך באמצע. עכשיו שבירה שנופלת בתוך גוש .pdf-keep
// מקצרת את העמוד, והגוש כולו יורד לעמוד הבא.
check('PDF — כרטיס אירוע אינו נחתך בין שני עמודים', () => {
  const src = app.slice(app.indexOf('async function _htmlToPdfBlob'), app.indexOf('function _blobToBase64'));
  if (!/querySelectorAll\('\.pdf-keep'\)/.test(src)) throw new Error('הגושים לא נאספים לפני הרינדור');
  if (!/getBoundingClientRect/.test(src)) throw new Error('הגושים לא נמדדים');

  // משחזרים את לוגיקת החיתוך בלבד, ומריצים אותה על גושים בגדלים שונים
  const loop = src.match(/const pagePx = [\s\S]*?\n    \}/);
  if (!loop) throw new Error('לולאת חיתוך העמודים לא נמצאה');
  const body = loop[0]
    .replace(/const c2 = document[\s\S]*?pdf\.addImage\([^;]*;/, 'out.push({ start: sPos, h: sliceH });')
    .replace(/if \(!first\) pdf\.addPage\(\);/, '');
  const run = (canvasH, keep, pageH = 1000, scale = 1) =>
    new Function('canvas', 'keep', 'pageH', 'scale', `const out=[];\n${body}\nreturn out;`)(
      { height: canvasH }, keep, pageH, scale);

  // גוש שמתחיל ב-900 ומסתיים ב-1400 — השבירה ב-1000 נופלת בתוכו
  const pages = run(2000, [{ start: 900, end: 1400 }]);
  if (pages[0].h !== 900) throw new Error('העמוד לא קוצר — הכרטיס עדיין נחתך');
  if (pages[1].start !== 900) throw new Error('העמוד הבא אינו מתחיל בתחילת הכרטיס');
  const covered = pages.reduce((a, p) => a + p.h, 0);
  if (covered !== 2000) throw new Error('החיתוך איבד או שכפל תוכן: ' + covered);

  // גוש שגבוה מעמוד שלם אין לאן להוריד — נחתך, ובלבד שלא ייווצרו עמודים ריקים
  const tall = run(3000, [{ start: 500, end: 2800 }]);
  if (tall[0].h !== 1000) throw new Error('גוש ענק גרם לקיצור עמוד מיותר');
  if (tall.some(p => p.h <= 0)) throw new Error('נוצר עמוד ריק');
  if (tall.reduce((a, p) => a + p.h, 0) !== 3000) throw new Error('תוכן אבד בגוש ענק');

  // בלי גושים כלל — התנהגות רגילה, עמודים מלאים
  const plain = run(2500, []);
  if (plain.length !== 3 || plain[0].h !== 1000) throw new Error('החיתוך הרגיל השתנה');
  return true;
});

check('איחוד אירועים לחשבונית אחת — אותו לקוח בלבד', () => {
  const src = app.slice(app.indexOf('let _boardSel = new Set();'), app.indexOf('window.boardIssueMulti'));
  let html = '';
  const stubs = `
    const escapeHtml=(x)=>String(x==null?'':x), money=(n)=>'₪'+n;
    let __h='';
    const document = { getElementById: () => ({ set innerHTML(v){ __h=v; }, get innerHTML(){ return __h; } }) };
    const $ = () => null;
    const renderEventsBoard = () => {};
    const window = {};
  `;
  const mk = (months, sel) => new Function('months', 'sel', `${stubs}
    let _board = { months };
    ${src}
    _boardSel = new Set(sel);
    renderBoardSelBar();
    return __h;`)(months, sel);

  const months = [{ month: '2026-10', events: [
    { id: 'a', clientName: 'לקוח א', totals: { incomeEx: 1000 } },
    { id: 'b', clientName: 'לקוח א', totals: { incomeEx: 2000 } },
    { id: 'c', clientName: 'לקוח ב', totals: { incomeEx: 500 } },
  ] }];

  if (mk(months, ['a'])) throw new Error('סרגל הוצג על אירוע בודד');
  const same = mk(months, ['a', 'b']);
  if (!/2 אירועים נבחרו/.test(same)) throw new Error('אין מונה בחירה');
  if (!/₪3000/.test(same)) throw new Error('הסכום אינו מסוכם: ' + same.slice(0, 200));
  if (!/boardIssueMulti/.test(same)) throw new Error('אין כפתור הפקה משותפת');

  const diff = mk(months, ['a', 'c']);
  if (/boardIssueMulti/.test(diff)) throw new Error('לקוחות שונים — הכפתור לא אמור להופיע');
  if (!/לקוחות שונים/.test(diff)) throw new Error('אין הסבר למה אי אפשר לאחד');

  // ההפקה בונה שורה לכל אירוע ומקשרת לכולם
  const iss = app.slice(app.indexOf('window.boardIssueMulti'), app.indexOf('window.boardIssueMulti') + 2000);
  if (!/boardEventIds: sorted\.map/.test(iss)) throw new Error('לא נשמרים כל מזהי האירועים');
  if (!/items: items/.test(iss) && !/items,/.test(iss)) throw new Error('אין שורה לכל אירוע');
  if (!/names\.length !== 1/.test(iss)) throw new Error('אין אכיפת אותו לקוח בהפקה');
  if (!/t\.incomeEx != null/.test(iss)) throw new Error('הסכום אינו לאחר עמלות');

  const create = app.slice(app.indexOf('window.createNewQuote'), app.indexOf('window.createNewQuote') + 7000);
  if (!/eventIds: _evIds/.test(create)) throw new Error('הקישור אינו כולל את כל האירועים');
  if (!/e\.boardEventIds \|\| \(e\.boardEventId/.test(create)) throw new Error('אין תאימות לאירוע בודד');
  return true;
});

check('השלמת שורה מהוצאות המערכת — ספק, סכום ושיוך', () => {
  // הסכומים הוזנו ידנית גם כשההוצאה כבר קיימת במערכת, ואז אותו מספר הוקלד
  // פעמיים ויכול להיות שונה בשני המקומות.
  const src = app.slice(app.indexOf('window.bdPickConfirm ='), app.indexOf('window.bdPickConfirm =') + 1400);
  if (!/amountExcludeVat/.test(src)) throw new Error('הסכום אינו נלקח ללא מע״מ');
  if (!/row\.payableId = x\.id/.test(src)) throw new Error('ההוצאה אינה מקושרת לשורה');
  // הוצאה בלי הפרדת מע"מ = עוסק פטור
  if (!/row\.vatExempt = true/.test(src)) throw new Error('הוצאה בלי מע״מ אינה מסומנת כפטור');

  // הנרמול בשרת שומר את השיוך ואינו מנתק קיים כשלא נשלח
  const eb = fs.readFileSync('eventBoard.js', 'utf8');
  const nr = eb.slice(eb.indexOf('export function normalizeRows'), eb.length);
  if (!/paidPayableId: \(r && r\.payableId\) \? String\(r\.payableId\) : \(old\.paidPayableId \|\| null\)/.test(nr))
    throw new Error('השיוך אינו נשמר, או שריק מנתק שיוך קיים');
  const prev = [{ role: 'סאונדמן', name: 'א', priceExVat: 100, paidPayableId: 'pay_old' }];
  const keep = boardMod.normalizeRows([{ role: 'סאונדמן', name: 'א', priceExVat: 120 }], prev);
  if (keep[0].paidPayableId !== 'pay_old') throw new Error('עריכה בלי בחירה ניתקה שיוך קיים');
  const set = boardMod.normalizeRows([{ role: 'סאונדמן', name: 'א', priceExVat: 120, payableId: 'pay_new', payableNumber: '77' }], prev);
  if (set[0].paidPayableId !== 'pay_new' || set[0].paidInvoice !== '77') throw new Error('בחירה חדשה לא נשמרה');

  // הראוט מסנן לפי חברה ומסמן מה כבר משויך
  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('GET', /^\\/api\\/event-board\\/expenses$/"), srv.indexOf("// POST /api/event-board —"));
  if (!/\(p\.companyId \|\| giCompanyId\(\)\) === cid/.test(route)) throw new Error('אין סינון לפי חברה');
  if (!/linked: used\.has/.test(route)) throw new Error('אין סימון להוצאה שכבר שויכה');
  // מיון לפי תאריך אמיתי (dd/mm/yy אינו ממוין כמחרוזת) וקיבוץ לפי שנה בתצוגה
  if (!/dkey\(b\.date\)\.localeCompare\(dkey\(a\.date\)\)/.test(route)) throw new Error('הרשימה אינה ממוינת מהתאריך החדש לישן');
  if (!/year: dkey\(x\.date\)\.slice\(0, 4\)/.test(route)) throw new Error('אין שדה שנה לקיבוץ');
  const dk = new Function('d', `
    const x = String(d || '').trim();
    let m = x.match(/^(\\d{2})\\/(\\d{2})\\/(\\d{2,4})/);
    if (m) return \`\${m[3].length === 2 ? '20' + m[3] : m[3]}-\${m[2]}-\${m[1]}\`;
    return /^\\d{4}-\\d{2}-\\d{2}/.test(x) ? x.slice(0, 10) : '0000-00-00';`);
  const order = ['03/10/25', '10/05/26', '11/05/25'].sort((a, b) => dk(b).localeCompare(dk(a)));
  if (order[0] !== '10/05/26' || order[2] !== '11/05/25') throw new Error('מיון התאריכים שגוי');
  const grp = app.slice(app.indexOf('function bdlByYear'), app.indexOf('function renderBdLink'));
  const byYear = new Function('list', `${grp} return bdlByYear(list);`);
  const g = byYear([{ year: '2025' }, { year: '2026' }, { year: '' }, { year: '2026' }]);
  if (g[0][0] !== '2026' || g[0][1].length !== 2 || g[1][0] !== '2025' || g[2][0] !== 'ללא תאריך')
    throw new Error('הקיבוץ לפי שנים אינו מהחדשה לישנה');

  // כפתור הדוח לנבחרים קיים בכותרת כל חודש
  const mp = app.slice(app.indexOf('function boardSelBtns'), app.indexOf('window.boardSetYear'));
  if (!/boardSelectedReport\(this\)/.test(mp)) throw new Error('אין כפתור דוח לנבחרים בכותרת החודש');
  if (!/boardIssueMulti\(this\)/.test(mp)) throw new Error('אין כפתור מסמך משותף בכותרת החודש');
  if (!/boardSelBtns\(\)/.test(app.slice(app.indexOf('function boardMonthPanel'), app.indexOf('window.boardSetYear'))))
    throw new Error('הכפתורים אינם מוצגים בכותרת החודש');
  return true;
});

check('התראת החיוב — "טופל" לאירוע בודד ולכל אירועי הלקוח', () => {
  // "טופל" מוריד אירוע מההתראה בלי לגעת במסמכים שלו, והסימון הפיך.
  const srv = fs.readFileSync('server.js', 'utf8');
  const fn = srv.slice(srv.indexOf('function billingDue(db, cid, today)'), srv.indexOf("// GET /api/billing-due —"));
  if (!/if \(ev\.billingHandled\)/.test(fn)) throw new Error('אירוע שסומן כטופל עדיין נספר בהתראה');
  if (!/handled\.push/.test(fn)) throw new Error('הטופלו אינם נשמרים להחזרה');
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/billing-due\\/handled$/"), srv.indexOf('// GET /api/billing-due/diag'));
  if (!route) throw new Error('אין ראוט לסימון "טופל"');
  if (!/ownedBy\(ev, cid\)/.test(route)) throw new Error('הראוט אינו בודק בעלות חברה');
  if (!/b\.eventId/.test(route) || !/b\.client/.test(route)) throw new Error('חסר סימון לאירוע בודד או ללקוח שלם');
  if (!/billKey\(b\.client\)/.test(route)) throw new Error('הלקוח אינו מזוהה לפי המפתח המנורמל');
  if (!/on && !ev\.billingHandled/.test(route) || !/!on && ev\.billingHandled/.test(route)) throw new Error('הסימון אינו הפיך');
  // הכפתורים בחלונית
  const modal = app.slice(app.indexOf('window.openBillDue = async'), app.indexOf('window.billDueGo'));
  if (!/billDueHandled\('\$\{escAttr\(e\.id\)\}',1\)/.test(modal)) throw new Error('אין כפתור "טופל" לאירוע בודד');
  if (!/billDueHandledClient\(/.test(modal)) throw new Error('אין כפתור "טופל" לכל אירועי הלקוח');
  if (!/billDueHandled\('\$\{escAttr\(e\.id\)\}',0\)/.test(modal)) throw new Error('אין אפשרות להחזיר אירוע שסומן');
  return true;
});

check('הסרת עמלת השורה הראשונה נשמרת מיד באירוע קיים', () => {
  // ההסרה נשמרה רק ב"שמירה", ולכן סגירת החלונית אחריה החזירה את העמלה.
  const src = app.slice(app.indexOf('window.bdPrimaryComm ='), app.indexOf('window.bdExtraAdd') > 0 ? app.indexOf('window.bdExtraAdd') : app.indexOf('window.bdPrimaryComm =') + 1600);
  if (!/fetch\('\/api\/event-board'/.test(src)) throw new Error('ההסרה אינה נשמרת בשרת');
  if (!/boardEditBody\(_boardEdit\)/.test(src)) throw new Error('ההסרה אינה שולחת את אותו גוף כמו השמירה');
  if (!/if \(!_boardEdit\.id\) return/.test(src)) throw new Error('אירוע חדש נשמר לפני שנוצר');
  // אותו גוף בשני המסלולים — אחרת אחד ישלח commissionOff והשני לא
  if (!/function boardEditBody/.test(app)) throw new Error('גוף השמירה לא חולץ לפונקציה משותפת');
  const save = app.slice(app.indexOf('window.boardSave = async'), app.indexOf('window.boardDelete ='));
  if (!/const body = boardEditBody\(e\)/.test(save)) throw new Error('השמירה אינה משתמשת בגוף המשותף');
  const body = new Function('e', `${app.slice(app.indexOf('function boardEditBody'), app.indexOf('window.boardSave = async'))} return boardEditBody(e);`);
  const b = body({ id: 'ev1', date: '2026-04-21', price: 10000, commissionPct: 15, commissionOff: true, rows: [] });
  if (b.commissionOff !== true) throw new Error('ההסרה אינה נשלחת לשרת');
  return true;
});

check('ניתוק מסמך משורה מחזיר את הסטטוס ל"טרם שולם"', () => {
  // "שולם" נגזר מהקישור לתנועת בנק. כשהמסמך מנותק אין עוד עדות תשלום, ולכן
  // הסטטוס חייב לחזור — קודם הוא נשאר "שולם" כי האיפוס דרש שיישאר קישור.
  const srv = fs.readFileSync('server.js', 'utf8');
  const fn = srv.slice(srv.indexOf('function applyBankSupplierPayments'), srv.indexOf("// GET /api/supplier-payables?all="));
  if (/c\.paidSource !== 'manual' && hasLink/.test(fn)) throw new Error('האיפוס עדיין מותנה בקיום קישור');
  if (!/c\.paidSource === 'bank' \|\| hasLink/.test(fn)) throw new Error('סימון שמקורו בבנק אינו מתאפס בניתוק');
  if (!/c\.paidSource !== 'manual'/.test(fn)) throw new Error('סימון ידני אינו מוגן');
  const route = srv.slice(srv.indexOf("add('DELETE', /^\\/api\\/event-board\\/([^/]+)\\/row\\/(\\d+)\\/doc\\/([^/]+)$/"),
    srv.indexOf("add('DELETE', /^\\/api\\/event-board\\/([^/]+)$/"));
  if ((route.match(/recomputeRowPayment\(db, cid, r\.row\)/g) || []).length !== 2)
    throw new Error('הניתוק אינו מחשב מחדש את סטטוס התשלום בשני המסלולים');
  if (!/function recomputeRowPayment/.test(srv)) throw new Error('חסרה פונקציית החישוב מחדש');
  return true;
});

check('פעולות הבחירה — אותו תנאי בסרגל ובכותרות החודשים', () => {
  // שני מקומות שמציעים את אותה פעולה חייבים להיגזר מאותו מצב, אחרת אחד יאפשר
  // מה שהשני חוסם.
  const src = app.slice(app.indexOf('function boardSelState()'), app.indexOf('window.boardToggleSel'));
  const st = new Function('months', 'sel', `
    let _board = { months };
    let _boardSel = new Set(sel);
    ${src}
    return boardSelState();`);
  const months = [{ month: '2026-10', events: [
    { id: 'a', clientName: 'לקוח א', totals: { incomeEx: 1000 } },
    { id: 'b', clientName: 'לקוח א', totals: { incomeEx: 2000 } },
    { id: 'c', clientName: 'לקוח ב', totals: { incomeEx: 500 } },
  ] }];
  const one = st(months, ['a']);
  if (one.canReport || one.canMerge) throw new Error('אירוע בודד מאפשר פעולה');
  if (!/סמן שני אירועים/.test(one.why)) throw new Error('אין הסבר לאירוע בודד');

  const same = st(months, ['a', 'b']);
  if (!same.canMerge || !same.canReport) throw new Error('אותו לקוח — שתי הפעולות אמורות להיות פתוחות');
  if (same.total !== 3000 || same.clientName !== 'לקוח א') throw new Error('סיכום שגוי: ' + JSON.stringify(same));

  const diff = st(months, ['a', 'c']);
  if (diff.canMerge) throw new Error('לקוחות שונים — איחוד אמור להיחסם');
  if (!diff.canReport) throw new Error('לקוחות שונים — דוח עדיין אמור להיות אפשרי');
  if (!/לקוחות שונים/.test(diff.why)) throw new Error('אין הסבר ללקוחות שונים');

  // שני המקומות נשענים על אותה פונקציה
  const bar = app.slice(app.indexOf('function renderBoardSelBar'), app.indexOf('window.boardIssueMulti'));
  const btns = app.slice(app.indexOf('function boardSelBtns'), app.indexOf('function boardMonthPanel'));
  for (const [blk, what] of [[bar, 'הסרגל'], [btns, 'כותרת החודש']]) {
    if (!/boardSelState\(\)/.test(blk)) throw new Error(what + ' אינו נגזר מהמצב המשותף');
  }
  if (/names\.length === 1/.test(bar)) throw new Error('הסרגל מחשב את התנאי בעצמו');
  return true;
});

check('חיפוש הוצאות — רץ בשרת על כל הרשומות, לא על רשימה חתוכה', () => {
  // החיפוש סינן את 80 הרשומות שכבר נטענו, ולכן מסמך ישן יותר לא היה ניתן
  // למציאה כלל — וזו בדיוק הסיבה לחפש.
  const ui = app.slice(app.indexOf('window.bdPickSearch ='), app.indexOf('function renderBdPick'));
  if (!/bdPickFetch\(\)/.test(ui)) throw new Error('החיפוש אינו פונה לשרת');
  if (!/setTimeout/.test(ui)) throw new Error('אין השהיה — כל תו ישלח בקשה');
  const render = app.slice(app.indexOf('function renderBdPick'), app.indexOf('window.bdPickConfirm'));
  if (/\.filter\(x => !q/.test(render)) throw new Error('עדיין מסנן מקומית על רשימה חתוכה');
  if (!/bdPickQ/.test(render)) throw new Error('שדה החיפוש בלי מזהה');
  if (!/inp\.focus\(\)/.test(render)) throw new Error('המיקוד אובד והקלדה נקטעת');

  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('GET', /^\\/api\\/event-board\\/expenses$/"), srv.indexOf("// POST /api/event-board —"));
  // חיפוש גובר על סינון הספק
  if (!/term \? true :/.test(route)) throw new Error('החיפוש אינו גובר על סינון הספק');
  // ותקרה גבוהה יותר בחיפוש
  if (!/slice\(0, term \? 200 : 80\)/.test(route)) throw new Error('תקרת החיפוש זהה לתקרת הרשימה');
  // שדות החיפוש כוללים תאריך וסכום
  for (const f of ['p.description', 'p.date', 'String(p.amount)']) {
    if (!route.includes(f)) throw new Error('החיפוש אינו כולל: ' + f);
  }
  return true;
});

check('שיוך מסמך ספק — מציג הכול עם סיבה, ולא "לא נמצאו הוצאות"', () => {
  // הרשימה סוננה לפי שם הספק ולפי סוגי המסמך המותרים, בלי חיפוש ובלי הסבר.
  // מסמך בסוג שאינו מתאים לסוג העוסק פשוט "לא נמצא", ולא היה רמז למה.
  const src = app.slice(app.indexOf('window.bDocLink = async'), app.indexOf('window.bdLinkConfirm'));
  if (!/api\(`\/api\/event-board\/expenses\?/.test(src)) throw new Error('אינו משתמש בראוט עם החיפוש');
  if (!/bdLinkSearch/.test(src)) throw new Error('אין חיפוש');
  if (!/setTimeout\(\(\) => bdLinkFetch\(\), 280\)/.test(src)) throw new Error('החיפוש בלי השהיה');
  // מסמך שאינו מתאים מוצג ומנוטרל, עם הסבר — במקום להיעלם
  if (!/סוג שאינו מתאים ל/.test(src)) throw new Error('אין הסבר למסמך שאינו מתאים');
  if (!/\$\{ok\(x\) \? '' : 'disabled'\}/.test(src)) throw new Error('מסמך שאינו מתאים אינו מנוטרל');
  if (!/ניתן לשייך/.test(src)) throw new Error('לא מוצג אילו סוגים מותרים');
  // מוצע גם מוצא: העלאת קובץ
  if (!/bDocUpload\(/.test(src)) throw new Error('אין מוצא כשאין מסמך מתאים');
  // בחירת מסמך מרחיבה את החלונית הקיימת ומציגה אותו — ולא פותחת חלונית חדשה
  const prev = app.slice(app.indexOf('window.bdLinkPreview'), app.indexOf('function renderBdLink'));
  if (!prev) throw new Error('bdLinkPreview לא נמצאה');
  if (!/if \(!already\) renderBdLink\(\);/.test(prev)) throw new Error('המעבר לרוחב הכפול אינו חד-פעמי');
  if (!/bdLinkRenderDoc\(\)/.test(prev)) throw new Error('החלפת מסמך אינה מרנדרת מחדש את הפאנל');
  if (/document\.createElement\('div'\)[^;]*modal/.test(prev)) throw new Error('נפתחת חלונית חדשה במקום הרחבה');
  const ren = app.slice(app.indexOf('function renderBdLink'), app.indexOf('function bdLinkSetItems') + 1 || app.indexOf('window.bdLinkConfirm'));
  if (!/id="bdlDocPane"/.test(ren)) throw new Error('אין פאנל תצוגה בחלונית');
  if (!/onchange="bdLinkPreview\(/.test(ren)) throw new Error('בחירה אינה מפעילה תצוגה מקדימה');
  if (!/st\.pick === x\.id \? ' checked' : ''/.test(ren)) throw new Error('הבחירה אובדת ברינדור מחדש');
  // חיפוש חדש מנקה בחירה שאינה ברשימה
  if (!/st\.pick && !st\.items\.some/.test(app)) throw new Error('בחירה ישנה נשארת אחרי חיפוש');
  // ומיקוד החיפוש נשמר
  if (!/inp\.focus\(\)/.test(src)) throw new Error('המיקוד אובד וההקלדה נקטעת');
  return true;
});

// הסוכן מריץ פעולות אמיתיות, ולכן שתי הבדיקות כאן אינן על טקסט אלא על הגדרות
// ההרשאה והבידוד: כלי כותב שנחשף בטעות למשתמש צפייה, או כלי שקורא אירועים בלי
// סינון חברה, הם באג שמדליף או משנה נתונים.
check('סוכן AI — כלים כותבים רק למנהל, וכל כלי רואה חברה אחת בלבד', async () => {
  const agent = await import('./aiAgent.js');
  const names = agent.AGENT_TOOLS.map(t => t.name);
  for (const t of ['search_events', 'event_details', 'open_documents', 'find_client', 'create_quote', 'send_document'])
    if (!names.includes(t)) throw new Error('כלי חסר: ' + t);
  // אין כלי שמפיק מסמך מס — הצעת מחיר בלבד
  const src = fs.readFileSync('aiAgent.js', 'utf8');
  if (/type:\s*(305|320|300)\b/.test(src)) throw new Error('הסוכן יכול להפיק מסמך מס');
  if (!/type:\s*10\b/.test(src)) throw new Error('הפקת הצעת המחיר לא נמצאה');
  // כל כלי קורא-אירועים עובר דרך companyEvents (סינון חברה), לא דרך db.events
  if (/\bdb\.events\b/.test(src)) throw new Error('קריאה ישירה ל-db.events — בלי סינון חברה');
  if (!/companyEvents\(load\(\), companyId\)/.test(src)) throw new Error('אירועים נקראים בלי companyId');

  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/agent\\/chat$/"), srv.indexOf('// ---- הצעות מחיר שחויבו'));
  if (!route) throw new Error('ראוט הסוכן לא נמצא');
  if (!/reqCompany\(q, b\)/.test(route)) throw new Error('הראוט אינו נוגזר מ-reqCompany');
  if (!/req\.user && req\.user\.role === 'admin'/.test(route)) throw new Error('הרשאת הכתיבה אינה נגזרת מתפקיד המשתמש');
  if (!/allowWrites: isAdmin/.test(route)) throw new Error('הרשאת הכתיבה אינה מועברת לסוכן');
  if (!/withCompany\(cid,/.test(route)) throw new Error('הכלים רצים מחוץ להקשר החברה — חשבונית ירוקה תפנה לחברה הלא נכונה');

  // allowWrites=false באמת מסתיר את הכלים הכותבים מהמודל
  const loop = src.slice(src.indexOf('export async function runAgent'), src.indexOf('export default'));
  if (!/AGENT_TOOLS\.filter\(t => allowWrites \|\| !WRITE_TOOLS\.has\(t\.name\)\)/.test(loop))
    throw new Error('כלים כותבים נשלחים למודל גם בלי הרשאה');
  // וגם נחסמים בהרצה — הגנה שנייה, למקרה שהמודל ינחש שם כלי
  if (!/WRITE_TOOLS\.has\(c\.name\) && !allowWrites/.test(loop)) throw new Error('אין חסימה בהרצת הכלי עצמו');
  // גדר מול לולאת כלים אינסופית
  if (!/MAX_ROUNDS/.test(loop)) throw new Error('אין תקרת סיבובים — מודל תקוע ישרוף תקציב');

  // תצוגה מקדימה אינה יוצרת מסמך, ולכן אינה כלי כותב
  if (/WRITE_TOOLS = new Set\(\[[^\]]*preview_quote/.test(src)) throw new Error('התצוגה המקדימה סומנה ככלי כותב');
  // ה-PDF לא נכנס לתשובת הכלי — הוא היה תופח את ההקשר בכל סיבוב
  const prev = src.slice(src.indexOf('async preview_quote'), src.indexOf('async create_quote'));
  const ret = prev.slice(prev.indexOf('return { ok: true, preview: true'));
  if (!ret) throw new Error('תשובת ההצלחה של התצוגה המקדימה לא נמצאה');
  if (/base64|pdfBase64/.test(ret)) throw new Error('ה-PDF מוחזר למודל');
  if (!/previewUrl/.test(ret)) throw new Error('אין קישור לתצוגה המקדימה');

  // ההנחיה לשאול כשחסר מידע, ולא להפיק על סמך ניחוש
  const sys = src.slice(src.indexOf('function systemPrompt'), src.indexOf('export async function runAgent'));
  for (const [pat, what] of [[/כשחסר מידע — תשאל/, 'ההנחיה לשאול'], [/אל תמציא/, 'האיסור להמציא'],
      [/הכלל המחמיר/, 'הכלל לפני הפקה'], [/preview_quote, לא create_quote/, 'העדפת תצוגה מקדימה']]) {
    if (!pat.test(sys)) throw new Error('חסר בהנחיות: ' + what);
  }
  return true;
});

// "צור הכנסה" בבנק עם קבלה שמופקת מחשבונית קיימת: לשורה צורפה רק הקבלה,
// והחשבונית שהיא מתעדת נעדרה. הסכום חייב להיספר פעם אחת — ולכן קינון ולא שתי שורות.
check('התאמת בנק — קבלה שהופקה מחשבונית מצרפת גם אותה, מקוננת', () => {
  const src = app.slice(app.indexOf('async function linkDocToBankTx'), app.indexOf('// ============ סימון טופל'));
  const body = src.replace(/const r = await fetch[\s\S]*?\n\}/, 'return matched;\n}');
  const mk = (existing) => new Function('_bankList', 'JSONSAFE',
    body + '; return linkDocToBankTx;')([{ id: 'tx1', matchedInvoices: existing }]);

  const receipt = { id: 'r1', number: 80095, type: 400, clientName: 'לקוח', amount: 11800, url: '/r' };
  const invoice = { id: 'i1', number: 50425, type: 305, clientName: 'לקוח', amount: 11800, url: '/i' };

  // המקרה שנשבר: החשבונית עדיין לא משויכת לשורה
  const a = mk([])('tx1', receipt, 'i1', invoice);
  return Promise.resolve(a).then((m) => {
    if (m.length !== 1) throw new Error('נוצרו שתי שורות — הסכום ייספר פעמיים: ' + m.length);
    if (Number(m[0].type) !== 305 || m[0].number !== 50425) throw new Error('החשבונית לא צורפה לשורה');
    if (!m[0].receipt || m[0].receipt.number !== 80095) throw new Error('הקבלה אינה מקוננת תחת החשבונית');
    if (m[0].amount !== 11800) throw new Error('סכום החשבונית שגוי');

    // כשהחשבונית כבר משויכת — ההתנהגות הישנה נשמרת
    return mk([{ ...invoice }])('tx1', receipt, 'i1', invoice);
  }).then((m2) => {
    if (m2.length !== 1) throw new Error('החשבונית שוכפלה');
    if (!m2[0].receipt) throw new Error('הקבלה לא קוננה תחת חשבונית קיימת');

    // מסמך שאינו קבלה — נוסף כשורה עצמאית, בלי קינון
    return mk([])('tx1', { id: 'd2', number: 40468, type: 300, amount: 5000 }, 'i1', invoice);
  }).then((m3) => {
    if (m3.length !== 1 || Number(m3[0].type) !== 300) throw new Error('מסמך שאינו קבלה טופל כקבלה');
    if (m3[0].receipt) throw new Error('נוצר קינון למסמך שאינו קבלה');

    // בלי פרטי מקור — לא ממציאים חשבונית, מצרפים את הקבלה בלבד
    return mk([])('tx1', receipt, null, null);
  }).then((m4) => {
    if (m4.length !== 1 || Number(m4[0].type) !== 400) throw new Error('בלי מקור — הקבלה לא צורפה');

    // הקריאה מהבנק מעבירה את פרטי המקור, אחרת כל התיקון לא נכנס לפעולה
    const call = app.slice(app.indexOf('if (_derBankLink && r.doc)'), app.indexOf('if (_derBankLink && r.doc)') + 900);
    if (!/linkDocToBankTx\(_derBankLink\.txId, entry, _derBankLink\.sourceId \|\| e\.id, \{/.test(call))
      throw new Error('הקריאה מהבנק אינה מעבירה את מסמך המקור');
    if (!/srcNumber|srcType|srcAmount/.test(call)) throw new Error('פרטי מסמך המקור אינם מועברים');
    if (!/srcType: Number\(r\.srcType\)/.test(app)) throw new Error('פרטי המקור אינם נשמרים בעורך');
    return true;
  });
});

// מועד החיוב הוא חשבון תאריכים, ושם נופלות שגיאות של יום אחד בשקט. בדיקה על
// גבולות חודש, שנה וחודש קצר — ועל כך ששום דבר כאן אינו מפיק מסמך.
check('מועד חיוב — סוף חודש מול יום אחרי, וההתראה על מה שטרם הוצא', () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const block = srv.slice(srv.indexOf('const BILL_MONTH_END'), srv.indexOf("// GET /api/billing-due"));
  const mk = (list, events) => new Function('load', 'save', 'ownedBy', 'normName', 'isNoInvoice', 'eventTotal',
    block + '; return { billingDue, billDueDate, billModeFor, lastDayOfMonth, addDays };')(
    () => ({ clientBilling: { c: list }, events }), () => {}, () => true,
    (s) => String(s || '').replace(/["'׳״`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(),
    (ev) => Boolean(ev.noInvoice), (ev) => Number(ev.price) || 0);

  const ME = [{ name: 'אבי גואטה הפקות בע״מ', mode: 'monthEnd' }];
  const f = mk(ME, []);
  // סוף חודש — גם בחודש קצר, גם בפברואר מעוברת, גם בסוף שנה
  if (f.lastDayOfMonth('2026-09-10') !== '2026-09-30') throw new Error('סוף ספטמבר שגוי');
  if (f.lastDayOfMonth('2026-02-03') !== '2026-02-28') throw new Error('סוף פברואר שגוי');
  if (f.lastDayOfMonth('2024-02-03') !== '2024-02-29') throw new Error('שנה מעוברת שגויה');
  if (f.lastDayOfMonth('2026-12-01') !== '2026-12-31') throw new Error('סוף דצמבר שגוי');
  // יום אחרי — כולל מעבר חודש ושנה
  if (f.addDays('2026-09-10', 1) !== '2026-09-11') throw new Error('יום אחרי שגוי');
  if (f.addDays('2026-09-30', 1) !== '2026-10-01') throw new Error('מעבר חודש שגוי');
  if (f.addDays('2026-12-31', 1) !== '2027-01-01') throw new Error('מעבר שנה שגוי');

  const db = () => ({ clientBilling: { c: ME } });
  // שם שנראה זהה אך נבדל בתו בלתי נראה או בווריאנט מרכאות — חייב להיתפס.
  // זה מה ששבר את השיוך בפועל: הלקוח הופיע כ"יום אחרי האירוע" אף שהיה ברשימה.
  for (const [what, name] of [
    ['גרשיים עברי', 'אבי גואטה הפקות בע״מ'],
    ['מרכאות ASCII', 'אבי גואטה הפקות בע"מ'],
    ['מרכאות טיפוגרפיות', 'אבי גואטה הפקות בע”מ'],
    ['סימן כיווניות RLM', 'אבי גואטה הפקות בע״מ‏'],
    ['LRM בהתחלה ורווח בסוף', '‎אבי גואטה הפקות בע״מ '],
    ['בלי מרכאות כלל', 'אבי גואטה הפקות בעמ'],
    ['רווח כפול', 'אבי גואטה  הפקות בע״מ'],
  ]) {
    if (f.billModeFor(db(), 'c', name) !== 'monthEnd') throw new Error('לא זוהה ברשימה: ' + what);
  }
  if (f.billModeFor(db(), 'c', 'לקוח אחר') !== 'nextDay') throw new Error('ברירת המחדל אינה יום אחרי');
  if (f.billModeFor(db(), 'c', 'אבי גואטה') !== 'nextDay') throw new Error('שם חלקי נחשב התאמה');

  const ev = (o) => ({ id: 'e', companyId: 'c', confirmed: true, date: '2026-09-10', artist: 'זמר',
    clientName: 'לקוח רגיל', price: 10000, linkedDocs: [], ...o });
  const due = (evs, today) => mk(ME, evs).billingDue({ clientBilling: { c: ME }, events: evs }, 'c', today);

  // לקוח רגיל: ביום האירוע עוד לא, למחרת כן
  if (due([ev()], '2026-09-10').total !== 0) throw new Error('התראה ביום האירוע עצמו');
  if (due([ev()], '2026-09-11').total !== 1) throw new Error('אין התראה יום אחרי האירוע');
  if (due([ev()], '2026-09-20').groups[0].lateDays !== 9) throw new Error('חישוב האיחור שגוי');

  // לקוח סוף-חודש: לא למחרת, כן ב-30 בחודש
  const me = ev({ clientName: 'אבי גואטה הפקות בע״מ' });
  if (due([me], '2026-09-11').total !== 0) throw new Error('לקוח סוף-חודש קיבל התראה יום אחרי');
  if (due([me], '2026-09-30').total !== 1) throw new Error('לקוח סוף-חודש לא קיבל התראה ביום האחרון');

  // כמה אירועים של אותו לקוח סוף-חודש מתקבצים לשורה אחת, עם הסכום המצטבר
  const g = due([me, ev({ id: 'e2', date: '2026-09-22', clientName: 'אבי גואטה הפקות בע״מ', price: 5000 })], '2026-09-30');
  if (g.clients !== 1 || g.total !== 2) throw new Error('אירועי אותו לקוח לא קובצו');
  if (g.groups[0].total !== 15000) throw new Error('הסכום המצטבר שגוי');

  // סדר כרונולוגי: אירועים בתוך לקוח, ולקוחות לפי האירוע הוותיק שלהם
  const mixed = due([
    ev({ id: 'x1', date: '2026-08-20', clientName: 'לקוח ב' }),
    ev({ id: 'x2', date: '2026-07-05', clientName: 'לקוח א' }),
    ev({ id: 'x3', date: '2026-06-11', clientName: 'לקוח ב' }),
  ], '2026-09-30');
  const order = mixed.groups.map(x => x.client);
  if (order[0] !== 'לקוח ב' || order[1] !== 'לקוח א')
    throw new Error('הלקוחות אינם לפי האירוע הוותיק: ' + order.join(', '));
  const inner = mixed.groups[0].events.map(e => e.date);
  if (inner[0] !== '2026-06-11' || inner[1] !== '2026-08-20')
    throw new Error('האירועים בתוך הלקוח אינם לפי תאריך: ' + inner.join(', '));
  if (mixed.groups[0].firstDate !== '2026-06-11' || mixed.groups[0].lastDate !== '2026-08-20')
    throw new Error('טווח התאריכים של הלקוח שגוי');

  // חשבון עסקה והצעת מחיר אינם חיוב — האירוע עדיין צריך מסמך, ומוצע לו "מסמך המשך"
  for (const [what, e, srcType] of [
    ['חשבון עסקה מקושר', ev({ linkedDocs: [{ id: 'd1', type: 300, number: 40468 }] }), 300],
    ['הצעת מחיר מקושרת', ev({ linkedDocs: [{ id: 'd2', type: 10, number: 635 }] }), 10],
    ['עסקה במסלול הישן', ev({ invoiceId: 'x', invoiceType: 300, invoiceStatus: 'invoiced' }), null],
  ]) {
    const r = due([e], '2026-10-15');
    if (r.total !== 1) throw new Error('לא הופיע בהתראה: ' + what);
    const f = r.groups[0].events[0].followup;
    if (srcType && (!f || f.type !== srcType)) throw new Error('אין מסמך מקור למסמך המשך: ' + what);
  }
  // עסקה עדיפה על הצעה כמקור למסמך המשך
  const both = due([ev({ linkedDocs: [{ id: 'q', type: 10, number: 635 }, { id: 'p', type: 300, number: 40468 }] })], '2026-10-15');
  if (both.groups[0].events[0].followup.type !== 300) throw new Error('הצעת המחיר נבחרה על פני חשבון העסקה');
  // אירוע בלי שום מסמך — אין מקור, ולכן "צור מסמך"
  if (due([ev()], '2026-10-15').groups[0].events[0].followup !== null) throw new Error('הומצא מסמך מקור');

  // מה שלא אמור להופיע בכלל
  for (const [what, e] of [
    ['אירוע שכבר חויב', ev({ linkedDocs: [{ type: 305, number: 1 }] })],
    ['מס-קבלה מקושרת', ev({ linkedDocs: [{ type: 320, number: 2 }] })],
    ['אירוע עם invoiceStatus', ev({ invoiceStatus: 'invoiced' })],
    ['אירוע ללא חיוב', ev({ noInvoice: true })],
    ['אירוע שטרם אושר', ev({ confirmed: false })],
    ['אירוע בלי תאריך', ev({ date: '' })],
  ]) {
    if (due([e], '2026-10-15').total !== 0) throw new Error('הופיע בהתראה: ' + what);
  }
  // מסמך שזוכה אינו נחשב חיוב — האירוע חוזר להתראה
  if (due([ev({ linkedDocs: [{ type: 305, credited: true }] })], '2026-09-11').total !== 1)
    throw new Error('אירוע שהחשבונית שלו זוכתה אינו חוזר להתראה');

  // שם ברשימה שאינו תואם לאף אירוע — טעות שקטה שהפילה את כל התכונה בפועל
  // ("גואטה הפקות" ברשימה מול "אבי גואטה הפקות" באירועים). חייבת להיות הצעת תיקון.
  const sg = srv.match(/function suggestClientName\(name, namesByKey\) \{[\s\S]*?\n\}/);
  if (!sg) throw new Error('suggestClientName לא נמצאה');
  const bk = srv.match(/function billKey\(s\) \{[\s\S]*?\n\}/);
  const suggest = new Function(bk[0] + ';' + sg[0] + '; return suggestClientName;')();
  const names = new Map([['אבי גואטה הפקות בעמ', 'אבי גואטה הפקות בע״מ'], ['שרית הפקות בעמ', 'שרית הפקות בע״מ']]);
  if (suggest('גואטה הפקות בע״מ', names) !== 'אבי גואטה הפקות בע״מ') throw new Error('אין הצעת תיקון לשם חלקי');
  if (suggest('שרית הפקות בע״מ', names) !== null) throw new Error('שם שתואם בדיוק קיבל הצעה');
  if (suggest('זבנג הפקות', names) !== null) throw new Error('שם זר קיבל הצעה');
  if (suggest('הפקות', names) !== null) throw new Error('שם קצר מדי התאים לכל דבר');
  // הראוט מחזיר מונה אירועים לכל שם, ומועמדים מתוך האירועים ולא מרשימה אחרת
  const sched = srv.slice(srv.indexOf("add('GET', /^\\/api\\/billing-schedule$/"), srv.indexOf('function suggestClientName'));
  if (!/events: counts\.get\(billKey\(x\.name\)\) \|\| 0/.test(sched)) throw new Error('אין מונה אירועים לשם');
  if (!/candidates:/.test(sched)) throw new Error('אין רשימת מועמדים מהאירועים');
  const appSrc = fs.readFileSync('app.js', 'utf8');
  const ui = appSrc.slice(appSrc.indexOf('window.loadBillSchedule'), appSrc.indexOf('window.fixBillName'));
  if (!/לא תואם לאף אירוע/.test(ui)) throw new Error('שם שלא תפס אינו מסומן במסך');
  if (/api\('\/api\/clients'\)/.test(ui)) throw new Error('ההשלמה עדיין מרשימת הלקוחות ולא מהאירועים');

  // ההתראה אינה מפיקה כלום
  if (/createDocument|invoicing\/generate/.test(block)) throw new Error('קוד ההתראה נוגע בהפקת מסמכים');
  // והראוטים: חברה אחת, ועריכת הרשימה למנהל בלבד
  const routes = srv.slice(srv.indexOf("add('GET', /^\\/api\\/billing-due$/"), srv.indexOf('// ---- הצעות מחיר שחויבו'));
  if ((routes.match(/add\('/g) || []).length !== (routes.match(/reqCompany\(/g) || []).length)
    throw new Error('ראוט חיוב שאינו נגזר מ-reqCompany');
  const post = routes.slice(routes.indexOf("add('POST'"));
  if (!/role !== 'admin'/.test(post)) throw new Error('משתמש צפייה יכול לשנות את הרשימה');
  return true;
});

// החשבונית צריכה לצאת העתק של ההצעה שסוכמה עם הלקוח. הסכנה היא בכיוון השני:
// נפילה לא נכונה להצעה כשחלק מהאירועים בלי הצעה תשמיט חיוב בשקט.
check('חיוב מאירוע — השורות מועתקות מהצעת המחיר, ובספק נופלות לתמחור האירוע', async () => {
  const srv = fs.readFileSync('server.js', 'utf8');
  const fn = srv.match(/async function quoteCopyForEvents\(evs\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('quoteCopyForEvents לא נמצאה');
  const mk = (docs, creds = true) => new Function('greenInvoice',
    fn[0] + '; return quoteCopyForEvents;')({
    haveCredentials: () => creds,
    getDocument: async (qid) => { if (!docs[qid]) throw new Error('404'); return docs[qid]; },
  });
  const Q = {
    q1: { number: 635, description: 'הגברה ותאורה — ידעי 10.09.26', remarks: 'התשלום עד 30 יום מהאירוע.',
      discount: { amount: 5, type: 'percentage' },
      income: [{ description: 'הגברה מלאה', quantity: 1, price: 18000 }, { description: 'תאורה', quantity: 2, price: 1500 }] },
    q2: { number: 636, description: 'מופע נוסף', income: [{ description: 'חבילת מופע', quantity: 1, price: 9000 }] },
  };
  const ev = (o) => ({ id: 'e', linkedDocs: [{ id: 'q1', type: 10 }], ...o });

  // אירוע עם הצעה פעילה — הכל מועתק: שורות, נושא, הערה והנחה
  const one = await mk(Q)([ev()]);
  if (!one || one.items.length !== 2) throw new Error('השורות לא הועתקו מההצעה');
  if (one.items[0].description !== 'הגברה מלאה' || one.items[1].quantity !== 2 || one.items[1].price !== 1500)
    throw new Error('השורות לא זהות להצעה');
  if (one.description !== 'הגברה ותאורה — ידעי 10.09.26') throw new Error('נושא המסמך לא הועתק');
  if (one.remarks !== 'התשלום עד 30 יום מהאירוע.') throw new Error('ההערה לא הועתקה');
  if (!one.discount || one.discount.amount !== 5 || one.discount.type !== 'percentage') throw new Error('ההנחה לא הועתקה');
  if (!one.numbers.includes('635')) throw new Error('מספר ההצעה אינו מדווח');

  // שני אירועים שחולקים הצעה אחת — היא נספרת פעם אחת ולא כפול
  const shared = await mk(Q)([ev({ id: 'e1' }), ev({ id: 'e2' })]);
  if (shared.items.length !== 2) throw new Error('הצעה משותפת נספרה פעמיים: ' + shared.items.length);
  if (shared.description !== 'הגברה ותאורה — ידעי 10.09.26') throw new Error('הצעה אחת משותפת — הנושא עדיין אמור לעבור');
  // שני אירועים עם שתי הצעות — השורות מצטרפות, אבל לא הנושא/הערה (אין "הנושא")
  const two = await mk(Q)([ev({ id: 'e1' }), ev({ id: 'e2', linkedDocs: [{ id: 'q2', type: 10 }] })]);
  if (two.items.length !== 3) throw new Error('חיוב מאוחד לא צירף את שתי ההצעות');
  if (two.description || two.remarks || two.discount) throw new Error('חיוב מאוחד העתיק נושא/הערה/הנחה מהצעה אחת');

  // כל מצב של ספק → null, כלומר נפילה לתמחור האירוע
  const cases = [
    ['אירוע בלי הצעה', [ev(), { id: 'e2', linkedDocs: [] }]],
    ['הצעה שהועלתה כקובץ', [ev({ linkedDocs: [{ id: 'q1', type: 10, uploaded: true }] })]],
    ['הצעה שזוכתה', [ev({ linkedDocs: [{ id: 'q1', type: 10, credited: true }] })]],
    ['הצעה בלי מזהה', [ev({ linkedDocs: [{ type: 10 }] })]],
    ['הצעה שנמחקה בחשבונית ירוקה', [ev({ linkedDocs: [{ id: 'נעלם', type: 10 }] })]],
    ['הצעה בלי שורות', [ev({ linkedDocs: [{ id: 'q0', type: 10 }] })]],
    ['בלי אירועים', []],
  ];
  for (const [what, evs] of cases) {
    const r = await mk({ ...Q, q0: { income: [] } })(evs);
    if (r !== null) throw new Error('לא נפל לתמחור האירוע: ' + what);
  }
  // בלי חיבור לחשבונית ירוקה — לא מנסים בכלל
  if (await mk(Q, false)([ev()]) !== null) throw new Error('ניסה לשלוף הצעה בלי חיבור');

  // הראוט משתמש בנפילה ולא בהצעה בלבד, ומדווח לפרונט מאיפה הגיעו השורות
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/invoicing\\/preview$/"), srv.indexOf("// POST /api/invoicing/preview-pdf"));
  if (!/fromQuote && fromQuote\.items\) \|\| invoiceItemsFromEvents\(evs\)/.test(route)) throw new Error('אין נפילה לתמחור האירוע');
  if (!/itemsFrom: fromQuote \? 'quote' : 'event'/.test(route)) throw new Error('הפרונט לא יודע מאיפה השורות');
  if (!/fromQuote && fromQuote\.remarks/.test(route)) throw new Error('ההערה לא מוחזרת לפרונט');

  // וההערה עוברת עד ההפקה בפועל — לא נעצרת בתצוגה
  const app2 = fs.readFileSync('app.js', 'utf8');
  const gen2 = app2.slice(app2.indexOf("fetch('/api/invoicing/generate'"), app2.indexOf("fetch('/api/invoicing/generate'") + 700);
  if (!/remarks: p\.remarks/.test(gen2)) throw new Error('ההערה אינה נשלחת בהפקה');
  const pdf2 = app2.slice(app2.indexOf("fetch('/api/invoicing/preview-pdf'"), app2.indexOf("fetch('/api/invoicing/preview-pdf'") + 500);
  if (!/remarks: p\.remarks/.test(pdf2)) throw new Error('ההערה אינה נשלחת לתצוגה המעוצבת');
  // וההצעה עדיין נסגרת: ההפקה מקשרת אותה כמסמך מקור
  const gen = srv.slice(srv.indexOf("add('POST', /^\\/api\\/invoicing\\/generate$/"), srv.indexOf('\n});', srv.indexOf("add('POST', /^\\/api\\/invoicing\\/generate$/")));
  if (!/linkedDocumentIds: quoteIds/.test(gen)) throw new Error('ההצעה לא תיסגר בחשבונית ירוקה');
  return true;
});

// הזיכרון הוא מה שהופך את הסוכן למי שמכיר את העסק — ולכן גם הסיכון: זיכרון
// שגוי או כפול משפיע על כל שיחה עתידית ואיש לא יבין למה הוא מתנהג מוזר.
check('סוכן AI — זיכרון: דדופ, תקרה, מחיקה, ובידוד בין עסקים', () => {
  const src = fs.readFileSync('aiAgent.js', 'utf8');
  const block = src.slice(src.indexOf('const MEM_MAX'), src.indexOf('const ymd =')).replace(/^export /gm, '');
  const dbs = { agentMemory: {} };
  const fns = new Function('load', 'save', 'newId', `${block}\nreturn { memoryOf, rememberFact, forgetFact, MEM_MAX };`)(
    () => dbs, () => {}, (p) => p + '_' + Math.random().toString(36).slice(2, 8));

  fns.rememberFact('co_bpm', { text: 'המחיר הסטנדרטי להגברה בחתונה הוא 12,000 ללא מע״מ' });
  if (fns.memoryOf('co_bpm').length !== 1) throw new Error('הזיכרון לא נשמר');
  // אותו טקסט בדיוק — לא נוצר כפל
  fns.rememberFact('co_bpm', { text: 'המחיר הסטנדרטי להגברה בחתונה הוא 12,000 ללא מע״מ' });
  if (fns.memoryOf('co_bpm').length !== 1) throw new Error('טקסט זהה נשמר פעמיים');
  // אותו נושא בניסוח אחר — מחליף, ולא מצטבר לצד הישן וסותר אותו
  fns.rememberFact('co_bpm', { text: 'המחיר הסטנדרטי להגברה בחתונה הוא 14,000 ללא מע״מ' });
  const after = fns.memoryOf('co_bpm');
  if (after.length !== 1) throw new Error('עדכון יצר זיכרון סותר: ' + after.length);
  if (!/14,000/.test(after[0].text)) throw new Error('הערך לא עודכן');
  // נושא אחר לגמרי — כן מתווסף
  fns.rememberFact('co_bpm', { text: 'אבי גואטה מבקש תמיד חשבונית על שם אבי גואטה הפקות' });
  if (fns.memoryOf('co_bpm').length !== 2) throw new Error('זיכרון בנושא אחר לא נוסף');

  // בידוד בין עסקים: מה ש-BPM למד אינו מגיע לאופק
  fns.rememberFact('co_ofek', { text: 'אצל אופק הקבלן הקבוע לתאורה הוא תאורת הצפון' });
  if (fns.memoryOf('co_ofek').length !== 1) throw new Error('הזיכרון של אופק לא נשמר');
  if (fns.memoryOf('co_bpm').length !== 2) throw new Error('זיכרון של אופק דלף ל-BPM');
  // scope:'all' כן מגיע לכולם
  fns.rememberFact('co_bpm', { text: 'הוא מעדיף תשובות קצרות', scope: 'all' });
  if (!fns.memoryOf('co_ofek').some(m => /קצרות/.test(m.text))) throw new Error('זיכרון גלובלי לא מגיע לכל העסקים');

  // טקסט קצר מדי נדחה — "כן"/"אוקיי" אינם לקח
  if (!fns.rememberFact('co_bpm', { text: 'כן' }).error) throw new Error('טקסט קצר מדי נשמר');
  // תקרה: הזיכרון לא תופח בלי גבול
  for (let i = 0; i < fns.MEM_MAX + 25; i++) fns.rememberFact('co_moshe', { text: `נושא מספר ${i} עם מלל ייחודי ${i * 7}` });
  if (fns.memoryOf('co_moshe').length > fns.MEM_MAX) throw new Error('התקרה לא נאכפת');

  // מחיקה לפי טקסט ולפי מזהה
  const target = fns.memoryOf('co_bpm').find(m => /אבי גואטה/.test(m.text));
  if (!fns.forgetFact('co_bpm', target.id).ok) throw new Error('מחיקה לפי מזהה נכשלה');
  if (fns.memoryOf('co_bpm').some(m => m.id === target.id)) throw new Error('הפריט לא נמחק');
  if (fns.forgetFact('co_bpm', 'משהו שלא קיים בכלל').ok) throw new Error('מחיקה של לא-קיים דיווחה הצלחה');

  // הרפלקציה: שמרנית, זולה, ולא חוסמת את התשובה
  const refl = src.slice(src.indexOf('const REFLECT_SYSTEM'), src.indexOf('export default'));
  if (!/haiku/i.test(refl)) throw new Error('הרפלקציה רצה על מודל יקר');
  if (!/\{"learn":\[\]\}/.test(refl)) throw new Error('אין הנחיה להחזיר ריק כשאין מה ללמוד');
  if (!/slice\(0, 3\)/.test(refl)) throw new Error('אין תקרה ללקחים בתור אחד');
  const srv = fs.readFileSync('server.js', 'utf8');
  const route = srv.slice(srv.indexOf("add('POST', /^\\/api\\/agent\\/chat$/"), srv.indexOf("add('GET', /^\\/api\\/agent\\/memory$/"));
  if (route.indexOf('learnFromTurn') < route.indexOf('json(res, { ok: true, reply'))
    throw new Error('הרפלקציה חוסמת את התשובה');
  if (!/if \(isAdmin\)/.test(route)) throw new Error('משתמש צפייה מלמד את הסוכן של הבעלים');
  // כלי הזיכרון חסומים למשתמש צפייה
  if (!/WRITE_TOOLS = new Set\(\[[^\]]*'remember'[^\]]*'forget'/.test(src)) throw new Error('remember/forget פתוחים לכל משתמש');
  return true;
});

// buildQuote הוא הצומת שקובע מה בפועל יופק. תצוגה מקדימה והפקה חולקות אותו
// בכוונה — אחרת מה שנראה בתצוגה לא היה בהכרח מה שנוצר.
check('סוכן AI — בניית ההצעה: מאירוע, מתאריך, ובלי להמציא חסרים', async () => {
  const src = fs.readFileSync('aiAgent.js', 'utf8');
  const fn = src.match(/function buildQuote\(a, \{ companyId \}\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('buildQuote לא נמצאה');
  const ev = { id: 'ev1', companyId: 'c', confirmed: true, date: '2026-09-10', artist: 'אבי גואטה',
    location: 'האחוזה', clientName: 'אבי גואטה', clientId: 'cl9',
    price: 12000, priceSound: 2500, priceLighting: 0 };
  const build = new Function('companyEvents', 'load', 'invoiceItemsFromEvents', 'subjectForEvents',
    fn[0] + '; return buildQuote;')(
    () => [ev], () => ({}),
    (evs) => evs.flatMap(e => [{ description: `הגברה - ${e.artist} - 10.09.26 - ${e.location}`, price: e.price, quantity: 1 },
      { description: `סאונד - ${e.artist} - 10.09.26 - ${e.location}`, price: e.priceSound, quantity: 1 }]),
    () => 'הגברה - אבי גואטה - ספטמבר 26');
  const ctx = { companyId: 'c' };

  // אירוע → שורות, לקוח, נושא. בלי שהמודל ינסח כלום בעצמו.
  const fromEv = build({ eventId: 'ev1', date: '2026-09-21' }, ctx);
  if (fromEv.error) throw new Error('בנייה מאירוע נכשלה: ' + fromEv.error);
  if (fromEv.opts.items.length !== 2) throw new Error('השורות לא נבנו מהאירוע');
  if (fromEv.total !== 14500) throw new Error('הסכום שגוי: ' + fromEv.total);
  if (fromEv.opts.client.id !== 'cl9') throw new Error('הלקוח לא נלקח מהאירוע');
  if (fromEv.opts.date !== '2026-09-21') throw new Error('תאריך המסמך לא נלקח מהבקשה');
  if (!/ספטמבר 26/.test(fromEv.opts.description)) throw new Error('נושא המסמך לא נבנה מהאירוע');
  if (Number(fromEv.opts.type) !== 10) throw new Error('סוג המסמך אינו הצעת מחיר');

  // בלי תאריך — היום, ולא תאריך שהומצא
  const today = new Date().toISOString().slice(0, 10);
  if (build({ eventId: 'ev1' }, ctx).opts.date !== today) throw new Error('ברירת המחדל אינה היום');
  if (build({ eventId: 'ev1', date: '10.09.26' }, ctx).opts.date !== today) throw new Error('תאריך בפורמט שגוי לא נדחה');

  // חסר מידע → שגיאה שאומרת מה חסר, כדי שהמודל ישאל ולא ינחש
  const noClient = build({ items: [{ description: 'הגברה', price: 5000 }] }, ctx);
  if (!noClient.error || !/לקוח/.test(noClient.error)) throw new Error('הפקה בלי לקוח אינה נחסמת');
  const noItems = build({ clientName: 'אבי' }, ctx);
  if (!noItems.error || !/שורות/.test(noItems.error)) throw new Error('הפקה בלי שורות אינה נחסמת');
  const badPrice = build({ clientName: 'אבי', items: [{ description: 'הגברה', price: 0 }] }, ctx);
  if (!badPrice.error) throw new Error('שורה במחיר אפס עוברת');
  // אירוע של חברה אחרת אינו נגיש
  const other = new Function('companyEvents', 'load', 'invoiceItemsFromEvents', 'subjectForEvents',
    fn[0] + '; return buildQuote;')(() => [], () => ({}), () => [], () => '');
  if (!other({ eventId: 'ev1' }, ctx).error) throw new Error('אירוע שאינו של החברה נבנה בכל זאת');

  // שורות ידניות גוברות על האירוע, ולא מתווספות אליו
  const manual = build({ eventId: 'ev1', items: [{ description: 'חבילה', price: 20000 }] }, ctx);
  if (manual.opts.items.length !== 1 || manual.total !== 20000) throw new Error('שורות ידניות לא גברו על האירוע');
  return true;
});

for (const pr of pendingAsync) { try { await pr; } catch (e) { bad('בדיקה אסינכרונית', e.message); } }
console.log(`\n${fail ? '❌' : '✅'}  ${pass} עברו · ${fail} נכשלו\n`);
process.exit(fail ? 1 : 0);
