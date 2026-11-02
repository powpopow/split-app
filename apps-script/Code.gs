// SplitApp — Google Apps Script (single file: paste over Code.gs)
// Deploy as Web App: Execute as Me, Who has access: Anyone
// The script itself enforces who gets data: every request must carry a Google ID token whose
// email is listed in Config → person_a_emails / person_b_emails (see doPost below).
// ════════════════════════════════════════════════════════
// CHANGELOG
// v2.0.2 (2026-11-03)
//   - 'unauthorized' replies now carry a short `reason` code (no secrets) to make sign-in failures diagnosable.
// v2.0.1 (2026-11-02)
//   - Log the reason for every auth rejection (console.error → Executions log). Tokens are never logged.
// v2.0.0 (2026-11-02)
//   - SECURITY: all requests now require a verified Google ID token (`idToken` in the POST body).
//     The token is verified with Google (aud must equal CLIENT_ID), then the email is matched to
//     person_a_emails / person_b_emails in Config; no match → { ok:false, error:'unauthorized' }.
//   - doGet is closed (returns unauthorized). Reads moved to POST actions: getBills, getConfig, whoami.
//   - getConfig never returns keys containing "secret" or the person_*_emails lists.
//   - doPost's old write logic is now handleWrite_(data); old doGet reads are legacyDoGet_(e).
// v1.10.0 (2026-08-30)
//   - Fix #162 (A): addBill is now an UPSERT by id (overwrite if the id exists, else append) so a
//     client retry of an un-acked write can't create a duplicate row. Enables the client-side
//     confirmable-write + retry outbox. doPost already returns readable JSON {ok:...}; the client
//     now reads it via a simple-request POST (no CORS preflight).
// v1.9.0 (2026-07-24)
//   - Feature #102: store raw OCR JSON in a new Bills column M `ocr_json`. addBill/updateBill write it;
//     `ensureBillsHeaders_` adds the header on existing sheets; doGet returns it (header-keyed) for comparison.
// v1.8.0 (2026-07-21)
//   - v1.11.0 (#169): OCR telemetry — new ocr_meta column on Bills (success metrics) + logOcrFail action → OCR_Fail tab (hard fails)
//   - #120 payer names in weekly email · #125 recompute email balance from shares · #126 single GS_VERSION · #127 LockService
// v1.7.0 (2026-06-21)
//   - Fix #94: Date cells from getValues() are JS Date objects — JSON.stringify converts to UTC, shifting date back 1 day (Thailand UTC+7)
//   - Fix: use Utilities.formatDate(date, scriptTz, 'yyyy-MM-dd') to serialise dates as YYYY-MM-DD strings in local timezone
//   - gs_version bumped to 1.7.0
//
// v1.6.0 (2026-06-21)
//   - Fix #87: addBill now writes charges_json to column L (SC%, VAT%, discounts — persists across devices)
//   - Fix #87: updateBill now overwrites 12 columns (was 11) including charges_json in column L
//   - Migration: if existing Bills sheet has no charges_json header, column L header is auto-added on first write
//   - gs_version bumped to 1.6.0
//
// v1.5.5 (2026-06-15)
//   - Fix: email card header was still "Daily summary" — updated to "Weekly summary"
//
// v1.5.4 (2026-06-15)
//   - Switched from daily to weekly email: sendDailySummary → sendWeeklySummary
//   - Trigger: update to Week timer, Every Monday, 8am–9am (delete old Day timer trigger)
//   - Subject/footer updated to "weekly summary" / "Sent every Monday at 8:00 AM"
//   - Bills table expanded from 5 to 10 rows
//
// v1.5.3 (2026-06-15)
//   - Email CTA: "View in Sheets" button now solid black to match "Open SplitApp"
//
// v1.5.2 (2026-06-15)
//   - Email redesign: clean white template (LinkedIn light mode style)
//   - Neutral gray badges for Paid By (no more teal/red per-person colors)
//   - Green/red used only as left-border accents on balance cards
//   - Always renders exactly 5 bill rows (pads with — placeholders)
//   - Footer simplified to "Sent daily at 8:00 AM" only
//   - toEmails reverted to both addresses (test mode removed)
//
// v1.5.1 (2026-06-15)
//   - Email dark mode fix attempt: !important on all color/background-color styles + bgcolor attributes
//
// v1.5.0 (2026-06-15)
//   - New sendDailySummary() function: builds + sends HTML summary email
//   - Shows current balance (who receives / who pays) + last 5 bills table
//   - Set a time-driven trigger: sendDailySummary, every day at 8am
//
// v1.4.0 (2026-06-14)
//   - addBill now writes items_json to column K
//   - New deleteBill action: delete row by ID
//   - New updateBill action: overwrite row by ID
//
// v1.3.0 (2026-06-14)
//   - getConfig now returns gs_version in response (shown in app Settings)
//
// v1.2.0 (2026-06-14)
//   - Added setConfig action to doPost (writes key/value to Config tab)
//   - Enables person names and currency to sync across devices
//
// v1.1.0 (2026-06-14)
//   - Added getConfig action to doGet (reads Config tab)
//
// v1.0.0 (2026-06-14)
//   - Initial release
//   - doPost: addBill action writes to Bills tab
//   - doGet: returns all bills from Bills tab
//
// v1.8.0 (2026-07-22)
//   - Fix #120: payer is now stored as 'a'/'b' by the (React) client; email + display translate
//     via payerDisplay_() so it shows names, and normPaidBy_() normalises a/b/legacy-name.
//   - Fix #125: weekly-email balance recomputed from shares (Σ paidBy a ? +Share B : -Share A)
//     instead of the last row's stale Running Balance snapshot.
//   - Fix #126: single GS_VERSION constant used by getConfig + email footer (was drifting).
//   - Fix #127: doPost mutations wrapped in LockService to serialise concurrent writes.

const GS_VERSION = '2.0.2';

// Google OAuth client ID of the web app (the ID token's `aud` must match this).
const CLIENT_ID = '1095947409464-uf5j6j4q1jkdcsj7cksst7r1j8da09ii.apps.googleusercontent.com';

// ─── Auth layer ───────────────────────────────────────────────────────────────

// Config keys that must never leave the server, even to a signed-in user.
function isPrivateConfigKey_(k) {
  k = String(k).toLowerCase();
  return k.indexOf('secret') !== -1 || k === 'person_a_emails' || k === 'person_b_emails';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

let authReason_ = ''; // why the last verifyIdToken_ call failed (short code, returned to the client)

// Returns the verified lowercase email for a Google ID token, or null.
function verifyIdToken_(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) { authReason_ = 'no token'; console.error('auth: missing or oversized idToken'); return null; }
  const cache = CacheService.getScriptCache();
  const key = 'idt_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;

  let info;
  try {
    const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) { authReason_ = 'tokeninfo HTTP ' + resp.getResponseCode(); console.error('auth: tokeninfo HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200)); return null; }
    info = JSON.parse(resp.getContentText());
  } catch (err) { authReason_ = 'tokeninfo fetch failed'; console.error('auth: tokeninfo fetch failed: ' + err); return null; }

  if (info.aud !== CLIENT_ID) { authReason_ = 'client id mismatch'; console.error('auth: aud mismatch, token aud=' + info.aud); return null; } // token must have been issued for THIS app
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') { authReason_ = 'bad issuer'; console.error('auth: bad iss ' + info.iss); return null; }
  if (String(info.email_verified) !== 'true' || !info.email) { authReason_ = 'email unverified'; console.error('auth: email missing or unverified'); return null; }
  const ttl = Number(info.exp) - Math.floor(Date.now() / 1000);
  if (!(ttl > 0)) { authReason_ = 'token expired'; console.error('auth: token expired'); return null; }

  const email = String(info.email).toLowerCase();
  cache.put(key, email, Math.min(ttl, 21600));
  return email;
}

// 'a' | 'b' | null — read fresh each request so removing an email takes effect immediately.
function personFor_(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  if (!sheet) return null;
  const cfg = {};
  sheet.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) cfg[r[0]] = r[1]; });
  const has = function (k) {
    return String(cfg[k] || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean).indexOf(email) !== -1;
  };
  return has('person_a_emails') ? 'a' : has('person_b_emails') ? 'b' : null;
}

// Old unauthenticated GET endpoint: closed. Returns nothing useful to anyone.
function doGet(e) {
  return json_({ ok: false, error: 'unauthorized' });
}

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad request' }); }

  const email = verifyIdToken_(data.idToken);
  const person = email ? personFor_(email) : null;
  if (!person) {
    console.error(email ? 'auth: ' + email + ' is not in person_a_emails / person_b_emails' : 'auth: token rejected (see line above)');
    return json_({ ok: false, error: 'unauthorized', reason: email ? 'email not in allow-list' : authReason_ });
  }

  if (data.action === 'whoami') return json_({ ok: true, person: person, email: email });
  if (data.action === 'getBills') return legacyDoGet_({ parameter: {} });
  if (data.action === 'getConfig') {
    const out = JSON.parse(legacyDoGet_({ parameter: { action: 'getConfig' } }).getContent());
    const cfg = out.config || {};
    Object.keys(cfg).forEach(function (k) { if (isPrivateConfigKey_(k)) delete cfg[k]; });
    return json_({ config: cfg });
  }
  return handleWrite_(data); // addBill / updateBill / deleteBill / setConfig / logOcrFail
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Normalise a stored "Paid By" value to 'a' | 'b' (accepts a/b keys or legacy display names).
function normPaidBy_(raw, personA, personB) {
  const v = String(raw || '').trim();
  if (v === 'a' || v === 'b') return v;
  if (v && v === personA) return 'a';
  if (v && v === personB) return 'b';
  return 'a';
}
// Display name for a stored "Paid By" value.
function payerDisplay_(raw, personA, personB) {
  const v = String(raw || '').trim();
  if (v === 'a') return personA;
  if (v === 'b') return personB;
  return v; // legacy row already holds a name
}

// ─── Writes (called only after auth passes) ───────────────────────────────────

function handleWrite_(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'busy' })).setMimeType(ContentService.MimeType.JSON);
  }
  try {

  if (data.action === 'addBill') {
    const b = data.bill;
    let sheet = ss.getSheetByName('Bills') || ss.insertSheet('Bills');
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['ID','Date','Place','Category','Paid By','Grand Total','Share A','Share B','Running Balance','Saved At','items_json','charges_json','ocr_json','ocr_meta']);
    } else {
      ensureBillsHeaders_(sheet); // add charges_json (L) / ocr_json (M) headers if missing (#102)
    }
    const row = [b.id, b.date, b.place, b.category, b.paidBy, b.grandTotal, b.shareA, b.shareB, b.runningBalance, new Date().toISOString(), b.items_json || '[]', b.charges_json || '{}', b.ocr_json || '', b.ocr_meta || ''];
    // #162 (A) upsert by id — makes addBill idempotent so a client retry of a write whose ack was
    // lost can never create a duplicate row. If the id already exists overwrite it, else append.
    const rows = sheet.getDataRange().getValues();
    let found = false;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(b.id)) {
        if (!b.ocr_meta && rows[i][13]) row[13] = rows[i][13]; // #169 keep existing telemetry if none sent
        sheet.getRange(i + 1, 1, 1, 14).setValues([row]); found = true; break;
      }
    }
    if (!found) sheet.appendRow(row);
  }

  if (data.action === 'deleteBill') {
    const sheet = ss.getSheetByName('Bills');
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(data.id)) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
    }
  }

  if (data.action === 'updateBill') {
    const b = data.bill;
    const sheet = ss.getSheetByName('Bills');
    if (sheet) {
      ensureBillsHeaders_(sheet); // #102
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(b.id)) {
          const keepMeta = (!b.ocr_meta && rows[i][13]) ? rows[i][13] : (b.ocr_meta || ''); // #169 preserve telemetry on edit
          sheet.getRange(i + 1, 1, 1, 14).setValues([[
            b.id, b.date, b.place, b.category, b.paidBy,
            b.grandTotal, b.shareA, b.shareB, b.runningBalance,
            new Date().toISOString(), b.items_json || '[]', b.charges_json || '{}', b.ocr_json || '', keepMeta
          ]]);
          break;
        }
      }
    }
  }

  if (data.action === 'setConfig') {
    const sheet = ss.getSheetByName('Config');
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      let found = false;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === data.key) {
          sheet.getRange(i + 1, 2).setValue(data.value);
          found = true;
          break;
        }
      }
      if (!found) sheet.appendRow([data.key, data.value]);
    }
  }

  if (data.action === 'logOcrFail') { // #169 hard-fail telemetry (scans that produced no bill)
    const r = data.rec || {};
    let sheet = ss.getSheetByName('OCR_Fail') || ss.insertSheet('OCR_Fail');
    if (sheet.getLastRow() === 0) sheet.appendRow(['Timestamp','App','GS','Person','Status','Attempts','Total ms','Disc ms','Image KB','Image WxH','Mime','Discovery','Error']);
    sheet.appendRow([new Date().toISOString(), r.appVersion || '', r.gs || '', r.person || '', r.status || '', r.attempts || '', r.totalMs || '', r.discMs || '', r.imgKB || '', r.imgWH || '', r.mime || '', r.discovery || '', r.error || '']);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// Ensure the Bills tab has the charges_json (L) and ocr_json (M) headers (adds them if missing). #102
function ensureBillsHeaders_(sheet) {
  if (sheet.getLastRow() === 0) return;
  let lc = sheet.getLastColumn();
  const hdr = sheet.getRange(1, 1, 1, lc).getValues()[0];
  if (!hdr.includes('charges_json')) { sheet.getRange(1, lc + 1).setValue('charges_json'); lc++; }
  if (!hdr.includes('ocr_json'))     { sheet.getRange(1, lc + 1).setValue('ocr_json'); lc++; }
  if (!hdr.includes('ocr_meta'))     { sheet.getRange(1, lc + 1).setValue('ocr_meta'); lc++; } // #169
}

// ─── Reads (internal; only reachable through doPost after auth) ───────────────

function legacyDoGet_(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const action = e.parameter.action;

  // Return config from Config tab
  if (action === 'getConfig') {
    const sheet = ss.getSheetByName('Config');
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({ config: {} })).setMimeType(ContentService.MimeType.JSON);
    const rows = sheet.getDataRange().getValues();
    const config = { gs_version: GS_VERSION };
    rows.slice(1).forEach(r => { if (r[0]) config[r[0]] = r[1]; });
    return ContentService.createTextOutput(JSON.stringify({ config })).setMimeType(ContentService.MimeType.JSON);
  }

  // Return bills
  const sheet = ss.getSheetByName('Bills');
  if (!sheet) return ContentService.createTextOutput(JSON.stringify({ bills: [] })).setMimeType(ContentService.MimeType.JSON);
  const rows = sheet.getDataRange().getValues();
  const [header, ...data] = rows;
  const tz = Session.getScriptTimeZone();
  const bills = data.map(r => {
    const obj = Object.fromEntries(header.map((h,i) => [h, r[i]]));
    // Sheets returns Date cells as JS Date objects. JSON.stringify converts them to UTC ISO strings,
    // which shifts the date back by the timezone offset (e.g. UTC+7 → -7h → previous day).
    // Fix: format date as YYYY-MM-DD string in the script's local timezone before serialising.
    if (obj.Date instanceof Date) {
      obj.Date = Utilities.formatDate(obj.Date, tz, 'yyyy-MM-dd');
    }
    return obj;
  });
  return ContentService.createTextOutput(JSON.stringify({ bills })).setMimeType(ContentService.MimeType.JSON);
}

// ─── Weekly summary email ─────────────────────────────────────────────────────
// Set a time-driven trigger: sendWeeklySummary, every Monday at 8am
// Apps Script → Triggers → Add trigger → Function: sendWeeklySummary
//   Event source: Time-driven, Week timer, Every Monday, 8am–9am
function sendWeeklySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Read config
  const cfgSheet = ss.getSheetByName('Config');
  const cfg = {};
  if (cfgSheet) {
    cfgSheet.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) cfg[r[0]] = r[1]; });
  }
  const personA    = cfg['person_a']    || 'Person A';
  const personB    = cfg['person_b']    || 'Person B';
  const currency   = cfg['currency_symbol'] || '฿';
  const sheetUrl   = cfg['sheet_url']   || '';
  const appUrl     = cfg['app_url']     || '';
  const toEmails   = 'chanavi.pp@gmail.com,patpatphongsithichok@gmail.com';
  const gsVersion  = GS_VERSION;

  // Read bills
  const billSheet = ss.getSheetByName('Bills');
  if (!billSheet || billSheet.getLastRow() <= 1) {
    // No bills — send a short no-activity email
    const subject = 'SplitApp · weekly summary · ' + formatDateLabel_(new Date());
    const htmlBody = buildNoBillsHtml_(personA, personB, subject, appUrl, sheetUrl, gsVersion);
    MailApp.sendEmail({ to: toEmails, subject: subject, htmlBody: htmlBody });
    return;
  }

  const rows = billSheet.getDataRange().getValues();
  const [header, ...data] = rows;
  const bills = data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));

  // Current balance — recomputed from shares (#125), not the stale last-row snapshot.
  // Positive = B owes A, Negative = A owes B.
  const balance = bills.reduce((acc, b) => {
    const who = normPaidBy_(b['Paid By'], personA, personB);
    return who === 'a' ? acc + (Number(b['Share B']) || 0) : acc - (Number(b['Share A']) || 0);
  }, 0);
  const totalBills = bills.length;

  // Determine who receives / who pays
  const absBalance = Math.abs(balance);
  let receiverName, payerName;
  if (balance >= 0) {
    receiverName = personA;
    payerName    = personB;
  } else {
    receiverName = personB;
    payerName    = personA;
  }

  // Last 10 bills (most recent first)
  const last10 = bills.slice(-10).reverse();

  const subject = 'SplitApp · weekly summary · ' + formatDateLabel_(new Date());
  const htmlBody = buildSummaryHtml_({
    personA, personB, currency, appUrl, sheetUrl,
    absBalance, receiverName, payerName, totalBills, last10, subject, gsVersion
  });

  MailApp.sendEmail({ to: toEmails, subject: subject, htmlBody: htmlBody });
}

function formatDateLabel_(date) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[date.getDay()] + ' ' + date.getDate() + ' ' + months[date.getMonth()] + ' ' + date.getFullYear();
}

function formatDateShort_(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return String(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + months[d.getMonth()];
}

function fmtAmt_(n, currency) {
  const abs = Math.abs(Number(n) || 0);
  return currency + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function buildSummaryHtml_(o) {
  const { personA, personB, currency, appUrl, sheetUrl,
          absBalance, receiverName, payerName, totalBills, last10, subject, gsVersion } = o;

  // Always render exactly 10 rows — pad with nulls if fewer bills
  const rows = last10.slice(0, 10);
  while (rows.length < 10) rows.push(null);

  const billRows = rows.map((b, i) => {
    const isLast = i === 4;
    const border = isLast ? '' : 'border-bottom:1px solid #eeeeee;';
    if (!b) {
      return `<tr>
        <td style="${border}padding:8px 0;color:#bbbbbb;white-space:nowrap;font-size:13px;">&nbsp;</td>
        <td style="${border}padding:8px 4px;color:#dddddd;font-size:13px;">—</td>
        <td style="${border}padding:8px 4px;font-size:13px;"></td>
        <td style="${border}padding:8px 0;text-align:right;font-size:13px;"></td>
      </tr>`;
    }
    const paidBy = payerDisplay_(b['Paid By'], personA, personB);
    return `<tr>
      <td style="${border}padding:8px 0;color:#bbbbbb;white-space:nowrap;font-size:13px;">${formatDateShort_(b['Date'])}</td>
      <td style="${border}padding:8px 4px;color:#111111;font-size:13px;">${b['Place'] || ''}</td>
      <td style="${border}padding:8px 4px;font-size:13px;">
        <span style="background:#f5f5f5;color:#333333;font-size:11px;padding:2px 8px;border-radius:4px;">${paidBy}</span>
      </td>
      <td style="${border}padding:8px 0;text-align:right;color:#111111;font-size:13px;">${fmtAmt_(b['Grand Total'], currency)}</td>
    </tr>`;
  }).join('');

  const openBtn   = `<a href="${appUrl   || '#'}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:13px;padding:8px 16px;border-radius:6px;font-weight:500;">Open SplitApp</a>`;
  const sheetsBtn = `<a href="${sheetUrl || '#'}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:13px;padding:8px 16px;border-radius:6px;font-weight:500;margin-left:8px;">View in Sheets</a>`;

  return `<!DOCTYPE html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><style>body,table,td,p,a,span{-webkit-text-size-adjust:100%;}</style></head><body style="margin:0;padding:0;font-family:sans-serif;background-color:#f3f2ef;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f2ef" style="background-color:#f3f2ef;padding:16px 0;">
<tr><td align="center" style="padding:0 8px;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dddddd;max-width:520px;">

  <tr><td style="padding:20px 24px 18px;border-bottom:1px solid #eeeeee;">
    <p style="margin:0;font-size:11px;color:#999999;letter-spacing:0.08em;font-weight:500;">SPLITAPP</p>
    <p style="margin:4px 0 0;font-size:20px;font-weight:500;color:#111111;">Weekly summary</p>
    <p style="margin:2px 0 0;font-size:12px;color:#999999;">${formatDateLabel_(new Date())}</p>
  </td></tr>

  <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:20px 24px;">

    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f9f9f9" style="background-color:#f9f9f9;border-radius:8px;border:1px solid #eeeeee;margin-bottom:20px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 12px;font-size:11px;color:#999999;font-weight:500;letter-spacing:0.06em;">CURRENT BALANCE</p>
        <table width="100%" cellpadding="0" cellspacing="12">
          <tr>
            <td width="50%" bgcolor="#ffffff" style="background-color:#ffffff;border-left:3px solid #1D9E75;border-top:1px solid #eeeeee;border-right:1px solid #eeeeee;border-bottom:1px solid #eeeeee;border-radius:0 6px 6px 0;padding:10px 14px;">
              <p style="margin:0;font-size:11px;color:#999999;">${receiverName}</p>
              <p style="margin:4px 0 2px;font-size:18px;font-weight:500;color:#111111;">${fmtAmt_(absBalance, currency)}</p>
              <p style="margin:0;font-size:11px;color:#555555;">will receive</p>
            </td>
            <td width="50%" bgcolor="#ffffff" style="background-color:#ffffff;border-left:3px solid #E24B4A;border-top:1px solid #eeeeee;border-right:1px solid #eeeeee;border-bottom:1px solid #eeeeee;border-radius:0 6px 6px 0;padding:10px 14px;">
              <p style="margin:0;font-size:11px;color:#999999;">${payerName}</p>
              <p style="margin:4px 0 2px;font-size:18px;font-weight:500;color:#111111;">${fmtAmt_(absBalance, currency)}</p>
              <p style="margin:0;font-size:11px;color:#555555;">needs to pay</p>
            </td>
          </tr>
        </table>
        <p style="margin:10px 0 0;font-size:11px;color:#bbbbbb;text-align:center;">across ${totalBills} bill${totalBills === 1 ? '' : 's'}</p>
      </td></tr>
    </table>

    <p style="margin:0 0 10px;font-size:11px;color:#999999;font-weight:500;letter-spacing:0.06em;">LAST 10 BILLS</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:1px solid #eeeeee;">
          <th style="text-align:left;padding:0 0 6px;font-weight:500;color:#bbbbbb;font-size:11px;">DATE</th>
          <th style="text-align:left;padding:0 4px 6px;font-weight:500;color:#bbbbbb;font-size:11px;">PLACE</th>
          <th style="text-align:left;padding:0 4px 6px;font-weight:500;color:#bbbbbb;font-size:11px;">PAID BY</th>
          <th style="text-align:right;padding:0 0 6px;font-weight:500;color:#bbbbbb;font-size:11px;">TOTAL</th>
        </tr>
      </thead>
      <tbody>${billRows}</tbody>
    </table>

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eeeeee;">
      ${openBtn}${sheetsBtn}
    </div>

    <p style="margin:16px 0 0;font-size:11px;color:#cccccc;">Sent every Monday at 8:00 AM · GS v${gsVersion}</p>

  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function buildNoBillsHtml_(personA, personB, subject, appUrl, sheetUrl, gsVersion) {
  const openBtn   = `<a href="${appUrl   || '#'}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:13px;padding:8px 16px;border-radius:6px;font-weight:500;">Open SplitApp</a>`;
  const sheetsBtn = `<a href="${sheetUrl || '#'}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:13px;padding:8px 16px;border-radius:6px;font-weight:500;margin-left:8px;">View in Sheets</a>`;
  return `<!DOCTYPE html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><style>body,table,td,p,a,span{-webkit-text-size-adjust:100%;}</style></head><body style="margin:0;padding:0;font-family:sans-serif;background-color:#f3f2ef;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f2ef" style="background-color:#f3f2ef;padding:16px 0;">
<tr><td align="center" style="padding:0 8px;">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dddddd;max-width:520px;">
  <tr><td style="padding:20px 24px 18px;border-bottom:1px solid #eeeeee;">
    <p style="margin:0;font-size:11px;color:#999999;letter-spacing:0.08em;font-weight:500;">SPLITAPP</p>
    <p style="margin:4px 0 0;font-size:20px;font-weight:500;color:#111111;">Weekly summary</p>
    <p style="margin:2px 0 0;font-size:12px;color:#999999;">${formatDateLabel_(new Date())}</p>
  </td></tr>
  <tr><td style="padding:24px;">
    <p style="margin:0;font-size:15px;color:#111111;">No bills logged yet.</p>
    <p style="margin:8px 0 20px;font-size:13px;color:#666666;">Add your first expense in SplitApp to start tracking.</p>
    <div>${openBtn}${sheetsBtn}</div>
    <p style="margin:16px 0 0;font-size:11px;color:#cccccc;">Sent every Monday at 8:00 AM · GS v${gsVersion}</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
