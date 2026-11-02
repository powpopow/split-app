// SplitApp — pure calculation core (money engine + balance ops).
// Faithful port of recalc() and the running-balance operations from splitapp.html.
// No DOM, no globals — inputs in, numbers out. Validated by audit/recalc-harness.js
// and audit/balance-harness.js. Behaviour is intentionally identical to the shipped
// single-file app (including known-buggy edge cases #108 etc.) until later migration
// phases fix them deliberately.

export const SETTLE_EPS = 0.01; // "all settled up" threshold (unified in v2.1.70, #104)
export const isSettled = (bal) => Math.abs(bal) < SETTLE_EPS;

// ── money engine ─────────────────────────────────────────
// items: [{ price, qty, assignment?('a'|'b'|'qty'|'amt'|'custom'|'shared'),
//           qtyA?, qtyB?, amtA?, amtB?, splitA?, splitB?, discount? }]
// charges: { sc?, vat?, scPct?, vatPct?, discounts?: [{ amt, assignTo, amtA?, amtB? }],
//             fees?: [{ amt, assignTo('prop'|'split'|'pct'|'fixed'|'a'|'b'), pctA?, amtA?, amtB? }] }
export function recalc(items = [], charges = {}) {
  const discounts = charges.discounts || [];
  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const scPct = charges.sc ? (charges.scPct || 0) : 0;
  const vatPct = charges.vat ? (charges.vatPct || 0) : 0;

  let itemsA = 0, itemsB = 0, itemDiscA = 0, itemDiscB = 0;
  const totalItemDisc = items.reduce((s, it) => s + (it.discount || 0), 0);
  items.forEach((it) => {
    const total = it.price * it.qty;
    const disc = it.discount || 0;
    if (it.assignment === 'a') { itemsA += total; itemDiscA += disc; }
    else if (it.assignment === 'b') { itemsB += total; itemDiscB += disc; }
    else if (it.assignment === 'qty') {
      const qA = it.qtyA || 0, qB = it.qtyB || 0, qTotal = qA + qB;
      itemsA += it.price * qA; itemsB += it.price * qB;
      if (disc && qTotal > 0) { itemDiscA += disc * qA / qTotal; itemDiscB += disc * qB / qTotal; }
    }
    else if (it.assignment === 'amt') {
      itemsA += it.amtA || 0; itemsB += it.amtB || 0;
      if (disc && total > 0) { itemDiscA += disc * (it.amtA || 0) / total; itemDiscB += disc * (it.amtB || 0) / total; }
    }
    else {
      const splitA = (it.splitA || 50) / 100, splitB = (it.splitB || 50) / 100;
      itemsA += total * splitA; itemsB += total * splitB;
      if (disc) { itemDiscA += disc * splitA; itemDiscB += disc * splitB; }
    }
  });

  let personalDiscA = 0, personalDiscB = 0;
  discounts.forEach((d) => {
    const amt = d.amt || 0;
    if (d.assignTo === 'a') personalDiscA += amt;
    else if (d.assignTo === 'b') personalDiscB += amt;
  });

  const ratio = subtotal > 0 ? itemsA / subtotal : 0.5;
  const base0 = Math.max(0, subtotal - totalItemDisc - personalDiscA - personalDiscB); // pre-tax base (items + personal disc)

  // Shared/bill-level discounts: split by method, then place in the tax stack by taxStage (#137).
  //   pre    = before SC & VAT (reduces both bases)   preVat = after SC, before VAT (reduces VAT base only)
  //   preSc  = before SC, after VAT (reduces SC only)  post  = after both (reduces neither)
  // Legacy: beforeTax=true → 'pre', else 'post'. A discount is always subtracted once from the total;
  // taxStage only governs which tax bases it shrinks.
  let sharedA = 0, sharedB = 0, scReduce = 0, vatReduce = 0;
  discounts.forEach((d) => {
    if (d.assignTo === 'a' || d.assignTo === 'b') return; // personal — pre-tax, handled above
    const amt = d.amt || 0;
    let dA = 0, dB = 0;
    if (d.assignTo === 'split') { dA = amt / 2; dB = amt / 2; }
    else if (d.assignTo === 'prop') { dA = amt * ratio; dB = amt * (1 - ratio); }
    else if (d.assignTo === 'fixed') { dA = d.amtA || 0; dB = d.amtB || 0; }
    else if (d.assignTo === 'pct') { const pa = (d.pctA ?? 50) / 100; dA = amt * pa; dB = amt * (1 - pa); } // #111
    else return;
    const stage = d.taxStage || (d.beforeTax ? 'pre' : 'post');
    const t = dA + dB;
    sharedA += dA; sharedB += dB;
    if (stage === 'pre' || stage === 'preSc') scReduce += t;   // reduces SC base
    if (stage === 'pre' || stage === 'preVat') vatReduce += t; // reduces VAT base
  });

  // Extra fees (delivery / platform / packaging): ADDED after tax, outside the SC/VAT bases.
  // Default 'prop' follows each person's share of the food (same ratio as shared discounts).
  let feeA = 0, feeB = 0;
  (charges.fees || []).forEach((f) => {
    const amt = f.amt || 0;
    if (f.assignTo === 'a') feeA += amt;
    else if (f.assignTo === 'b') feeB += amt;
    else if (f.assignTo === 'split') { feeA += amt / 2; feeB += amt / 2; }
    else if (f.assignTo === 'fixed') { feeA += f.amtA || 0; feeB += f.amtB || 0; }
    else if (f.assignTo === 'pct') { const pa = (f.pctA ?? 50) / 100; feeA += amt * pa; feeB += amt * (1 - pa); }
    else { feeA += amt * ratio; feeB += amt * (1 - ratio); } // 'prop' (default)
  });

  const scBase = Math.max(0, base0 - scReduce);
  const sc = scBase * scPct / 100;
  const vatBase = Math.max(0, base0 + sc - vatReduce);
  const vat = vatBase * vatPct / 100;

  const chargesA = (sc + vat) * ratio;
  const chargesB = (sc + vat) * (1 - ratio);
  const shareA = Math.max(0, itemsA - itemDiscA - personalDiscA - sharedA + chargesA + feeA);
  const shareB = Math.max(0, itemsB - itemDiscB - personalDiscB - sharedB + chargesB + feeB);
  const grandTotal = Math.max(0, base0 + sc + vat - sharedA - sharedB + feeA + feeB);
  const sharedDiscA = sharedA, sharedDiscB = sharedB;
  const preTaxBase = base0; // return-compat

  return {
    subtotal, sc, scPct, vat, vatPct, discounts,
    itemsA, itemsB, itemDiscA, itemDiscB,
    personalDiscA, personalDiscB, sharedDiscA, sharedDiscB,
    chargesA, chargesB, feeA, feeB, shareA, shareB, grandTotal, ratio,
  };
}

// ── running-balance ops ──────────────────────────────────
// Convention: balance > 0 = B owes A; < 0 = A owes B.
// bill: { paidBy('a'|'b'), grandTotal, shareA, shareB }
export const addBal = (bal, b) => (b.paidBy === 'a' ? bal + b.shareB : bal - b.shareA);
export const reverseBal = (bal, o) => (o.paidBy === 'a' ? bal - (o.grandTotal - o.shareA) : bal + o.shareA);
export const deleteBal = (bal, b) => (b.paidBy === 'a' ? bal - (b.grandTotal - b.shareA) : bal + b.shareA);
export const editBal = (bal, oldB, newB) => addBal(reverseBal(bal, oldB), newB);
export const myBal = (bal, user) => (user === 'b' ? -bal : bal);
export const previewNew = (bal, b) => (b.paidBy === 'a' ? bal + b.shareB : bal - b.shareA);

// Recompute total balance from a list of bills (matches syncFromSheets L4104).
export const balanceFromBills = (bills) =>
  bills.reduce((bal, b) => (b.paidBy === 'a' ? bal + (b.shareB || 0) : bal - (b.shareA || 0)), 0);

// #136/#137 — infer the discount tax stage by matching the receipt's printed total.
// Returns 'pre' | 'preVat' | 'preSc' | 'post' | 'either' (all identical, e.g. no tax) | null (can't tell).
export const TAX_STAGES = ['pre', 'preVat', 'preSc', 'post'];
export function detectDiscountTiming(items, charges, receiptTotal) {
  const shared = (charges.discounts || []).filter((d) => d.assignTo !== 'a' && d.assignTo !== 'b');
  if (!receiptTotal || receiptTotal <= 0 || shared.length === 0) return null;
  const matches = TAX_STAGES.filter((stage) => {
    const gt = recalc(items, { ...charges, discounts: (charges.discounts || []).map((d) => ({ ...d, taxStage: stage })) }).grandTotal;
    return Math.abs(gt - receiptTotal) < 0.02;
  });
  if (matches.length === 0) return null;                 // nothing matches → ask
  if (matches.length === TAX_STAGES.length) return 'either'; // no SC & no VAT → all identical
  for (const s of ['pre', 'post', 'preVat', 'preSc']) if (matches.includes(s)) return s; // simplest first
  return matches[0];
}
