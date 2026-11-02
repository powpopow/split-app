// SplitApp — persistence layer (Google Sheets Web App + localStorage).
// Ported from splitapp.html sync functions, with two audit fixes baked in:
//   #120 — payer is read/written as a stable 'a'|'b' key (never the display name).
//   #121 — callers treat local state as authoritative; no destructive re-pull right
//          after a write (see store.js). These functions just do I/O.
//
// All functions take an explicit `sheetUrl` so dev can point at a TEST deployment and
// prod is a one-line switch at cutover.

import { getIdToken, refreshIdToken } from './auth.js';
import { CONFIG_DEFAULTS } from './config.js';

const LS_STATE = 'splitapp_state';
const LS_CONFIG = 'splitapp_config';

// ── localStorage cache ───────────────────────────────────
export function loadLocal() {
  let state = null, config = null;
  try { const s = localStorage.getItem(LS_STATE); if (s) state = JSON.parse(s); } catch {}
  try { const c = localStorage.getItem(LS_CONFIG); if (c) config = JSON.parse(c); } catch {}
  return { state, config };
}

export function saveLocal(state, config) {
  try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch {}
  if (config) {
    try {
      localStorage.setItem(LS_CONFIG, JSON.stringify({
        personA: config.personA, personB: config.personB,
        currency: config.currency, currencySymbol: config.currencySymbol,
        geminiApiKey: config.geminiApiKey, googleSheetUrl: config.googleSheetUrl,
      }));
    } catch {}
  }
}

// ── payer key (#120) ─────────────────────────────────────
// New rows store 'a'/'b'. Legacy rows store a display name — map it once, rename-proof
// going forward. Returns 'a' | 'b'.
export function readPaidBy(raw, cfg = {}) {
  const v = String(raw ?? '').trim();
  if (v === 'a' || v === 'b') return v;
  if (v && v === (cfg.personA || '')) return 'a';
  if (v && v === (cfg.personB || '')) return 'b';
  return 'a'; // legacy-only fallback
}

// ── reads (GET) ──────────────────────────────────────────
export async function fetchConfig(sheetUrl) {
  if (!sheetUrl) return {};
  const data = await call(sheetUrl, { action: 'getConfig' });
  if (data.error) throw new Error(data.error);
  return data.config || {};
}

export async function fetchBills(sheetUrl, cfg = {}) {
  if (!sheetUrl) return [];
  const data = await call(sheetUrl, { action: 'getBills' });
  if (data.error) throw new Error(data.error);
  if (!Array.isArray(data.bills)) throw new Error('unexpected response'); // never treat a bad reply as 'no bills'
  return data.bills.map((r) => ({
    id: String(r.ID || r.id || Date.now()),
    date: normDate(r.Date || r.date),
    place: r.Place || r.place || '',
    category: r.Category || r.category || '',
    paidBy: readPaidBy(r['Paid By'] ?? r.paidBy, cfg),
    grandTotal: parseFloat(r['Grand Total'] ?? r.grandTotal) || 0,
    shareA: parseFloat(r['Share A'] ?? r.shareA) || 0,
    shareB: parseFloat(r['Share B'] ?? r.shareB) || 0,
    items: safeJSON(r.items_json, []),
    charges: safeJSON(r.charges_json, null),
    ocrJson: safeJSON(r.ocr_json, null), // #102 raw OCR (for debug/compare + preserved on edit)
    ocrMeta: safeJSON(r.ocr_meta, null), // #169 OCR telemetry
  }));
}

// ── writes (POST) ─────────────────────────────────────────
// #162 (A) — readable "simple request": a string body defaults to text/plain and we set NO
// Content-Type header, so the browser sends NO CORS preflight (the preflight from application/json
// was the whole reason #10 went no-cors). The Apps Script response then reads just like our GETs,
// so callers get { ok } back and can confirm/retry instead of firing blind. Never throws.
// Every request carries the Google ID token; the Apps Script backend verifies it and checks the
// email against the allow-list. On 'unauthorized' we try one silent token refresh, then retry once;
// if that fails the store is told to sign out (queued writes stay in the outbox).
let unauthorizedHandler = null;
export const onUnauthorized = (fn) => { unauthorizedHandler = fn; };

async function rawPost(sheetUrl, body) {
  const resp = await fetch(sheetUrl, { method: 'POST', body: JSON.stringify({ ...body, idToken: getIdToken() }) });
  return resp.json().catch(() => ({ error: 'bad response from server' }));
}

async function call(sheetUrl, body) {
  let data = await rawPost(sheetUrl, body);
  if (data && data.error === 'unauthorized') {
    const fresh = await refreshIdToken(CONFIG_DEFAULTS.googleClientId);
    if (fresh) data = await rawPost(sheetUrl, body);
    if (data && data.error === 'unauthorized' && unauthorizedHandler) unauthorizedHandler();
  }
  return data || {};
}

/** Used by the sign-in screen: which person (a|b) does the stored token belong to? No refresh/retry. */
export const whoami = (sheetUrl) => rawPost(sheetUrl, { action: 'whoami' });

async function post(sheetUrl, body) {
  if (!sheetUrl) return { ok: false, skipped: true };
  try {
    const data = await call(sheetUrl, body);
    return { ok: data.ok === true, error: data.error };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// bill.paidBy is 'a'|'b' — write the KEY, not a name (#120).
const billPayload = (b) => ({
  id: b.id, date: b.date, place: b.place, category: b.category,
  paidBy: b.paidBy, grandTotal: b.grandTotal, shareA: b.shareA, shareB: b.shareB,
  runningBalance: b.runningBalance ?? 0,
  items_json: JSON.stringify(b.items || []),
  charges_json: JSON.stringify(b.charges || {}),
  ocr_json: b.ocrJson ? JSON.stringify(b.ocrJson) : '', // #102 raw Gemini OCR response
  ocr_meta: b.ocrMeta ? JSON.stringify(b.ocrMeta) : '', // #169 OCR telemetry (blank preserves existing server-side)
});

export const postBill   = (sheetUrl, b)  => post(sheetUrl, { action: 'addBill',    bill: billPayload(b) });
export const putBill     = (sheetUrl, b)  => post(sheetUrl, { action: 'updateBill', bill: billPayload(b) });
export const removeBill  = (sheetUrl, id) => post(sheetUrl, { action: 'deleteBill', id });
export const setConfig   = (sheetUrl, key, value) => post(sheetUrl, { action: 'setConfig', key, value });
// #169 fire-and-forget OCR failure telemetry (hard fails that produced no bill). Never throws.
export const logOcrFail  = (sheetUrl, rec) => post(sheetUrl, { action: 'logOcrFail', rec });

// ── helpers ──────────────────────────────────────────────
function safeJSON(raw, fallback) { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function normDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s.includes('T') ? s : s + 'T12:00:00');
  return isNaN(dt.getTime()) ? s : dt.toISOString().split('T')[0];
}
