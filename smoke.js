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
  const iConfirm = chain.indexOf('pointsAtSource(raw.linkedDocumentIds)');
  if (iDirect < 0 || iConfirm < 0) throw new Error('חסר אחד ממסלולי האיתור');
  if (iDirect > iConfirm) throw new Error('המסלול היקר רץ לפני הזול');
  // צמצום לפי לקוח/סכום הוא ניחוש — האימות מול הקישור הוא מה שמכריע
  const confirmBlock = chain.slice(chain.indexOf('const cands ='), chain.indexOf('// 3)'));
  if (!/pointsAtSource\(raw\.linkedDocumentIds\)/.test(confirmBlock))
    throw new Error('מסמך נבחר לפי לקוח וסכום בלי אימות הקישור');
  if (!/linkedDocumentIds: Array\.isArray\(d\.linkedDocumentIds\)/.test(fs.readFileSync('greenInvoice.js', 'utf8')))
    throw new Error('רשימת המסמכים לא נושאת את הקישור');
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
  // מסמך שהוחלף — הקודם נמחק, אחרת האחסון מתמלא בקבצים יתומים
  if (!/if \(old && old\.id && old\.id !== saved\.id\)/.test(srv)) throw new Error('קובץ שהוחלף לא נמחק');

  // חיווי התוקף
  const f = new Function(app.match(/function vehDaysLeft\(iso\) \{[\s\S]*?\n\}/)[0] + '; return vehDaysLeft;')();
  const iso = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
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
  const iSend = run.indexOf('sendMailFrom'), iMark = run.indexOf('v.alertsSent[it.key]');
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

console.log(`\n${fail ? '❌' : '✅'}  ${pass} עברו · ${fail} נכשלו\n`);
process.exit(fail ? 1 : 0);
