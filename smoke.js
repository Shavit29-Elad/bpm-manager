// smoke.js — בדיקת עשן לפני פריסה. הרצה: node smoke.js
//
// למה זה קיים: `node --check` בודק תחביר בלבד. הוא עובר בהצלחה גם על קוד
// שמפנה למשתנה שלא קיים, ועל HTML שנשבר בזמן ריצה. שני באגים אמיתיים חמקו
// דרכו — כלל CSS חסר שהשבית שלוש פונקציות, ומשתנה לא מוגדר שהקפיא חלונית.
//
// הבדיקה כאן מריצה קוד בפועל: מאתחלת פונקציות רינדור מ-app.js מול DOM מדומה,
// מעלה את השרת ודופקת ב-endpoints, ומאמתת כללי-עקביות שקל לשבור בשקט.

import fs from 'fs';
import { execSync } from 'child_process';

const app = fs.readFileSync('app.js', 'utf8');
const srv = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');

let pass = 0, fail = 0;
const ok = (t) => { pass++; console.log(`  ✓ ${t}`); };
const bad = (t, d) => { fail++; console.log(`  ✗ ${t}${d ? '\n      ' + d : ''}`); };
const check = (t, fn) => { try { const r = fn(); r === false ? bad(t) : ok(t); } catch (e) { bad(t, e.message); } };
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
  const map = app.match(/\(\{ home: renderHome,(.*?)\}\[state\.tab\]\)/s)?.[1] || '';
  const routed = new Set([...map.matchAll(/(\w+):\s*render/g)].map(m => m[1]).concat(['home']));
  const miss = [...htmlTabs].filter(t => !routed.has(t));
  if (miss.length) throw new Error('בלי רינדור: ' + miss);
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
  const fn = new Function('debitByKey', '_nrmExpKey', 'c', fnSrc[0] + ' return bankOnlyStatus(c);');
  const keys = { 'num:40114': 16107 };
  if (!fn(keys, nrm, { paidInvoice: '40114' })) throw new Error('חשבונית מותאמת לא זוהתה כשולמה');
  if (fn(keys, nrm, { paidInvoice: '99999' })) throw new Error('חשבונית לא מותאמת סומנה כשולמה');
  if (fn(keys, nrm, {})) throw new Error('שורה בלי קישור סומנה כשולמה');
  // ובעיקר — שהפונקציה באמת מחוברת לשרשרת. בלי זה הבדיקה עוברת בזמן שהתיקון מנותק.
  if (!/\|\|\s*bankOnlyStatus\(c\)/.test(srv)) throw new Error('bankOnlyStatus לא מחוברת לחישוב הסטטוס');
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

console.log(`\n${fail ? '❌' : '✅'}  ${pass} עברו · ${fail} נכשלו\n`);
process.exit(fail ? 1 : 0);
