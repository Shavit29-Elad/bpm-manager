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
- `chat.js` — AI: חילוץ אירועים מווטסאפ, קריאת חשבוניות (vision), צ'אט הצוות. Claude ראשי עם fallback ל-Gemini.
- `bankParser.js` / `bankMatch.js` — פרסור קובצי בנק (מזרחי הדבקה/HTML, דיסקונט xlsx) והצעות התאמה.
- `index.html`, `styles.css` — מבנה + עיצוב (פלטה בהירה אינדיגו/ענבר).

### 11 הלשוניות (`index.html` ↔ `TAB_LABELS` ב-app.js ↔ `VALID_TABS` ב-server.js)
`home` · `summary` (סיכום עסק) · `events` (אירועים ויומן — כולל הפקת חשבוניות מוטמעת) · `quotes` · `clients` (מסמכים ולקוחות) · `contractors` (ספקים) · `payroll` · `bank` · `team` · `connections` · `business` (פרטי העסק — הנהלה בלבד).
**שלושת המקומות האלה חייבים להישאר מסונכרנים** — אחרת בחירת לשונית למשתמש צפייה נמחקת בשקט בשמירה.

## מושגי דומיין
- **רב-חברתי:** `co_bpm`, `co_ofek`, `co_moshe` — **כולן על חשבונית ירוקה**, כל אחת עם מפתחות/יומנים/בנק משלה. בידוד מלא לפי `companyId`.
  - **בשרת:** `withCompany()` (AsyncLocalStorage) עוטף כל בקשה, ובנוסף שלושה עוזרים שכל ראוט הנוגע בנתוני חברה **חייב** לעבור דרכם:
    - `reqCompany(q, body)` — החברה של הבקשה. אף פעם לא "כל החברות"; בהיעדר פרמטר נופל ל-`giCompanyId()`.
    - `ownedBy(rec, cid)` — האם רשומה שייכת לחברה (רשומה ישנה ללא `companyId` = חברת ברירת המחדל).
    - `wrongCompany(res, what)` — תשובת 403 אחידה.
  - **בפרונט:** `window.fetch` עטוף ומזריק `companyId` לכל קריאת `/api/` (כולל POST/PUT/DELETE).
  - **משתמש צפייה:** בקשה בלי `companyId` ננעלת אוטומטית לעסק המורשה הראשון שלו (בשכבת ההרשאות).
  - ⚠️ **כלל ברזל:** ראוט חדש שנוגע ב-`db.events` / `db.bankTx` / `db.txGroups` / `db.oldInvoices` / `db.supplierPayables` — חייב `ownedBy`. לולאה על אוסף גלובלי בלי סינון חברה היא באג.
- **סוגי מסמכים (Green Invoice):** 10=הצעת מחיר, 300=חשבון עסקה, 305=חשבונית מס, 320=מס-קבלה, 400=קבלה, 330=זיכוי.
- **אירועים:** לכל אירוע `contractorDetails[]` (שורת ספק: `{name, amount, paid, paidSource, paidPayableId, paidInvoice, paidExpenseId}`) ו-`linkedDocs[]`.
- **תשלום לספק:** נקבע רק מ(א) התאמת בנק מצטברת (תנועות חובה) שמכסה את מלוא החשבונית, או (ב) סימון ידני (`paidSource:'manual'`). ראה `applyBankSupplierPayments()` ב-server.js.
- **התאמות בנק:** `db.bankTx[]` עם `direction` ('credit'/'debit'), `matchStatus`, `matchedInvoices[]`.
- **סריקת מייל:** `mailScanBatchFor()` → AI מסווג צרופות/קישורים → מעלה כטיוטת הוצאה. מיילים שנראים כמו חשבונית ולא נקלטו → `db.mailPending` (רשימת טיפול ידני). ספקים כמו Paperless/Pango/Keep הם עמודי JavaScript שלא ניתנים לשליפה מהשרת.
- **קבצים מאוחסנים:** טבלת `emp_files` נפרדת (לא בתוך `app_state`). כל קובץ מתויג ב-`employee_id` לפי מקורו: `biz:<cid>` · `mailscan:<cid>` · `evdoc:<eventId>` · מזהה עובד · `oldinv` · `payable`. `fileCompanyId()` בשרת מפענח את התיוג כדי לאכוף הרשאה ב-`/api/files/:id` (מנהל רואה הכל; צפייה — רק עסק מורשה).

## פריסה (Deploy)
- מתארח ב-Render (service `srv-d9c15inavr4c73a407r0`), ענף `main`, auto-deploy מ-GitHub.
- **push ל-GitHub → פריסה אוטומטית ב-Render** (אם הוגדר auto-deploy). אחרת: Render → Manual Deploy → Deploy latest commit.
- אין שלב build; Render מריץ `node server.js` (ראה `package.json`).

## סודות ומשתני סביבה (ב-Render → Environment, לא בקוד!)
`DATABASE_URL`, `ANTHROPIC_API_KEY`, פרטי Green Invoice פר-חברה, פרטי מייל (IMAP/SMTP) פר-חברה. אין להעלות `.env` ל-git.

## קונבנציות ובדיקה
- 🔴 **חובה לפני כל push: `node smoke.js`.** לא `node --check` — הוא בודק תחביר בלבד
  ועובר בהצלחה על משתנה לא מוגדר ועל HTML שנשבר בזמן ריצה. שני באגים אמיתיים חמקו
  דרכו: כלל CSS חסר (`.hidden`) שהשבית שלוש פונקציות בשקט, ומשתנה לא מוגדר שהקפיא
  את חלונית עריכת הוצאת ספק. `smoke.js` מריץ קוד בפועל מול DOM מדומה, מאמת שהלשוניות
  מסונכרנות בשלושה מקומות, שכל onclick מצביע לפונקציה קיימת, ושלוגיקות הגיבוי והדוח
  מתנהגות כמצופה.
- **אין לומר למשתמש "רענן ובדוק" לפני שהבדיקה עברה מקומית.**
- לפני push: `node --check server.js && node --check app.js && node --check mailReader.js` (אין טסטים אוטומטיים).
- **אימות חזק יותר** (מומלץ אחרי שינוי מבני): `node -e "import('./server.js')"` — מוודא שכל ה-imports/exports נפתרים בפועל, לא רק תחביר. השרת יעלה ויאזין; עצור ב-Ctrl+C ומחק את `data/` שנוצר.
- כל טקסט למשתמש בעברית. שמור על עקביות עם הקוד הקיים (אין ספריות UI חיצוניות; PDF בפרונט דרך html2canvas+jsPDF).
- שינויים קטנים וממוקדים; אל תשבור בידוד companyId.
- אחרי שינוי משמעותי — אמת חי מול האתר (fetch ל-endpoint רלוונטי) ולא רק תחביר.

## סביבת פיתוח — שים לב
- **עותק אחד בלבד!** התיקייה הנכונה היא `~/bpm-manager-1` (מסונכרנת עם `origin/main`). הייתה תיקייה כפולה `~/bpm-manager` שהייתה **49 קומיטים מאחור** — עבודה בה מחזירה אחורה תיקונים. אם היא עדיין קיימת: למחוק.
- **Node** מותקן דרך המתקין הרשמי (`.pkg`), לא Homebrew.
- ⚠️ **Auto-Deploy: On Commit** — כל push ל-`main` עולה מיד לפרודקשן ב-Render. אין סביבת staging. לכן: `node --check` + סקירת diff לפני כל דחיפה.

## חיבורים ואינטגרציות (Connections) — שמות משתני סביבה בלבד, הסודות ב-Render
- **Green Invoice / Morning** — פר-חברה. OAuth 2.0 (`https://api.morning.co/idp/v1/oauth/token`, fallback לישן). BPM מחובר מלא; אופק חשבונית-ירוקה נפרדת; משה. `greenInvoice.js`.
- **Gmail IMAP** — פר-חברה (imap.gmail.com:993, App Password). BPM: `Bpmnsl1@gmail.com`. סריקה אוטומטית כל 15 דק' + סריקה לילית מלאה. `mailReader.js`, `runNightlyMailScan()`.
- **SMTP** — שליחת מסמכים ללקוח + העברת הוצאות לרו"ח, פר-חברה. `mailer.js`.
- **Google Calendar** — אימוץ אירועים אוטומטי (`/api/calendar/auto-adopt`) → "אירועים לאישור".
- **Render** — service `srv-d9c15inavr4c73a407r0`, ענף `main`, **Auto-Deploy: On Commit** (push = פריסה אוטומטית).
- **Postgres (Neon)** — `DATABASE_URL`. **Anthropic** — `ANTHROPIC_API_KEY` (סיווג AI לקליטת מיילים/אירועים).

## ניקיון גדול — 17.08.26
עבר אודיט מלא של כל 17,400 השורות. מה שנעשה:
- **12 זליגות בין חברות נסגרו.** החמורה: `GET /api/bank` (ו-`coverage-audit`, `group-summary`, `month-detail`) החזירו את **כל** התנועות של **כל** החברות כשלא נשלח `companyId`. בנוסף: `auto-sync-names` (שרץ אוטומטית!), `rename-bulk`, `dismiss-supplier` שינו נתונים בכל החברות; ראוטי אירוע/חיוב/בנק/קבוצות/חשבוניות-ישנות ללא בדיקת בעלות; `/api/files/:id` הגיש כל קובץ ללא הרשאה; עובדי BPM דלפו לחישובי שכר של חברות אחרות.
- **באגים:** `VALID_TABS` היה חסר `summary` (הקצאת הלשונית למשתמש צפייה נמחקה בשקט); `forwardOfekIncomeDoc` הסתמך על fallback שביר.
- **~1,000 שורות קוד מת הוסרו:** מודול Paperless במלואו (`paperless.js`, `pdfDesc.js`, דף הבית של אופק, 4 ראוטים) — אופק עברה לחשבונית ירוקה ולכן הוא לא היה נגיש; `docGroupOverrides` (כתיבה ללא קריאה); מסך החיוב הישן; 9 פונקציות מתות ב-app.js; ייצואים ללא ראוט; `seed.js`.
  > **לא להתבלבל:** Paperless כ**שולח חשבוניות במייל** (`invoices@paperless.tax`) ממשיך לעבוד כרגיל — הטיפול בו ב-`mailReader.js` ולא נגעו בו.

## מצב נוכחי ומשימות פתוחות (אוגוסט 2026)
- **קליטת חשבוניות מהמייל:** צרופות PDF + לינקים ישירים (למשל Morning `greeninvoice.co.il/api/v1/documents/download`) נקלטים אוטומטית. ספקים שהחשבונית מאחורי **עמוד JavaScript** — Paperless (`invoices@paperless.tax`), Pango (`DoNotReply@pango.co.il`), Keep (`hello@keep.co.il`) — השרת לא יכול לשלוף. כרגע נכנסים ל-`db.mailPending` → **תג אדום "חשבוניות לטיפול"** בראש המסך (רשת ביטחון). פתרון מלא עתידי: worker/דפדפן חבוי בשירות נפרד (לא על ה-Render הראשי — סיכון זיכרון). אבחון: `GET /api/mail-scan/inspect?companyId=&q=&since=`.
- **תשלום לספק:** "שולם לספק" אוטומטי **רק** מצבירת התאמות בנק (תנועות חובה) שמכסות את מלוא החשבונית, או סימון ידני (`paidSource='manual'`). קישור לחשבונית ≠ שולם. כיסוי חלקי = "שולם חלקית לספק". ראה `applyBankSupplierPayments()`.
- **מסמכים מקושרים:** `GET /api/documents/:id/related` — כל שרשרת המסמכים (הצעת מחיר→עסקה→מס→קבלה + זיכויים). כפתור 🔗 בחלונית תצוגת מסמך.
- **כפילויות יומן:** דדופ לפי `gcalId` (`store.upsertEvent` + `dedupeCalendarEventsByGcal`) — מונע אימוץ כפול מהיומן.

## 📌 משימות שנדחו במכוון
- **קליטת פירוט כרטיסי אשראי** (כמו קליטת דפי בנק). היום הוצאות שיורדות באשראי
  אינן מותאמות לשום תנועה, ולכן אין דרך לדעת מהמערכת מה מהן שולם. זה גם מה שהכריע
  לבטל את המעבר ל"מקור אמת אחד" (20.08.26): בלי פירוט אשראי, "לא מותאם בבנק" לא
  אומר "לא שולם", וכל מיזוג של הוצאות מחשבונית ירוקה היה מסמן הוצאות ששולמו
  כממתינות לתשלום.
- **לא לבצע:** מיזוג כל ההוצאות מחשבונית ירוקה למסך "ספקים לתשלום". נבדק ב-20.08.26
  מול נתוני אמת: 303 הוצאות ב-BPM ו-186 במשה שאינן במסך הן ברובן טלפון/ליסינג/מלון,
  ולא ספקי אירועים. המסך מסונן בכוונה. במקום זה — בחירת חשבונית בחלונית הקישור
  יוצרת לה רשומה, וכך רק מה שבאמת עוקבים אחריו נכנס.
  אבחון זמין: פרטי העסק ← "🔍 השוואת הוצאות מול חשבונית ירוקה".

## ⏰ תזכורות פתוחות
- **01.09.2026 — להוריד את מגבלת ההוצאה ב-Anthropic חזרה ל-$30.**
  ברקע: באוגוסט 2026 נצרכו $83.67 (כמעט כולם ה-backfill החד-פעמי של סריקת המייל
  ב-15-16.08). כשהוגדרה מגבלה של $30 היא חסמה מיד את ה-API, כי החודש כבר עבר
  אותה — והועלתה ל-$95 כדי לפתוח. ב-1.9 המונה מתאפס, ואז $30 היא תקרה אמיתית.
  מיקום: platform.claude.com/settings/limits
