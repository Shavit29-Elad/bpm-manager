# CLAUDE.md — מדריך פרויקט ל-Claude

מערכת ניהול פיננסי רב-חברתית ("BPM") לחברות הפקת אירועים, בעברית (RTL).
משתלבת עם Green Invoice / Morning (חשבונית ירוקה), יומן Google, ותיבות Gmail (IMAP).
מתארחת ב-Render, בסיס נתונים Postgres (Neon).

## סטאק וקבצים עיקריים
- **Node.js (ES Modules), ללא שלב build.** הקבצים הסטטיים מוגשים ישירות.
- `server.js` — הבקאנד + ראוטר מותאם. הוספת endpoint: `add(method, /regex/, (req,res,params,q,body)=>{})`. handlers של GET יכולים להיות async.
- `app.js` — כל הפרונטאנד (SPA יחיד, גדול מאוד). מרונדר לפי `state.tab`. קורא ל-API דרך `api('/api/...')`.
- `mailReader.js` — סריקת Gmail ב-IMAP (imapflow + mailparser): צרופות + חילוץ PDF מקישורים.
- `greenInvoice.js` — קליינט ל-Green Invoice/Morning API (OAuth 2.0 עם fallback לישן). BASE=`https://api.greeninvoice.co.il/api/v1`.
- `invoicing.js` — לוגיקת חיוב: קיבוץ אירועים לפי לקוח, שורות חשבונית, קבלנים לתשלום.
- `store.js` — שמירה/טעינה (`load()`, `save()`), מזהים (`id()`), קבצים, `upsertEvent()`. Postgres כשיש `DATABASE_URL`, אחרת בזיכרון.
- `index.html`, `styles.css` — מבנה + עיצוב (פלטה בהירה אינדיגו/ענבר).

## מושגי דומיין
- **רב-חברתי:** `co_bpm`, `co_ofek`, `co_moshe`. בידוד מלא לפי `companyId`. בשרת: `withCompany()` (AsyncLocalStorage), `giCompanyId()`, `curCompany()`. בפרונט: כל קריאה כוללת `?companyId=state.company`.
- **סוגי מסמכים (Green Invoice):** 10=הצעת מחיר, 300=חשבון עסקה, 305=חשבונית מס, 320=מס-קבלה, 400=קבלה, 330=זיכוי.
- **אירועים:** לכל אירוע `contractorDetails[]` (שורת ספק: `{name, amount, paid, paidSource, paidPayableId, paidInvoice, paidExpenseId}`) ו-`linkedDocs[]`.
- **תשלום לספק:** נקבע רק מ(א) התאמת בנק מצטברת (תנועות חובה) שמכסה את מלוא החשבונית, או (ב) סימון ידני (`paidSource:'manual'`). ראה `applyBankSupplierPayments()` ב-server.js.
- **התאמות בנק:** `db.bankTx[]` עם `direction` ('credit'/'debit'), `matchStatus`, `matchedInvoices[]`.
- **סריקת מייל:** `mailScanBatchFor()` → AI מסווג צרופות/קישורים → מעלה כטיוטת הוצאה. מיילים שנראים כמו חשבונית ולא נקלטו → `db.mailPending` (רשימת טיפול ידני). ספקים כמו Paperless/Pango/Keep הם עמודי JavaScript שלא ניתנים לשליפה מהשרת.

## פריסה (Deploy)
- מתארח ב-Render (service `srv-d9c15inavr4c73a407r0`), ענף `main`, auto-deploy מ-GitHub.
- **push ל-GitHub → פריסה אוטומטית ב-Render** (אם הוגדר auto-deploy). אחרת: Render → Manual Deploy → Deploy latest commit.
- אין שלב build; Render מריץ `node server.js` (ראה `package.json`).

## סודות ומשתני סביבה (ב-Render → Environment, לא בקוד!)
`DATABASE_URL`, `ANTHROPIC_API_KEY`, פרטי Green Invoice פר-חברה, פרטי מייל (IMAP/SMTP) פר-חברה. אין להעלות `.env` ל-git.

## קונבנציות ובדיקה
- לפני push: `node --check server.js && node --check app.js && node --check mailReader.js` (אין טסטים אוטומטיים).
- כל טקסט למשתמש בעברית. שמור על עקביות עם הקוד הקיים (אין ספריות UI חיצוניות; PDF בפרונט דרך html2canvas+jsPDF).
- שינויים קטנים וממוקדים; אל תשבור בידוד companyId.
- אחרי שינוי משמעותי — אמת חי מול האתר (fetch ל-endpoint רלוונטי) ולא רק תחביר.

## חיבורים ואינטגרציות (Connections) — שמות משתני סביבה בלבד, הסודות ב-Render
- **Green Invoice / Morning** — פר-חברה. OAuth 2.0 (`https://api.morning.co/idp/v1/oauth/token`, fallback לישן). BPM מחובר מלא; אופק חשבונית-ירוקה נפרדת; משה. `greenInvoice.js`.
- **Gmail IMAP** — פר-חברה (imap.gmail.com:993, App Password). BPM: `Bpmnsl1@gmail.com`. סריקה אוטומטית כל 15 דק' + סריקה לילית מלאה. `mailReader.js`, `runNightlyMailScan()`.
- **SMTP** — שליחת מסמכים ללקוח + העברת הוצאות לרו"ח, פר-חברה. `mailer.js`.
- **Google Calendar** — אימוץ אירועים אוטומטי (`/api/calendar/auto-adopt`) → "אירועים לאישור".
- **Render** — service `srv-d9c15inavr4c73a407r0`, ענף `main`, **Auto-Deploy: On Commit** (push = פריסה אוטומטית).
- **Postgres (Neon)** — `DATABASE_URL`. **Anthropic** — `ANTHROPIC_API_KEY` (סיווג AI לקליטת מיילים/אירועים).

## מצב נוכחי ומשימות פתוחות (אוגוסט 2026)
- **קליטת חשבוניות מהמייל:** צרופות PDF + לינקים ישירים (למשל Morning `greeninvoice.co.il/api/v1/documents/download`) נקלטים אוטומטית. ספקים שהחשבונית מאחורי **עמוד JavaScript** — Paperless (`invoices@paperless.tax`), Pango (`DoNotReply@pango.co.il`), Keep (`hello@keep.co.il`) — השרת לא יכול לשלוף. כרגע נכנסים ל-`db.mailPending` → **תג אדום "חשבוניות לטיפול"** בראש המסך (רשת ביטחון). פתרון מלא עתידי: worker/דפדפן חבוי בשירות נפרד (לא על ה-Render הראשי — סיכון זיכרון). אבחון: `GET /api/mail-scan/inspect?companyId=&q=&since=`.
- **תשלום לספק:** "שולם לספק" אוטומטי **רק** מצבירת התאמות בנק (תנועות חובה) שמכסות את מלוא החשבונית, או סימון ידני (`paidSource='manual'`). קישור לחשבונית ≠ שולם. כיסוי חלקי = "שולם חלקית לספק". ראה `applyBankSupplierPayments()`.
- **מסמכים מקושרים:** `GET /api/documents/:id/related` — כל שרשרת המסמכים (הצעת מחיר→עסקה→מס→קבלה + זיכויים). כפתור 🔗 בחלונית תצוגת מסמך.
- **כפילויות יומן:** דדופ לפי `gcalId` (`store.upsertEvent` + `dedupeCalendarEventsByGcal`) — מונע אימוץ כפול מהיומן.
