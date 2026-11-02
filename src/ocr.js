// SplitApp — Gemini Vision receipt OCR (ported from splitapp.html).
// Dynamic model discovery (newest base flash) survives model deprecation, then a
// fallback queue. Returns the parsed receipt JSON.

import { APP_VERSION } from './config.js';

const PROMPT = `Read this receipt and return ONLY valid JSON (no markdown) with these fields:
{
  "date": "YYYY-MM-DD",
  "merchant": "restaurant or store name (English preferred; local script only if no English name exists; empty string if cannot determine)",
  "category": "food|shop|cafe|transport|other",
  "items": [{"name": "item name", "qty": 1, "unit_price": 0, "discount": 0, "discount_label": ""}],
  "service_charge_percent": 0,
  "vat_percent": 0,
  "discounts": [{"description": "text", "amount": 0}],
  "fees": [{"description": "text", "amount": 0}],
  "total": 0
}

Rules:
- items.discount: if a discount/coupon line appears directly BELOW an item (e.g. "PB20% MUJI -30.00"), put that discount on the item as a positive number and set discount_label to its text. Else discount 0, discount_label "".
- service_charge_percent: the % rate (e.g. 10). 0 if none.
- vat_percent: ONLY if VAT is charged as an ADDITIONAL amount on top of subtotal. If "VAT included"/"inclusive", set 0.
- discounts: bill-level coupons/vouchers not tied to a specific item; amount positive.
- fees: extra charges ADDED to the bill that are not VAT or service charge, e.g. delivery fee, platform fee, packaging fee, booking fee, small-order fee; amount positive. Never put discounts here. Empty array if none.
- total: final amount actually paid (after all charges and discounts).`;

export function fileToBase64(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result.split(',')[1]);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

// Newest base flash model that supports generateContent (vision). Falls back to a default.
export async function fetchBestModel(apiKey) {
  const DEFAULT = 'gemini-2.5-flash';
  if (!apiKey) return DEFAULT;
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!resp.ok) return DEFAULT;
    const data = await resp.json();
    const RE = /^gemini-\d+\.\d+-flash(-\d+)?$/;
    const models = (data.models || [])
      .map((m) => m.name.replace('models/', ''))
      .filter((n, i) => RE.test(n) && (data.models[i].supportedGenerationMethods || []).includes('generateContent'))
      .sort((a, b) => parseFloat(b.match(/(\d+\.\d+)/)?.[1] || 0) - parseFloat(a.match(/(\d+\.\d+)/)?.[1] || 0));
    return models[0] || DEFAULT;
  } catch { return DEFAULT; }
}

export async function callGemini(base64, mimeType, apiKey, model, signal) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }] }),
    signal, // #172 user-cancellable
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const code = err?.error?.code || resp.status;
    if (code === 429) throw new Error('RATE_LIMIT');
    if (code === 503) throw new Error('OVERLOADED');
    throw new Error('Gemini API error: ' + code);
  }
  const data = await resp.json();
  const usage = data.usageMetadata || null; // #169 token accounting (incl. thoughtsTokenCount)
  if (!data.candidates?.length) throw new Error('GEMINI_BLOCKED:' + (data.promptFeedback?.blockReason || 'NO_CANDIDATES'));
  const text = data.candidates[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('GEMINI_EMPTY_TEXT');
  let receipt;
  try { receipt = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()); }
  catch { throw new Error('GEMINI_PARSE_FAIL'); }
  return { receipt, usage };
}

// #169 OCR telemetry helpers ------------------------------------------------
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// Image size/format/dimensions for correlating payload with latency (best-effort).
export function imageInfo(file) {
  return new Promise((res) => {
    const info = { kb: Math.round((file.size || 0) / 1024), mime: file.type || '', w: null, h: null };
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { info.w = img.naturalWidth; info.h = img.naturalHeight; URL.revokeObjectURL(url); res(info); };
      img.onerror = () => { URL.revokeObjectURL(url); res(info); };
      img.src = url;
    } catch { res(info); }
  });
}
// #170 — description fed to the AI categorizer: place + item names (names only, empties dropped, capped).
export function catDesc(place, items) {
  const names = (items || []).map((i) => (i.name || '').trim()).filter(Boolean).slice(0, 12).join(', ');
  return [(place || '').trim(), names].filter(Boolean).join(' — ');
}

// Map an OCR error to a compact status code for the attempt log.
function shortStatus(e) {
  if (e && (e.name === 'AbortError' || e.message === 'CANCELLED')) return 'cancelled';
  const m = (e && e.message) || '';
  if (m === 'RATE_LIMIT') return '429';
  if (m === 'OVERLOADED') return '503';
  if (m.startsWith('GEMINI_BLOCKED')) return 'blocked';
  if (m === 'GEMINI_PARSE_FAIL') return 'parsefail';
  if (m === 'GEMINI_EMPTY_TEXT') return 'empty';
  if (m.startsWith('Gemini API error')) return 'err' + (m.replace(/\D+/g, '') || '');
  return 'error';
}
function buildMeta({ ok, model, usage, img, attempts, discMs, discPick, discOk, totalMs, receipt, status }) {
  const u = usage || {}, r = receipt || {};
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    v: APP_VERSION, ts: Date.now(),
    status: ok ? 'ok' : (status || 'failed'),
    model: model || null,
    think: 'default', // baseline: no thinkingConfig sent yet (#169)
    tokens: {
      in: u.promptTokenCount ?? null, out: u.candidatesTokenCount ?? null,
      think: u.thoughtsTokenCount ?? null, total: u.totalTokenCount ?? null,
    },
    ms: { total: totalMs, disc: discMs, api: attempts.reduce((s, a) => s + (a.ms || 0), 0) },
    img, attempts, retries: Math.max(0, attempts.length - 1),
    discovery: { pick: discPick || null, ms: discMs, ok: discOk },
    cx: ok ? {
      items: items.length,
      idisc: items.filter((it) => (it.discount || 0) > 0).length,
      disc: Array.isArray(r.discounts) ? r.discounts.length : 0,
      sc: (r.service_charge_percent || 0) > 0, vat: (r.vat_percent || 0) > 0,
    } : null,
  };
}

// Best-effort background categorization of a manual bill from its description (#148).
// Returns one of food|shop|cafe|transport|other, or null on any failure (offline/quota/error).
export async function categorize(text, apiKey) {
  const desc = (text || '').trim();
  if (!desc || !apiKey) return null;
  try {
    const model = await fetchBestModel(apiKey);
    const prompt = `Classify this expense into exactly one category from this list: food, shop, cafe, transport, other. ` +
      `"food" = restaurants/meals, "cafe" = coffee/dessert, "shop" = shopping/retail, "transport" = taxi/grab/fuel/transit, "other" = anything else. ` +
      `Description: "${desc}". Reply with ONLY the single category word, lowercase.`;
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const out = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').toLowerCase();
    return ['food', 'cafe', 'shop', 'transport', 'other'].find((v) => out.includes(v)) || null;
  } catch { return null; }
}

// Full flow: discover model, try it then known fallbacks. Returns the parsed receipt JSON
// with a `_meta` telemetry object attached (#169). On total failure, throws with `_meta` on the error.
export async function scanReceipt(file, apiKey, signal) {
  if (!apiKey) throw new Error('NO_API_KEY');
  const t0 = _now();
  const img = await imageInfo(file);
  const base64 = await fileToBase64(file);

  const dStart = _now();
  let best, discOk = true;
  try { best = await fetchBestModel(apiKey); }
  catch { best = 'gemini-2.5-flash'; discOk = false; }
  const discMs = Math.round(_now() - dStart);

  const queue = [best, 'gemini-2.5-flash', 'gemini-2.0-flash'].filter((m, i, a) => a.indexOf(m) === i);
  const attempts = [];
  let lastErr;
  for (const model of queue) {
    if (signal && signal.aborted) { lastErr = new Error('CANCELLED'); break; } // #172 user cancelled before/between attempts
    const aStart = _now();
    try {
      const { receipt, usage } = await callGemini(base64, file.type, apiKey, model, signal);
      attempts.push({ m: model, ms: Math.round(_now() - aStart), s: 'ok' });
      receipt._meta = buildMeta({ ok: true, model, usage, img, attempts, discMs, discPick: best, discOk, totalMs: Math.round(_now() - t0), receipt });
      return receipt;
    } catch (e) {
      const cancelled = (signal && signal.aborted) || (e && e.name === 'AbortError'); // #172
      attempts.push({ m: model, ms: Math.round(_now() - aStart), s: cancelled ? 'cancelled' : shortStatus(e) });
      lastErr = cancelled ? new Error('CANCELLED') : e;
      if (cancelled) break; // don't try fallback models when the user cancelled
    }
  }
  const err = lastErr || new Error('OCR_FAILED');
  const cancelled = err.message === 'CANCELLED';
  err._meta = buildMeta({ ok: false, model: null, usage: null, img, attempts, discMs, discPick: best, discOk, totalMs: Math.round(_now() - t0), receipt: null, status: cancelled ? 'cancelled' : shortStatus(err) });
  throw err;
}
