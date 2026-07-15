// seed.js — יצירת נתוני התחלה: החברות + אירוע BPM לדוגמה.
// הרצה: node seed.js
import { load, save, id } from './store.js';
import { parseEventMessage } from './whatsappParser.js';

const db = load();

// חברות (משה כורסיה נשאר בצד לבינתיים, לא פעיל)
db.companies = [
  { id: 'co_bpm', name: 'בי פי אם הגברה ותאורה בע"מ', active: true, greenInvoiceId: null },
  { id: 'co_ofek', name: 'אופק ידעי הגברה ותאורה', active: false, greenInvoiceId: null },
];

// אירוע לדוגמה בפורמט ווטסאפ האמיתי
const sampleMsg = `תאריך: 25/07/2026
זמר: עומר אדם
תמחור: 4500
מיקום: אולמי גן הפקאן, ראשל"צ
סאונד: PA מלא + מוניטורים
עובדים: דני, אבי, שחר
תוספת לעובדים: 150 לכל אחד
קבלן: תאורה - ליאור`;

const parsed = parseEventMessage(sampleMsg);
db.events = [{
  id: id('ev'),
  companyId: 'co_bpm',
  ...parsed,
  client: 'עומר אדם - הפקות',
  invoiceStatus: 'pending',
  createdAt: new Date().toISOString(),
  employeeDetails: parsed.employees.map(n => ({ name: n, rate: 500, bonus: 150 })),
  contractorDetails: parsed.contractors.map(n => ({ name: n, amount: 1200 })),
}];

save(db);
console.log('נזרעו', db.companies.length, 'חברות ו-', db.events.length, 'אירוע לדוגמה.');
