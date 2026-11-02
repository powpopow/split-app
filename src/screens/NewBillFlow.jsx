// SplitApp — new-bill write path (manual entry → assign → confirm → save).
// Draft lives in THIS component's state, so every open starts clean (structurally avoids
// #112/#117/#118). Items carry a stable `id` (React key + assignment identity → #110/#113/#114).
// SC/VAT inputs are component-scoped (no duplicate DOM ids → #116). paidBy is 'a'|'b' (#120).
import { useState, useRef, useEffect } from 'react';
import { useStore } from '../store.jsx';
import { recalc, detectDiscountTiming } from '../calc.js';
import { fmtMoney, fmtDate, initials } from '../format.js';
import { scanReceipt, categorize, catDesc } from '../ocr.js';
import { logOcrFail } from '../api.js';
import { evalExpr } from '../expr.js';

const STAGE_OPTS = [
  { v: 'pre', l: 'Before tax' },
  { v: 'preVat', l: 'Before VAT only' },
  { v: 'preSc', l: 'Before SC only' },
  { v: 'post', l: 'After tax' },
];
const stageLabel = (d) => (STAGE_OPTS.find((s) => s.v === (d.taxStage || (d.beforeTax ? 'pre' : 'post'))) || STAGE_OPTS[3]).l;

const SCAN_MESSAGES = ['Uploading photo…', 'Reading items & prices…', 'Extracting charges & totals…', 'Almost done…'];

const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function NewBillFlow({ onClose, onMinimize, editing, onSaved }) {
  const { addBill, editBill, config, projectedBalance, showToast, currentUser } = useStore();
  const sym = config.currencySymbol;
  const nameA = config.personA || 'You';
  const nameB = config.personB || 'Them';

  // Seed items (ensuring stable ids even for legacy bills) and derive matching entry rows.
  const seedItems = (editing?.items || []).map((it) => ({ ...it, id: it.id || uid() }));
  const [step, setStep] = useState('entry');
  const [tab, setTab] = useState(editing ? 'manual' : 'upload');
  const [rows, setRows] = useState(seedItems.length
    ? seedItems.map((it) => ({ id: it.id, name: it.name, qty: it.qty, total: (it.price * it.qty).toFixed(2) }))
    : [{ id: uid(), name: '', qty: 1, total: '' }]);
  const [place, setPlace] = useState(editing?.place || '');
  const [date, setDate] = useState(editing?.date || today());
  const [category, setCategory] = useState(editing?.category || 'other');
  const [categoryTouched, setCategoryTouched] = useState(false); // #170 user picked a category → don't AI-override
  const [paidBy, setPaidBy] = useState(editing?.paidBy || null);
  const [items, setItems] = useState(seedItems);
  const [charges, setCharges] = useState({ sc: false, scPct: 10, vat: false, vatPct: 7, discounts: [], ...(editing?.charges || {}) });
  const [disc, setDisc] = useState({ amt: '', label: '', target: 'split', pctA: 50, amtA: '', amtB: '', taxStage: 'post' });
  const [fee, setFee] = useState({ label: '', amt: '' });       // manual "+ add fee" draft (delivery/platform/…)
  const [showFeeEditor, setShowFeeEditor] = useState(false);
  const [receiptTotal, setReceiptTotal] = useState(editing?.charges?.receiptTotal ?? null); // OCR scanned total → compare vs computed (#144)
  const [ocrJson, setOcrJson] = useState(editing?.ocrJson ?? null); // raw Gemini OCR response, persisted for debug/compare (#102)
  const [ocrMeta, setOcrMeta] = useState(editing?.ocrMeta ?? null); // #169 OCR telemetry (timings/tokens/attempts)
  const [whoPaidPrompt, setWhoPaidPrompt] = useState(null); // merchant string → show "who paid?" popup after OCR (#140)
  const [timingPrompt, setTimingPrompt] = useState(null); // { count, total, label } when OCR timing is ambiguous (#136)
  const [promptMore, setPromptMore] = useState(false);     // prompt: rare stages revealed
  const [discAdvanced, setDiscAdvanced] = useState(false); // manual editor: 4-way stage picker revealed
  const [ocrPlace, setOcrPlace] = useState(false);         // place was OCR-filled → show "tap to verify" note (#139)
  const [showDiscEditor, setShowDiscEditor] = useState(false); // charges card: discount editor collapsed by default (#139)
  const [assignMode, setAssignMode] = useState(null); // Review tap-to-assign active name: null | 'a' | 'b' | 'shared' (#141)
  const [openDd, setOpenDd] = useState(null);         // item/discount id whose reassign dropdown is open (#141/#142)
  const [openStage, setOpenStage] = useState(null);   // discount id whose tax-stage dropdown is open (#142)
  // Assign a discount (who) + its tax stage (when), edited right in the assign list (#142).
  const setDiscTo = (id, assignTo) => setCharges((c) => ({ ...c, discounts: c.discounts.map((d) => d.id === id ? { ...d, assignTo, ...(assignTo === 'pct' && d.pctA == null ? { pctA: 50 } : {}), ...(assignTo === 'fixed' && d.amtA == null ? { amtA: d.amt || 0, amtB: 0 } : {}) } : d) }));
  const setDiscField = (id, patch) => setCharges((c) => ({ ...c, discounts: c.discounts.map((d) => d.id === id ? { ...d, ...patch } : d) }));
  // Per-person "+ discount" on the Assign person boxes (#145).
  const [pdBox, setPdBox] = useState(null); // 'a' | 'b' | null — which box's add-form is open
  const [pdAmt, setPdAmt] = useState('');
  const [pdLabel, setPdLabel] = useState('');
  // Receipt-total compare + one-tap reconcile (#144, ported).
  const matchReceipt = (computed) => {
    const diff = Math.round((computed - (receiptTotal || 0)) * 100) / 100;
    if (diff <= 0) return;
    setCharges((c) => ({ ...c, discounts: [...c.discounts, { id: uid(), amt: diff, label: 'Rounding', assignTo: 'split', taxStage: 'post' }] }));
  };
  const receiptCompare = (computed) => {
    if (!(receiptTotal > 0)) return null;
    const diff = computed - receiptTotal;
    const ok = Math.abs(diff) < 0.02;
    return (
      <div style={{ fontSize: 11, marginTop: 4 }}>
        <span style={{ color: ok ? '#2a9d5c' : '#e08700' }}>Receipt: {fmtMoney(receiptTotal, sym)} {ok ? '✓' : '⚠'}</span>
        {diff > 0.02 && <span onClick={() => matchReceipt(computed)} style={{ color: 'var(--acc)', cursor: 'pointer', textDecoration: 'underline', marginLeft: 6 }}>Match receipt</span>}
      </div>
    );
  };
  const addPersonDisc = (who) => {
    const amt = parseFloat(pdAmt) || 0;
    if (!amt) { setPdBox(null); return; }
    setCharges((c) => ({ ...c, discounts: [...c.discounts, { id: uid(), amt, label: pdLabel || 'Discount', assignTo: who }] }));
    setPdAmt(''); setPdLabel(''); setPdBox(null);
  };
  // Discount chip helpers — component scope so BOTH the entry CHARGES card and the Assign list reuse them (#151/#142).
  const discChip = (d) => d.assignTo === 'a' ? ['chip-a', nameA]
    : d.assignTo === 'b' ? ['chip-b', nameB]
    : d.assignTo === 'pct' ? ['chip-custom', `${d.pctA || 50}/${100 - (d.pctA || 50)}%`]
    : d.assignTo === 'prop' ? ['chip-shared', 'Prop']
    : d.assignTo === 'fixed' ? ['chip-custom', 'Fixed']
    : ['chip-shared', 'Both']; // 'split'
  const discShared = (d) => d.assignTo !== 'a' && d.assignTo !== 'b';
  const DISC_SHARE = [['split', '#aaa', 'Both (50/50)'], ['prop', '#888', 'Proportional'], ['pct', '#5340b0', 'Custom %'], ['fixed', '#888', 'Fixed ฿']];
  // tap the chip → cycle A → B → Shared; share sub-mode via ▾.
  const cycleDisc = (d) => { const cur = d.assignTo === 'a' ? 'a' : d.assignTo === 'b' ? 'b' : 'shared'; const order = ['a', 'b', 'shared']; const next = order[(order.indexOf(cur) + 1) % 3]; setDiscTo(d.id, next === 'shared' ? 'split' : next); };
  const tapDisc = (d) => { if (!assignMode) return; setDiscTo(d.id, assignMode === 'shared' ? 'split' : assignMode); };
  // Colored, tappable tax-stage chip shown BEFORE the discount name.
  // Personal (a/b) discounts are always pre-tax → show a static "Before tax" tag (no ▾). Shared → tappable stage picker. (#154 follow-up)
  const stageChip = (d, isPersonal) => {
    if (isPersonal) {
      return <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#E6F1FB', color: '#185FA5', marginRight: 6, verticalAlign: 'middle', whiteSpace: 'nowrap' }}>Before tax</span>;
    }
    const pre = d.taxStage && d.taxStage !== 'post';
    const short = d.taxStage === 'preVat' ? 'Before VAT' : d.taxStage === 'preSc' ? 'Before SC' : pre ? 'Before tax' : 'After tax';
    return (
      <span className="assign-dd-wrap" onClick={(e) => e.stopPropagation()} style={{ marginRight: 6, verticalAlign: 'middle' }}>
        <span onClick={() => setOpenStage((s) => (s === d.id ? null : d.id))} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: pre ? '#E6F1FB' : '#F1EFE8', color: pre ? '#185FA5' : '#5F5E5A', cursor: 'pointer', whiteSpace: 'nowrap' }}>{short} ▾</span>
        <div className={'assign-dropdown' + (openStage === d.id ? ' open' : '')} style={{ left: 0, right: 'auto' }}>
          {STAGE_OPTS.map((s) => (<div key={s.v} className="assign-dd-opt" onClick={() => { setDiscField(d.id, { taxStage: s.v }); setOpenStage(null); }}>{s.l}</div>))}
        </div>
      </span>
    );
  };

  // ── Quick-split manual flow (#147) ──
  // Detect a quick bill even after a Sheet reload (mode/quick may only survive inside charges, or infer from empty items).
  const editQuick = editing?.quick || editing?.charges?.quick || null;
  const isQuick = editing?.mode === 'quick' || editing?.charges?.mode === 'quick'
    || (!!editing && (editing.items || []).length === 0 && (editing.grandTotal || 0) > 0);
  const [scanned, setScanned] = useState(false);       // OCR done → show itemized entry (not the Manual/quick tab)
  const [qTotal, setQTotal] = useState(editQuick?.totalExpr ?? (isQuick ? String(editing.grandTotal ?? '') : ''));
  const [qA, setQA] = useState(editQuick?.aExpr ?? '');
  const [qB, setQB] = useState(editQuick?.bExpr ?? '');
  const lastTotal = useRef(0), lastA = useRef(0), lastB = useRef(0);
  const fieldVal = (expr, ref) => { const s = (expr || '').trim(); if (s === '') { ref.current = 0; return 0; } const v = evalExpr(expr); if (v != null) ref.current = v; return ref.current; };

  // ── Review tap-to-assign handlers (#141, ported from old app) ──
  const setItemAssign = (id, patch) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const pickMode = (m) => { setOpenDd(null); setAssignMode((cur) => (cur === m ? null : m)); };
  const tapItem = (it) => {
    if (!assignMode) return;
    if (assignMode === 'shared' && it.assignment === 'shared') { setOpenDd((d) => (d === it.id ? null : it.id)); return; }
    if (it.assignment === assignMode) setItemAssign(it.id, { assignment: 'shared', splitA: 50, splitB: 50 });
    else setItemAssign(it.id, { assignment: assignMode, ...(assignMode === 'shared' ? { splitA: 50, splitB: 50 } : {}) });
  };
  const setDirect = (id, val) => { setOpenDd(null); setItemAssign(id, { assignment: val, ...(val === 'shared' ? { splitA: 50, splitB: 50 } : {}) }); };

  // Returns true if a discount was added (so the caller can collapse the editor).
  const addDiscount = () => {
    const amt = parseFloat(disc.amt) || 0;
    const id = uid();
    const ts = disc.taxStage || 'post';
    let entry;
    if (disc.target === 'a' || disc.target === 'b') { if (!amt) return false; entry = { id, amt, label: disc.label || 'Discount', assignTo: disc.target }; }
    else if (disc.target === 'fixed') { const a = parseFloat(disc.amtA) || 0, b = parseFloat(disc.amtB) || 0; if (!a && !b) return false; entry = { id, amt: a + b, amtA: a, amtB: b, label: disc.label || 'Voucher', assignTo: 'fixed', taxStage: ts }; }
    else if (disc.target === 'pct') { if (!amt) return false; entry = { id, amt, pctA: disc.pctA, label: disc.label || 'Voucher', assignTo: 'pct', taxStage: ts }; }
    else { if (!amt) return false; entry = { id, amt, label: disc.label || 'Voucher', assignTo: disc.target, taxStage: ts }; } // split | prop
    setCharges((c) => ({ ...c, discounts: [...c.discounts, entry] }));
    setDisc({ amt: '', label: '', target: 'split', pctA: 50, amtA: '', amtB: '', taxStage: 'post' });
    return true;
  };
  const rmDisc = (id) => setCharges((c) => ({ ...c, discounts: c.discounts.filter((d) => d.id !== id) }));
  // Fees (delivery/platform/…): added after tax, split by a chosen mode; default 'prop' = follow each person's food share.
  const setFeeField = (id, patch) => setCharges((c) => ({ ...c, fees: (c.fees || []).map((f) => f.id === id ? { ...f, ...patch } : f) }));
  const setFeeMode = (id, assignTo) => setCharges((c) => ({ ...c, fees: (c.fees || []).map((f) => f.id === id ? { ...f, assignTo, ...(assignTo === 'pct' && f.pctA == null ? { pctA: 50 } : {}), ...(assignTo === 'fixed' && f.amtA == null ? { amtA: f.amt || 0, amtB: 0 } : {}) } : f) }));
  const rmFee = (id) => setCharges((c) => ({ ...c, fees: (c.fees || []).filter((f) => f.id !== id) }));
  const addFee = () => {
    const amt = parseFloat(fee.amt) || 0;
    if (!amt) return false;
    setCharges((c) => ({ ...c, fees: [...(c.fees || []), { id: uid(), amt, label: fee.label || 'Fee', assignTo: 'prop' }] }));
    setFee({ label: '', amt: '' });
    return true;
  };
  // Apply a tax stage to all shared (non-personal) discounts (#136/#137).
  const setAllTiming = (stage) => { setCharges((c) => ({ ...c, discounts: c.discounts.map((d) => (d.assignTo === 'a' || d.assignTo === 'b') ? d : { ...d, taxStage: stage }) })); setTimingPrompt(null); setPromptMore(false); };

  // ── OCR ──
  const fileInput = useRef(null);
  const scanAbortRef = useRef(null); // #172 AbortController for the in-flight scan
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState(SCAN_MESSAGES[0]);
  const [scanElapsed, setScanElapsed] = useState(0); // #172 seconds since the scan started
  useEffect(() => {
    if (!scanning) { setScanElapsed(0); return; }
    let i = 0; setScanMsg(SCAN_MESSAGES[0]); setScanElapsed(0);
    const t = setInterval(() => { i = (i + 1) % SCAN_MESSAGES.length; setScanMsg(SCAN_MESSAGES[i]); }, 5000);
    const e = setInterval(() => setScanElapsed((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(e); };
  }, [scanning]);
  const cancelScan = () => { try { scanAbortRef.current && scanAbortRef.current.abort(); } catch {} }; // #172
  const handleScan = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!config.geminiApiKey) return alert('No Gemini API key set — add it in Settings → Connection.');
    setScanning(true);
    const controller = new AbortController(); // #172 lets the user cancel a slow scan
    scanAbortRef.current = controller;
    try {
      const r = await scanReceipt(file, config.geminiApiKey, controller.signal);
      const newRows = (r.items || []).map((it) => ({
        id: uid(), name: it.name || '', qty: parseInt(it.qty) || 1,
        total: ((it.unit_price || 0) * (parseInt(it.qty) || 1)).toFixed(2),
        discount: it.discount || 0, discountLabel: it.discount_label || '',
      }));
      setRows(newRows.length ? newRows : [{ id: uid(), name: '', qty: 1, total: '' }]);
      setItems([]);
      if (r.merchant) { setPlace(r.merchant); setOcrPlace(true); }
      if (r.date) setDate(r.date);
      if (['food', 'shop', 'cafe', 'transport', 'other'].includes(r.category)) setCategory(r.category);

      const scPct = r.service_charge_percent || 0, vatPct = r.vat_percent || 0;
      let shared = (r.discounts || []).filter((d) => d.amount > 0).map((d) => ({ id: uid(), amt: d.amount, label: d.description || 'Discount', assignTo: 'split', taxStage: 'post', ocr: true }));
      const fees = (r.fees || []).filter((f) => f.amount > 0).map((f) => ({ id: uid(), amt: f.amount, label: f.description || 'Fee', assignTo: 'prop', ocr: true }));
      const nextCharges = { sc: scPct > 0, scPct: scPct || charges.scPct, vat: vatPct > 0, vatPct: vatPct || charges.vatPct, discounts: shared, fees };

      // #136/#137 — infer the tax stage from the receipt total; ask only if it can't be determined.
      if (shared.length && (nextCharges.sc || nextCharges.vat) && r.total) {
        const detItems = (r.items || []).map((it) => ({ price: it.unit_price || 0, qty: parseInt(it.qty) || 1, discount: it.discount || 0 }));
        const stage = detectDiscountTiming(detItems, nextCharges, r.total);
        if (stage && stage !== 'either') {
          nextCharges.discounts = shared.map((d) => ({ ...d, taxStage: stage }));
        } else if (stage === null) {
          setTimingPrompt({ count: shared.length, total: shared.reduce((s, d) => s + d.amt, 0), label: shared.length === 1 ? shared[0].label : null }); // ambiguous → ask
        }
      }
      setCharges((c) => ({ ...c, ...nextCharges }));
      setScanned(true); // show the itemized entry to verify (NOT the Manual/quick tab) — #147
      setReceiptTotal(r.total && r.total > 0 ? r.total : null); // #144
      setOcrJson(r); // #102 — stash the raw OCR response to persist with the bill
      setOcrMeta(r._meta || null); // #169 — stash OCR telemetry to persist on the bill

      // Prompt for who paid right after the scan, like the old app (#140).
      setPaidBy(null);
      setWhoPaidPrompt(r.merchant || 'this bill');
    } catch (err) {
      const m = err.message || '';
      const cancelled = m === 'CANCELLED' || err.name === 'AbortError'; // #172 user tapped Cancel
      // #169/#172 — log the failed/cancelled scan to OCR_Fail (fire-and-forget). No bill was produced.
      try {
        const fm = err._meta || {};
        if (config.googleSheetUrl) logOcrFail(config.googleSheetUrl, {
          appVersion: fm.v || '', gs: config.gsVersion || '', person: currentUser,
          status: fm.status || m || 'failed',
          attempts: (fm.attempts || []).map((a) => `${a.m}:${a.s}@${a.ms}ms`).join(' → '),
          totalMs: fm.ms?.total ?? '', discMs: fm.ms?.disc ?? '',
          imgKB: fm.img?.kb ?? '', imgWH: fm.img ? `${fm.img.w || '?'}x${fm.img.h || '?'}` : '',
          mime: fm.img?.mime || '',
          discovery: fm.discovery ? `${fm.discovery.pick || ''}(${fm.discovery.ok ? 'ok' : 'fail'})` : '',
          error: m,
        });
      } catch {}
      if (!cancelled) alert(m === 'RATE_LIMIT' ? 'Too many requests — wait a moment and retry.'
        : m === 'OVERLOADED' ? 'Gemini is busy — try again shortly.'
        : m.startsWith('GEMINI_BLOCKED') ? 'Could not read the receipt (blocked). Try a clearer photo.'
        : 'Could not read the receipt. Please enter items manually.');
    } finally { setScanning(false); scanAbortRef.current = null; }
  };

  // ── entry helpers ──
  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { id: uid(), name: '', qty: 1, total: '' }]);
  const rmRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id));

  const goReview = () => {
    const kept = rows.filter((r) => r.name || r.total);
    if (!kept.length) return alert('Add at least one item.');
    if (!paidBy) return alert('Select who paid.');
    // Build assign-model items — preserve each row's existing assignment BY ID (#114),
    // so add/remove/reorder never shifts assignments onto the wrong item.
    const prevById = Object.fromEntries(items.map((i) => [i.id, i]));
    setItems(kept.map((r) => {
      const prev = prevById[r.id] || {};
      const qty = parseInt(r.qty) || 1;
      const total = parseFloat(r.total) || 0;
      return {
        id: r.id, name: r.name || 'Item', qty, price: total / qty,
        discount: parseFloat(r.discount) || prev.discount || 0,
        discountLabel: r.discountLabel || prev.discountLabel || '',
        assignment: prev.assignment || 'shared',
        splitA: prev.splitA || 50, splitB: prev.splitB || 50,
        qtyA: prev.qtyA, qtyB: prev.qtyB, amtA: prev.amtA, amtB: prev.amtB,
      };
    }));
    setAssignMode(null); setOpenDd(null);
    setStep('review');
  };

  const calc = recalc(items, charges);
  // Live grand total for the entry step, derived straight from the raw rows (grand total is
  // assignment-independent, so any assignment yields the correct total). Drives the CHARGES "Total" row (#139).
  const entryItems = rows
    .filter((r) => r.name || r.total)
    .map((r) => { const qty = parseInt(r.qty) || 1; const total = parseFloat(r.total) || 0; return { qty, price: total / qty, discount: parseFloat(r.discount) || 0, assignment: 'shared', splitA: 50, splitB: 50 }; });
  const entryCalc = recalc(entryItems, charges);
  // Per-person item subtotals for the Review person boxes (#141, ported from old renderPersonBoxes).
  const personBox = (() => {
    let itemsA = 0, itemsB = 0, iDiscA = 0, iDiscB = 0;
    items.forEach((it) => {
      const total = it.price * it.qty, disc = it.discount || 0;
      if (it.assignment === 'a') { itemsA += total; iDiscA += disc; }
      else if (it.assignment === 'b') { itemsB += total; iDiscB += disc; }
      else { const sA = (it.splitA || 50) / 100, sB = (it.splitB || 50) / 100; itemsA += total * sA; itemsB += total * sB; if (disc) { iDiscA += disc * sA; iDiscB += disc * sB; } }
    });
    const ds = charges.discounts || [];
    const pdA = ds.filter((d) => d.assignTo === 'a').reduce((s, d) => s + (d.amt || 0), 0);
    const pdB = ds.filter((d) => d.assignTo === 'b').reduce((s, d) => s + (d.amt || 0), 0);
    return { itemsA, itemsB, iDiscA, iDiscB, pdA, pdB };
  })();

  const save = () => {
    const bill = {
      id: editing?.id || uid(), date, place, category, paidBy, items,
      charges: { ...charges, ...(receiptTotal > 0 ? { receiptTotal } : {}) }, // persist for edit-compare (#144)
      grandTotal: calc.grandTotal, shareA: calc.shareA, shareB: calc.shareB,
      ocrJson, // #102 raw OCR response (null for manual entries)
      ocrMeta: ocrMeta ? { ...ocrMeta, person: currentUser, gs: config.gsVersion || '' } : (editing?.ocrMeta ?? null), // #169 telemetry
    };
    (editing ? editBill : addBill)(bill);
    // #170 — background AI categorization for a NEW itemized bill the user didn't categorize
    // (untouched + empty/'other'). Fire-and-forget; editBill is a stable store fn so it applies
    // after this component unmounts. Also fills scanned bills where OCR returned no category.
    if (!editing && !categoryTouched && (!category || category === 'other') && config.geminiApiKey) {
      const desc = catDesc(place, items);
      if (desc) categorize(desc, config.geminiApiKey).then((cat) => { if (cat) editBill({ ...bill, category: cat }); }).catch(() => {});
    }
    showToast(editing ? 'Bill updated ✓' : 'Bill saved ✓'); // #165
    if (!editing) onSaved && onSaved();
    onClose();
  };

  // ── Quick-split derived values + save (#147) ──
  const qTotalVal = fieldVal(qTotal, lastTotal);
  const qAVal = fieldVal(qA, lastA);
  const qBVal = fieldVal(qB, lastB);
  const isExpr = (s) => { s = (s || '').trim(); return /[+*/]/.test(s) || /\S-/.test(s); }; // has a binary operator → worth showing the "= ฿…" sum
  const qShared = qTotalVal - qAVal - qBVal;
  const qShareA = qAVal + qShared / 2;   // Powpow
  const qShareB = qBVal + qShared / 2;   // Pat
  const qOver = qAVal + qBVal > qTotalVal + 1e-9; // personal amounts exceed the total → block
  const qOwes = paidBy === 'a' ? qShareB : qShareA;           // non-payer owes the payer their share
  const qOwesFrom = paidBy === 'a' ? nameB : nameA;
  const qOwesTo = paidBy === 'a' ? nameA : nameB;
  const qNewBal = projectedBalance({ id: editing?.id || '__draft__', paidBy: paidBy || 'a', shareA: qShareA, shareB: qShareB });

  // Which entry view to show (#147): dropzone (pre-scan) · itemized (OCR/verify or itemized edit) · quick (manual tab or quick edit).
  const showDropzone = !editing && tab === 'upload' && !scanned;
  const showItemized = (editing && !isQuick) || (!editing && tab === 'upload' && scanned);
  const showQuick = isQuick || (!editing && tab === 'manual' && !scanned);

  const saveQuick = () => {
    if (!paidBy) return alert('Select who paid.');
    if (!(qTotalVal > 0)) return alert('Enter the bill total.');
    if (qOver) return alert('The two personal amounts add up to more than the total.');
    const quick = { totalExpr: qTotal, aExpr: qA, bExpr: qB };
    const bill = {
      id: editing?.id || uid(), date, place, paidBy,
      category: editing?.category || '', // empty → AI categorizes in the background (#148); safe (catMeta falls back to 'other')
      mode: 'quick', quick,
      items: [],
      // Embed mode+quick inside charges too — charges_json round-trips through the Sheet,
      // so quick markers survive a reload (top-level mode/quick are not persisted columns). #147
      charges: { sc: false, scPct: 10, vat: false, vatPct: 7, discounts: [], mode: 'quick', quick },
      grandTotal: qTotalVal, shareA: qShareA, shareB: qShareB,
    };
    (editing ? editBill : addBill)(bill);
    // Background AI categorization for a new quick bill with no category (#148). Fire-and-forget;
    // editBill is a stable store fn so it still applies after this component unmounts.
    if (!bill.category && config.geminiApiKey && (place || '').trim()) {
      categorize(place, config.geminiApiKey).then((cat) => { if (cat) editBill({ ...bill, category: cat }); }).catch(() => {});
    }
    showToast(editing ? 'Bill updated ✓' : 'Bill saved ✓'); // #165
    if (!editing) onSaved && onSaved();
    onClose();
  };

  // ── render ──
  return (
    <div className="page">
      {scanning && (
        <div className="scan-overlay">
          <button onClick={cancelScan} aria-label="Cancel scan" style={{ position: 'absolute', top: 14, right: 18, border: 'none', background: 'none', color: 'var(--red)', fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: '4px 6px', zIndex: 2 }}>Cancel</button>
          <div className="scan-spinner" />
          <div style={{ fontSize: 15, fontWeight: 500 }}>Reading receipt…</div>
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>{scanMsg}</div>
          {scanElapsed >= 3 && <div style={{ fontSize: 12, color: 'var(--text3)' }}>{scanElapsed}s</div>}
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginTop: 16, textAlign: 'center', padding: '0 32px', animation: 'blink-warn 1s ease-in-out infinite' }}>Please keep this page open</div>
          <div style={{ position: 'absolute', bottom: 'calc(32px + var(--safe-b))', display: 'flex', alignItems: 'center', gap: 6, opacity: 0.55 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <defs><linearGradient id="gem-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#8B5CF6" /><stop offset="100%" stopColor="#3B82F6" /></linearGradient></defs>
              <path d="M12 2C12 2 14.5 7 19.5 8C19.5 8 14.5 9 12 22C12 22 9.5 9 4.5 8C4.5 8 9.5 7 12 2Z" fill="url(#gem-grad)" />
            </svg>
            <span style={{ fontSize: 11, color: 'var(--text2)', letterSpacing: '0.02em' }}>Powered by Gemini</span>
          </div>
        </div>
      )}
      <div className="page-head">
        <button className="back-btn" onClick={step === 'entry' ? onClose : () => setStep(step === 'confirm' ? 'review' : 'entry')}>‹ {step === 'entry' ? 'Cancel' : 'Back'}</button>
        <strong>{step === 'entry' ? (editing ? 'Edit bill' : 'New bill') : step === 'review' ? 'Assign' : 'Confirm'}</strong>
        {onMinimize && <button className="back-btn" onClick={onMinimize} aria-label="Keep for later" style={{ marginLeft: 'auto' }}>Keep ⌄</button>}
      </div>

      {step === 'entry' && (
        <div className="screen">
          <input ref={fileInput} type="file" accept="image/*" onChange={handleScan} style={{ display: 'none' }} />
          {!editing && !scanned && (
            <div className="pill-tabs">
              <button className={'pill-tab' + (tab === 'upload' ? ' on' : '')} onClick={() => setTab('upload')}>Upload receipt</button>
              <button className={'pill-tab' + (tab === 'manual' ? ' on' : '')} onClick={() => setTab('manual')}>Manual entry</button>
            </div>
          )}

          {showDropzone && (
            <>
              <div className="dropzone" onClick={() => !scanning && fileInput.current?.click()}>
                <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                <div className="dropzone-title">{scanning ? 'Reading receipt…' : 'Snap or upload receipt'}</div>
                <div className="dropzone-sub">Gemini AI reads items, prices &amp; charges</div>
              </div>
              <div style={{ background: 'var(--acc-light)', color: 'var(--acc-text)', borderRadius: 10, padding: '10px 14px', marginTop: 12, fontSize: 12 }}>
                ✓ Date&nbsp;&nbsp; ✓ Place&nbsp;&nbsp; ✓ Items &amp; prices&nbsp;&nbsp; ✓ VAT &amp; service charge
              </div>
            </>
          )}

          {showItemized && (
            <>
              <div className="sec-label">DATE</div>
              <input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

              <div className="sec-label" style={{ marginTop: 14 }}>PLACE / DESCRIPTION</div>
              <input className="inp" placeholder="Place or description" value={place} onChange={(e) => { setPlace(e.target.value); setOcrPlace(false); }} />
              {ocrPlace && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>OCR filled · tap to verify</div>}

              <div className="sec-label" style={{ marginTop: 14 }}>CATEGORY</div>
              <select className="inp" value={category} onChange={(e) => { setCategory(e.target.value); setCategoryTouched(true); }}>
                <option value="food">Food &amp; drink</option><option value="shop">Shopping</option>
                <option value="cafe">Café</option><option value="transport">Transport</option><option value="other">Other</option>
              </select>

              <div className="sec-label" style={{ marginTop: 14 }}>ITEMS</div>
              <div className="card" style={{ padding: 0, marginBottom: 0 }}>
                {rows.map((r) => (
                  <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 10px', borderTop: '0.5px solid var(--border)' }}>
                    <input className="inp" placeholder="Item" value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value })} style={{ flex: 2, border: 'none', background: 'transparent', padding: '6px 2px' }} />
                    <input className="inp" type="number" min="1" value={r.qty} onChange={(e) => setRow(r.id, { qty: e.target.value })} style={{ width: 44, border: 'none', background: 'transparent', textAlign: 'right' }} />
                    <input className="inp" type="number" placeholder="0.00" value={r.total} onChange={(e) => setRow(r.id, { total: e.target.value })} style={{ width: 84, border: 'none', background: 'transparent', textAlign: 'right' }} />
                    {rows.length > 1 && <button className="back-btn" style={{ color: 'var(--red)' }} onClick={() => rmRow(r.id)}>×</button>}
                  </div>
                ))}
                <div style={{ padding: '8px 10px', borderTop: '0.5px solid var(--border)' }}>
                  <button className="pillbtn" style={{ color: 'var(--acc)', border: 'none', padding: 0 }} onClick={addRow}>+ add item</button>
                </div>
              </div>

              <div className="sec-label" style={{ marginTop: 14 }}>CHARGES</div>
              <div className="card" style={{ padding: 0, marginBottom: 0, overflow: 'visible' }}>
                {charges.discounts.map((d, di) => {
                  const [dcls, dlbl] = discChip(d);
                  const personal = d.assignTo === 'a' || d.assignTo === 'b';
                  return (
                    <div key={d.id} style={{ borderTop: di === 0 ? 'none' : '0.5px solid var(--border)', background: 'var(--acc-light)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="text-strong">{d.ocr && <span style={{ background: '#F5D98B', color: '#7A5B00', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700, marginRight: 6 }}>OCR</span>}{stageChip(d, personal)}{d.label}</div>
                          <div style={{ marginTop: 3 }}><span style={{ fontSize: 11, color: 'var(--red)' }}>−{fmtMoney(d.amt, sym)}</span></div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <AssignChip cls={dcls} label={dlbl} shared={discShared(d)} id={d.id} openDd={openDd} setOpenDd={setOpenDd} onCycle={() => cycleDisc(d)} shareOpts={DISC_SHARE} onPick={(v) => { setDiscTo(d.id, v); setOpenDd(null); }} />
                          <button className="back-btn" style={{ color: 'var(--red)' }} onClick={() => rmDisc(d.id)}>×</button>
                        </div>
                      </div>
                      {d.assignTo === 'pct' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                          <span>{nameA}</span>
                          <input className="inp" type="number" value={d.pctA ?? 50} style={{ width: 60 }} onChange={(e) => { const a = Math.min(100, Math.max(0, parseInt(e.target.value) || 0)); setDiscField(d.id, { pctA: a }); }} />
                          <span>% · {nameB} {100 - (d.pctA ?? 50)}%</span>
                        </div>
                      )}
                      {d.assignTo === 'fixed' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                          <input className="inp" type="number" placeholder={`${nameA} ฿`} value={d.amtA ?? ''} style={{ width: 90 }} onChange={(e) => { const a = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtA: a, amt: a + (d.amtB || 0) }); }} />
                          <input className="inp" type="number" placeholder={`${nameB} ฿`} value={d.amtB ?? ''} style={{ width: 90 }} onChange={(e) => { const b = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtB: b, amt: (d.amtA || 0) + b }); }} />
                        </div>
                      )}
                    </div>
                  );
                })}
                {!showDiscEditor ? (
                  <div style={{ padding: '10px 12px', borderTop: '0.5px solid var(--border)' }}>
                    <button className="pillbtn" style={{ color: 'var(--acc)', border: 'none', padding: 0 }} onClick={() => setShowDiscEditor(true)}>+ add voucher / discount</button>
                  </div>
                ) : (
                  <div style={{ padding: '10px 12px', borderTop: '0.5px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <input className="inp" placeholder="Label" value={disc.label} style={{ flex: 1 }} onChange={(e) => setDisc({ ...disc, label: e.target.value })} />
                    {disc.target !== 'fixed' && <input className="inp" type="number" placeholder="Amount" value={disc.amt} style={{ width: 90 }} onChange={(e) => setDisc({ ...disc, amt: e.target.value })} />}
                    <select className="inp" value={disc.target} onChange={(e) => setDisc({ ...disc, target: e.target.value })}>
                      <option value="split">Shared 50/50</option><option value="prop">Proportional</option><option value="pct">Shared %</option>
                      <option value="fixed">Fixed A/B</option><option value="a">{nameA} only</option><option value="b">{nameB} only</option>
                    </select>
                    {disc.target === 'pct' && <span style={{ fontSize: 12, color: 'var(--text2)' }}>{nameA} <input className="inp" type="number" value={disc.pctA} style={{ width: 54 }} onChange={(e) => setDisc({ ...disc, pctA: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })} />%</span>}
                    {disc.target === 'fixed' && (<>
                      <input className="inp" type="number" placeholder={`${nameA} ฿`} value={disc.amtA} style={{ width: 80 }} onChange={(e) => setDisc({ ...disc, amtA: e.target.value })} />
                      <input className="inp" type="number" placeholder={`${nameB} ฿`} value={disc.amtB} style={{ width: 80 }} onChange={(e) => setDisc({ ...disc, amtB: e.target.value })} />
                    </>)}
                    {disc.target !== 'a' && disc.target !== 'b' && (
                      (discAdvanced || disc.taxStage === 'preVat' || disc.taxStage === 'preSc') ? (
                        <select className="inp" value={disc.taxStage} onChange={(e) => setDisc({ ...disc, taxStage: e.target.value })}>
                          {STAGE_OPTS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
                        </select>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ display: 'inline-flex', border: '0.5px solid var(--border)', borderRadius: 20, overflow: 'hidden' }}>
                            <button className={disc.taxStage === 'pre' ? 'pillbtn on' : 'pillbtn'} style={{ border: 'none', borderRadius: 0 }} onClick={() => setDisc({ ...disc, taxStage: 'pre' })}>Before</button>
                            <button className={disc.taxStage === 'post' ? 'pillbtn on' : 'pillbtn'} style={{ border: 'none', borderRadius: 0 }} onClick={() => setDisc({ ...disc, taxStage: 'post' })}>After</button>
                          </span>
                          <button className="back-btn" style={{ fontSize: 12 }} onClick={() => setDiscAdvanced(true)}>advanced</button>
                        </span>
                      )
                    )}
                    <button className="pillbtn" style={{ color: 'var(--acc)' }} onClick={() => { if (addDiscount()) setShowDiscEditor(false); }}>+ add</button>
                    <button className="back-btn" style={{ fontSize: 12 }} onClick={() => setShowDiscEditor(false)}>cancel</button>
                  </div>
                )}
                {(charges.fees || []).map((f) => (
                  <div key={f.id} style={{ borderTop: '0.5px solid var(--border)', background: 'var(--acc-light)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="text-strong">{f.ocr && <span style={{ background: '#F5D98B', color: '#7A5B00', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700, marginRight: 6 }}>OCR</span>}{f.label}</div>
                        <div style={{ marginTop: 3 }}><span style={{ fontSize: 11, color: 'var(--text2)' }}>+{fmtMoney(f.amt, sym)}</span></div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <select className="inp" value={f.assignTo || 'prop'} onChange={(e) => setFeeMode(f.id, e.target.value)}>
                          <option value="prop">Follow food share</option><option value="split">Shared 50/50</option><option value="pct">Shared %</option>
                          <option value="fixed">Fixed A/B</option><option value="a">{nameA} only</option><option value="b">{nameB} only</option>
                        </select>
                        <button className="back-btn" style={{ color: 'var(--red)' }} onClick={() => rmFee(f.id)}>×</button>
                      </div>
                    </div>
                    {f.assignTo === 'pct' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                        <span>{nameA}</span>
                        <input className="inp" type="number" value={f.pctA ?? 50} style={{ width: 60 }} onChange={(e) => setFeeField(f.id, { pctA: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })} />
                        <span>% · {nameB} {100 - (f.pctA ?? 50)}%</span>
                      </div>
                    )}
                    {f.assignTo === 'fixed' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                        <input className="inp" type="number" placeholder={`${nameA} ฿`} value={f.amtA ?? ''} style={{ width: 90 }} onChange={(e) => { const a = parseFloat(e.target.value) || 0; setFeeField(f.id, { amtA: a, amt: a + (f.amtB || 0) }); }} />
                        <input className="inp" type="number" placeholder={`${nameB} ฿`} value={f.amtB ?? ''} style={{ width: 90 }} onChange={(e) => { const b = parseFloat(e.target.value) || 0; setFeeField(f.id, { amtB: b, amt: (f.amtA || 0) + b }); }} />
                      </div>
                    )}
                  </div>
                ))}
                <div style={{ padding: '10px 12px', borderTop: '0.5px solid var(--border)' }}>
                  {!showFeeEditor ? (
                    <button className="pillbtn" style={{ color: 'var(--acc)', border: 'none', padding: 0 }} onClick={() => setShowFeeEditor(true)}>+ add fee (delivery, platform…)</button>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <input className="inp" placeholder="Label (e.g. Delivery fee)" value={fee.label} style={{ flex: 1 }} onChange={(e) => setFee({ ...fee, label: e.target.value })} />
                      <input className="inp" type="number" placeholder="Amount" value={fee.amt} style={{ width: 90 }} onChange={(e) => setFee({ ...fee, amt: e.target.value })} />
                      <button className="pillbtn" style={{ color: 'var(--acc)' }} onClick={() => { if (addFee()) setShowFeeEditor(false); }}>+ add</button>
                      <button className="back-btn" style={{ fontSize: 12 }} onClick={() => setShowFeeEditor(false)}>cancel</button>
                    </div>
                  )}
                </div>
                <div style={{ padding: '10px 12px', borderTop: '0.5px solid var(--border)' }}>
                  <Toggle label="Service charge" on={charges.sc} pct={charges.scPct} onToggle={() => setCharges((c) => ({ ...c, sc: !c.sc }))} onPct={(v) => setCharges((c) => ({ ...c, scPct: v }))} />
                </div>
                <div style={{ padding: '10px 12px', borderTop: '0.5px solid var(--border)' }}>
                  <Toggle label="VAT" on={charges.vat} pct={charges.vatPct} onToggle={() => setCharges((c) => ({ ...c, vat: !c.vat }))} onPct={(v) => setCharges((c) => ({ ...c, vatPct: v }))} />
                </div>
                <div style={{ padding: '12px', borderTop: '0.5px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
                    <span>Total</span><span>{fmtMoney(entryCalc.grandTotal, sym)}</span>
                  </div>
                  {receiptCompare(entryCalc.grandTotal)}
                </div>
              </div>

              <div className="sec-label" style={{ marginTop: 14 }}>WHO PAID?</div>
              <div style={{ display: 'flex', gap: 10 }}>
                {[['a', nameA], ['b', nameB]].map(([k, n]) => {
                  const sel = paidBy === k;
                  return (
                    <button key={k} onClick={() => setPaidBy(k)}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 8px', borderRadius: 12, cursor: 'pointer', background: sel ? 'var(--acc-light)' : 'var(--card)', border: sel ? '1.5px solid var(--acc)' : '0.5px solid var(--border)', color: sel ? 'var(--acc-text)' : 'var(--text)', fontSize: 15, fontWeight: 500 }}>
                      {n}{sel && <span style={{ fontSize: 11, fontWeight: 400, marginTop: 2 }}>✓ selected</span>}
                    </button>
                  );
                })}
              </div>
              <button className="btn" style={{ marginTop: 16 }} onClick={goReview}>Next →</button>
            </>
          )}

          {showQuick && (
            <>
              <div className="sec-label">DATE</div>
              <input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

              <div className="sec-label" style={{ marginTop: 14 }}>DESCRIPTION</div>
              <input className="inp" placeholder="What was this bill?" value={place} onChange={(e) => setPlace(e.target.value)} />

              <div className="sec-label" style={{ marginTop: 14 }}>PAID BY</div>
              <select className="inp" value={paidBy || ''} onChange={(e) => setPaidBy(e.target.value || null)}>
                <option value="">Choose…</option>
                <option value="a">{nameA}</option>
                <option value="b">{nameB}</option>
              </select>

              <div className="sec-label" style={{ marginTop: 14 }}>BILL TOTAL</div>
              <input className="inp" inputMode="text" placeholder="0" value={qTotal} onChange={(e) => setQTotal(e.target.value)} style={{ fontWeight: 500 }} />
              {isExpr(qTotal) && <div style={{ fontSize: 12, color: 'var(--acc-text)', marginTop: 4 }}>= {fmtMoney(qTotalVal, sym)}</div>}

              <div className="sec-label" style={{ marginTop: 14 }}>{(nameA || 'You').toUpperCase()} ONLY <span style={{ color: 'var(--text3)', fontWeight: 400, textTransform: 'none' }}>· optional</span></div>
              <input className="inp" inputMode="text" placeholder="e.g. 100+20-5" value={qA} onChange={(e) => setQA(e.target.value)} />
              {isExpr(qA) && <div style={{ fontSize: 12, color: 'var(--acc-text)', marginTop: 4 }}>= {fmtMoney(qAVal, sym)}</div>}

              <div className="sec-label" style={{ marginTop: 14 }}>{(nameB || 'Them').toUpperCase()} ONLY <span style={{ color: 'var(--text3)', fontWeight: 400, textTransform: 'none' }}>· optional</span></div>
              <input className="inp" inputMode="text" placeholder="e.g. 250" value={qB} onChange={(e) => setQB(e.target.value)} />
              {isExpr(qB) && <div style={{ fontSize: 12, color: 'var(--acc-text)', marginTop: 4 }}>= {fmtMoney(qBVal, sym)}</div>}

              <div className="card" style={{ padding: 14, marginTop: 18, fontSize: 13 }}>
                {qOver ? (
                  <div style={{ color: 'var(--red)' }}>The two personal amounts (฿{fmtMoney(qAVal + qBVal, '')}) exceed the bill total. Adjust before saving.</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text2)', marginBottom: 6 }}>
                      <span>Shared (split 50/50)</span><span>{fmtMoney(Math.max(0, qShared), sym)} → {fmtMoney(Math.max(0, qShared) / 2, sym)} each</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 8, borderBottom: '0.5px solid var(--border)' }}>
                      <span style={{ color: 'var(--acc)' }}>{nameA} <b>{fmtMoney(qShareA, sym)}</b></span>
                      <span style={{ color: '#a0623a' }}>{nameB} <b>{fmtMoney(qShareB, sym)}</b></span>
                    </div>
                    {paidBy ? (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                          <span style={{ color: 'var(--text2)' }}>{qOwesFrom} owes {qOwesTo}</span><b>{fmtMoney(Math.abs(qOwes), sym)}</b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, color: 'var(--text3)', fontSize: 12 }}>
                          <span>New balance</span>
                          <span>{Math.abs(qNewBal) < 0.005 ? 'All settled up' : `${qNewBal > 0 ? nameB : nameA} owes ${qNewBal > 0 ? nameA : nameB} ${fmtMoney(Math.abs(qNewBal), sym)}`}</span>
                        </div>
                      </>
                    ) : (
                      <div style={{ color: 'var(--text3)', marginTop: 10, fontSize: 12 }}>Choose who paid to see who owes whom.</div>
                    )}
                  </>
                )}
              </div>

              <button className="btn" style={{ marginTop: 16, opacity: qOver ? 0.5 : 1 }} onClick={saveQuick}>Save bill</button>
            </>
          )}
        </div>
      )}

      {step === 'review' && (() => {
        const done = assignMode !== null;
        const modeName = assignMode === 'a' ? nameA : assignMode === 'b' ? nameB : 'both';
        const PILLS = [
          ['a', nameA, 'var(--acc)', 'var(--acc-light)', 'var(--acc-text)'],
          ['b', nameB, '#a0623a', '#FFF0E6', '#a0623a'],
          ['shared', 'Both', '#555', '#f0f0f0', '#555'],
        ];
        const chipMeta = (it) => it.assignment === 'a' ? ['chip-a', nameA]
          : it.assignment === 'b' ? ['chip-b', nameB]
          : it.assignment === 'custom' ? ['chip-custom', `${it.splitA || 50}/${it.splitB || 50}%`]
          : it.assignment === 'qty' ? ['chip-custom', `${it.qtyA || 0}/${it.qtyB || 0}`]
          : it.assignment === 'amt' ? ['chip-custom', `${fmtMoney(it.amtA || 0, sym)}/${fmtMoney(it.amtB || 0, sym)}`]
          : ['chip-shared', 'Both'];
        // tap the chip → cycle A → B → Shared (3 modes); share sub-mode via the ▾ dropdown (matches discounts #142).
        const cycleItem = (it) => { const cur = it.assignment === 'a' ? 'a' : it.assignment === 'b' ? 'b' : 'shared'; const order = ['a', 'b', 'shared']; const next = order[(order.indexOf(cur) + 1) % 3]; setItemAssign(it.id, { assignment: next, ...(next === 'shared' ? { splitA: 50, splitB: 50 } : {}) }); };
        const itemShared = (it) => ['shared', 'custom', 'qty', 'amt'].includes(it.assignment);
        const ITEM_SHARE = [['shared', '#aaa', 'Both (50/50)'], ['custom', '#5340b0', 'Custom (% / Qty / ฿)']]; // ▾ options in Shared mode
        const DD_DOTS = [['a', 'var(--acc)', nameA], ['b', '#a0623a', nameB], ['shared', '#aaa', 'Both'], ['custom', '#5340b0', 'Custom']]; // active-mode reassign
        // discount helpers hoisted to component scope (#151) — see discChip/cycleDisc/etc. above the render.
        return (
        <div className="screen">
          <div className="card" style={{ padding: '12px 14px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{place || 'Bill'}</div>
              <div className="text-sub">{fmtDate(date)} · {category}</div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Paid by <b>{paidBy === 'a' ? nameA : nameB}</b></div>
          </div>

          <div className="sec-label" style={{ marginBottom: 6 }}>ITEMS</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', background: done ? 'var(--border)' : 'var(--acc)', color: done ? 'var(--text3)' : '#fff', fontSize: 9, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{done ? '✓' : '1'}</div>
            <span style={{ fontSize: 12, fontWeight: done ? 400 : 500, color: done ? 'var(--text3)' : 'var(--text)' }}>Pick a name</span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>→</span>
            <div style={{ width: 16, height: 16, borderRadius: '50%', background: done ? 'var(--acc)' : 'transparent', border: done ? 'none' : '1.5px solid var(--acc)', color: done ? '#fff' : 'var(--acc)', fontSize: 9, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>2</div>
            <span style={{ fontSize: 12, fontWeight: done ? 600 : 400, color: done ? 'var(--text)' : 'var(--text3)' }}>Tap items</span>
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            {PILLS.map(([m, lbl, bc, bg, tc]) => {
              const active = assignMode === m, dim = assignMode && assignMode !== m;
              return (
                <div key={m} onClick={() => pickMode(m)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '7px 0', borderRadius: 20, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: `${active ? 2 : 1}px solid ${active ? bc : 'var(--border)'}`, background: active ? bg : 'var(--card)', color: active ? tc : 'var(--text2)', opacity: dim ? 0.4 : 1 }}>
                  {m === 'shared'
                    ? <span style={{ display: 'flex', flexShrink: 0 }}><span className="av av-a" style={{ width: 13, height: 13, marginRight: -4, border: '1.5px solid var(--card)', position: 'relative', zIndex: 1 }} /><span className="av av-b" style={{ width: 13, height: 13, border: '1.5px solid var(--card)' }} /></span>
                    : <span className={'av av-' + m} style={{ width: 18, height: 18, fontSize: 8, flexShrink: 0 }}>{initials(m === 'a' ? nameA : nameB, m === 'a' ? config.initialsA : config.initialsB)}</span>}
                  {lbl}
                </div>
              );
            })}
          </div>
          <div className="assign-tip">
            <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', ...(done ? { bottom: -5, borderTop: '5px solid #2a3a38' } : { top: -5, borderBottom: '5px solid #2a3a38' }) }} />
            {done ? `Now tap items to assign to ${modeName}` : 'Tap a name to start assigning items'}
          </div>

          <div className="card" style={{ padding: 0, margin: '14px 0', overflow: 'visible' }}>
            {items.map((it) => {
              const [cls, lbl] = chipMeta(it);
              if (assignMode) {
                const checked = it.assignment === assignMode;
                const otherMode = assignMode === 'a' ? 'b' : assignMode === 'b' ? 'a' : null;
                const otherAssigned = assignMode === 'shared' ? (it.assignment === 'a' || it.assignment === 'b') : (!!otherMode && it.assignment === otherMode);
                const checkColor = assignMode === 'a' ? 'var(--acc)' : assignMode === 'b' ? '#a0623a' : '#666';
                const otherColor = assignMode === 'shared' ? (it.assignment === 'a' ? 'var(--acc)' : '#a0623a') : (otherMode === 'a' ? 'var(--acc)' : '#a0623a');
                const customSplit = it.assignment === 'custom' || it.assignment === 'qty' || it.assignment === 'amt';
                const sharedInd = assignMode !== 'shared' && it.assignment === 'shared';
                const circCol = checked ? checkColor : otherAssigned ? otherColor : customSplit ? '#5340b0' : sharedInd ? '#aaa' : 'transparent';
                const circBd = checked ? checkColor : otherAssigned ? otherColor : customSplit ? '#5340b0' : sharedInd ? '#aaa' : 'var(--border)';
                const showCheck = checked || otherAssigned || sharedInd || (assignMode === 'shared' && customSplit);
                const showDd = assignMode === 'shared' && checked;
                return (
                  <div key={it.id}>
                    <div className="card-row" style={{ gap: 8, cursor: 'pointer' }} onClick={() => tapItem(it)}>
                      <AssignCircle bg={circCol} border={circBd} check={showCheck} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="text-strong">{it.name}{it.qty > 1 ? ` ×${it.qty}` : ''}</div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', marginTop: 1 }}>{fmtMoney(it.price * it.qty, sym)}</div>
                      </div>
                      {showDd && (
                        <div className="assign-dd-wrap" onClick={(e) => e.stopPropagation()}>
                          <div className="assign-chip chip-custom" style={{ padding: '3px 10px', cursor: 'pointer' }} onClick={() => setDirect(it.id, 'custom')}>Custom</div>
                          <div className={'assign-dropdown' + (openDd === it.id ? ' open' : '')}>
                            {DD_DOTS.map(([v, dot, dl]) => (
                              <div key={v} className="assign-dd-opt" onClick={() => setDirect(it.id, v)}><div className="assign-dd-dot" style={{ background: dot }} />{dl}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {customSplit && <CustomSplit it={it} nameA={nameA} nameB={nameB} sym={sym} setItemAssign={setItemAssign} />}
                  </div>
                );
              }
              return (
                <div key={it.id}>
                  <div className="card-row" style={{ gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-strong">{it.name}{it.qty > 1 ? ` ×${it.qty}` : ''}</div>
                      <div className="text-sub">{fmtMoney(it.price * it.qty, sym)}</div>
                    </div>
                    <AssignChip cls={cls} label={lbl} shared={itemShared(it)} id={it.id} openDd={openDd} setOpenDd={setOpenDd} onCycle={() => cycleItem(it)} shareOpts={ITEM_SHARE} onPick={(v) => setDirect(it.id, v)} />
                  </div>
                  {['custom', 'qty', 'amt'].includes(it.assignment) && <CustomSplit it={it} nameA={nameA} nameB={nameB} sym={sym} setItemAssign={setItemAssign} />}
                </div>
              );
            })}

            {charges.discounts.map((d) => {
              const [dcls, dlbl] = discChip(d);
              const personal = d.assignTo === 'a' || d.assignTo === 'b';
              // Active-name mode: mirror items — colored check circle + tap to assign to the active name (#142).
              if (assignMode) {
                const col = d.assignTo === 'a' ? 'var(--acc)' : d.assignTo === 'b' ? '#a0623a' : (d.assignTo === 'pct' || d.assignTo === 'fixed') ? '#5340b0' : '#aaa';
                return (
                  <div key={d.id}>
                    <div className="card-row" style={{ gap: 8, cursor: 'pointer', background: d.ocr ? 'var(--acc-light)' : 'transparent' }} onClick={() => tapDisc(d)}>
                      <AssignCircle bg={col} border={col} check />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="text-strong">{d.ocr && <span style={{ background: '#F5D98B', color: '#7A5B00', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700, marginRight: 6 }}>OCR</span>}{stageChip(d, personal)}{d.label}</div>
                        <div className="text-sub"><span style={{ color: 'var(--red)' }}>−{fmtMoney(d.amt, sym)}</span> · {dlbl}</div>
                      </div>
                      {/* In Both mode, a shared discount exposes its share ▾ so you can customize without leaving active mode (#154). */}
                      {assignMode === 'shared' && discShared(d) && (
                        <div className="assign-dd-wrap" onClick={(e) => e.stopPropagation()}>
                          <div className={'assign-chip ' + dcls} style={{ cursor: 'pointer' }} onClick={() => setOpenDd((x) => (x === d.id ? null : d.id))}><span style={{ padding: '4px 8px' }}>{dlbl} ▾</span></div>
                          <div className={'assign-dropdown' + (openDd === d.id ? ' open' : '')}>
                            {DISC_SHARE.map(([v, dot, dl]) => (
                              <div key={v} className="assign-dd-opt" onClick={() => { setDiscTo(d.id, v); setOpenDd(null); }}><div className="assign-dd-dot" style={{ background: dot }} />{dl}</div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {d.assignTo === 'pct' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                        <span>{nameA}</span>
                        <input className="inp" type="number" value={d.pctA ?? 50} style={{ width: 60 }} onChange={(e) => { const a = Math.min(100, Math.max(0, parseInt(e.target.value) || 0)); setDiscField(d.id, { pctA: a }); }} />
                        <span>% · {nameB} {100 - (d.pctA ?? 50)}%</span>
                      </div>
                    )}
                    {d.assignTo === 'fixed' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                        <input className="inp" type="number" placeholder={`${nameA} ฿`} value={d.amtA ?? ''} style={{ width: 90 }} onChange={(e) => { const a = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtA: a, amt: a + (d.amtB || 0) }); }} />
                        <input className="inp" type="number" placeholder={`${nameB} ฿`} value={d.amtB ?? ''} style={{ width: 90 }} onChange={(e) => { const b = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtB: b, amt: (d.amtA || 0) + b }); }} />
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div key={d.id}>
                  <div className="card-row" style={{ gap: 8, background: d.ocr ? 'var(--acc-light)' : 'transparent', ...(assignMode ? { cursor: 'pointer' } : {}) }} onClick={assignMode ? () => tapDisc(d) : undefined}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-strong">{d.ocr && <span style={{ background: '#F5D98B', color: '#7A5B00', borderRadius: 5, padding: '1px 6px', fontSize: 10, fontWeight: 700, marginRight: 6 }}>OCR</span>}{stageChip(d, personal)}{d.label}</div>
                      <div style={{ marginTop: 3 }}><span style={{ fontSize: 11, color: 'var(--red)' }}>−{fmtMoney(d.amt, sym)}</span></div>
                    </div>
                    <AssignChip cls={dcls} label={dlbl} shared={discShared(d)} id={d.id} openDd={openDd} setOpenDd={setOpenDd} onCycle={() => cycleDisc(d)} shareOpts={DISC_SHARE} onPick={(v) => { setDiscTo(d.id, v); setOpenDd(null); }} />
                  </div>
                  {d.assignTo === 'pct' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                      <span>{nameA}</span>
                      <input className="inp" type="number" value={d.pctA ?? 50} style={{ width: 60 }} onChange={(e) => { const a = Math.min(100, Math.max(0, parseInt(e.target.value) || 0)); setDiscField(d.id, { pctA: a }); }} />
                      <span>% · {nameB} {100 - (d.pctA ?? 50)}%</span>
                    </div>
                  )}
                  {d.assignTo === 'fixed' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 10px', fontSize: 12, color: 'var(--text2)' }}>
                      <input className="inp" type="number" placeholder={`${nameA} ฿`} value={d.amtA ?? ''} style={{ width: 90 }} onChange={(e) => { const a = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtA: a, amt: a + (d.amtB || 0) }); }} />
                      <input className="inp" type="number" placeholder={`${nameB} ฿`} value={d.amtB ?? ''} style={{ width: 90 }} onChange={(e) => { const b = parseFloat(e.target.value) || 0; setDiscField(d.id, { amtB: b, amt: (d.amtA || 0) + b }); }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1, background: 'var(--card)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--acc)', marginBottom: 5 }}>{nameA}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Items {fmtMoney(personBox.itemsA, sym)}</div>
              {personBox.iDiscA > 0 && <div style={{ fontSize: 11, color: '#2a9d5c', marginTop: 3 }}>Item disc −{fmtMoney(personBox.iDiscA, sym)}</div>}
              {personBox.pdA > 0 && <div style={{ fontSize: 11, color: '#2a9d5c', marginTop: 3 }}>Discount −{fmtMoney(personBox.pdA, sym)}</div>}
              <PdAdd color="var(--acc)" isOpen={pdBox === 'a'} amt={pdAmt} label={pdLabel} setAmt={setPdAmt} setLabel={setPdLabel} onOpen={() => { setPdBox('a'); setPdAmt(''); setPdLabel(''); }} onAdd={() => addPersonDisc('a')} onCancel={() => { setPdBox(null); setPdAmt(''); setPdLabel(''); }} />
            </div>
            <div style={{ flex: 1, background: 'var(--card)', border: '0.5px solid var(--border)', borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#a0623a', marginBottom: 5 }}>{nameB}</div>
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Items {fmtMoney(personBox.itemsB, sym)}</div>
              {personBox.iDiscB > 0 && <div style={{ fontSize: 11, color: '#2a9d5c', marginTop: 3 }}>Item disc −{fmtMoney(personBox.iDiscB, sym)}</div>}
              {personBox.pdB > 0 && <div style={{ fontSize: 11, color: '#2a9d5c', marginTop: 3 }}>Discount −{fmtMoney(personBox.pdB, sym)}</div>}
              <PdAdd color="#a0623a" isOpen={pdBox === 'b'} amt={pdAmt} label={pdLabel} setAmt={setPdAmt} setLabel={setPdLabel} onOpen={() => { setPdBox('b'); setPdAmt(''); setPdLabel(''); }} onAdd={() => addPersonDisc('b')} onCancel={() => { setPdBox(null); setPdAmt(''); setPdLabel(''); }} />
            </div>
          </div>

          <div className="card" style={{ padding: 12, fontSize: 13 }}>
            <Row l={`${nameA}'s share`} r={fmtMoney(calc.shareA, sym)} />
            <Row l={`${nameB}'s share`} r={fmtMoney(calc.shareB, sym)} />
            <Row l="Grand total" r={fmtMoney(calc.grandTotal, sym)} bold />
            {receiptCompare(calc.grandTotal)}
          </div>
          <button className="btn" style={{ marginTop: 16 }} onClick={() => setStep('confirm')}>Next →</button>
        </div>
        );
      })()}

      {step === 'confirm' && (() => {
        const newBal = projectedBalance({ id: editing?.id || '__draft__', paidBy, shareA: calc.shareA, shareB: calc.shareB });
        const payer = paidBy === 'a' ? nameA : nameB;
        const owes = paidBy === 'a' ? calc.shareB : calc.shareA;
        const other = paidBy === 'a' ? nameB : nameA;
        return (
          <div className="screen">
            <div className="card" style={{ padding: 14, fontSize: 13 }}>
              <Row l="Paid by" r={payer} />
              <Row l={`${nameA}'s share`} r={fmtMoney(calc.shareA, sym)} />
              <Row l={`${nameB}'s share`} r={fmtMoney(calc.shareB, sym)} />
              <Row l="Grand total" r={fmtMoney(calc.grandTotal, sym)} bold />
              <div style={{ borderTop: '0.5px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                <Row l={`${other} owes ${payer}`} r={fmtMoney(owes, sym)} />
                <Row l="New balance" r={fmtMoney(Math.abs(newBal), sym)} />
              </div>
            </div>
            <button className="btn" style={{ marginTop: 16 }} onClick={save}>Save bill</button>
          </div>
        );
      })()}

      {whoPaidPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 70, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '80px 24px 24px' }}>
          <div style={{ background: 'var(--card)', borderRadius: 20, padding: '24px 20px 28px', width: 300 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Who paid?</div>
            <div style={{ fontSize: 13, color: 'var(--text3)', margin: '4px 0 22px' }}>{whoPaidPrompt} — who paid?</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[['a', nameA], ['b', nameB]].map(([k, n]) => (
                <button key={k} onClick={() => { setPaidBy(k); setWhoPaidPrompt(null); }}
                  style={{ width: '100%', padding: 14, borderRadius: 14, border: '2px solid var(--border)', background: 'var(--bg)', fontSize: 16, fontWeight: 600, color: 'var(--text)', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                  <div className={'av av-' + k} style={{ flexShrink: 0 }}>{initials(n, k === 'a' ? config.initialsA : config.initialsB)}</div>
                  <span>{n}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {timingPrompt && !whoPaidPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: 'var(--card)', borderRadius: 16, padding: 20, width: 300, textAlign: 'center' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--acc-light)', color: 'var(--acc-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px', fontSize: 20 }}>🎟️</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Discount found</div>
            <div style={{ display: 'inline-block', background: 'var(--acc-light)', color: 'var(--acc-text)', borderRadius: 8, padding: '4px 10px', fontSize: 13, margin: '8px 0' }}>
              {timingPrompt.count > 1 ? `${timingPrompt.count} discounts` : (timingPrompt.label || 'Discount')} <b>−{fmtMoney(timingPrompt.total, sym)}</b>
            </div>
            {!promptMore ? (
              <>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 14 }}>Applied before or after VAT and service charge?</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" style={{ flex: 1 }} onClick={() => setAllTiming('pre')}>Before tax</button>
                  <button className="btn btn-dark" style={{ flex: 1, background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)' }} onClick={() => setAllTiming('post')}>After tax</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 12 }}>Applied to one tax only? <span style={{ color: 'var(--acc-text)', cursor: 'pointer' }} onClick={() => setPromptMore(true)}>More options</span></div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>Which tax does the discount come off?</div>
                <div style={{ display: 'grid', gap: 8, textAlign: 'left' }}>
                  {[['pre', 'Before both', 'SC + VAT'], ['preVat', 'Before VAT, after service charge'], ['preSc', 'Before service charge, after VAT'], ['post', 'After both']].map(([v, l, sub]) => (
                    <button key={v} className="pillbtn" style={{ borderRadius: 12, padding: '11px 14px', textAlign: 'left' }} onClick={() => setAllTiming(v)}>{l}{sub ? <span style={{ color: 'var(--text3)', fontSize: 12 }}> · {sub}</span> : ''}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Per-person "+ discount" inline add on the Assign person boxes (#145).
function PdAdd({ color, isOpen, amt, label, setAmt, setLabel, onOpen, onAdd, onCancel }) {
  if (!isOpen) return <div onClick={onOpen} style={{ fontSize: 11, color, marginTop: 6, cursor: 'pointer' }}>+ discount</div>;
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input className="inp" type="number" placeholder="Amount" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ fontSize: 12, padding: '5px 7px' }} />
      <input className="inp" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ fontSize: 12, padding: '5px 7px' }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="pillbtn" style={{ color, padding: '3px 10px', fontSize: 12 }} onClick={onAdd}>Add</button>
        <button className="back-btn" style={{ fontSize: 12 }} onClick={onCancel}>cancel</button>
      </div>
    </div>
  );
}
// Custom item split — %/Qty/฿ tabs (#143, matches the original 3-mode sheet). recalc already handles
// custom/qty/amt; switching a tab just re-assigns the item into that mode.
function CustomSplit({ it, nameA, nameB, sym = '฿', setItemAssign }) {
  const qty = it.qty || 1;
  const total = it.price * qty;
  const mode = it.assignment === 'qty' ? 'qty' : it.assignment === 'amt' ? 'amt' : 'pct';
  const setMode = (m) => {
    if (m === 'pct') setItemAssign(it.id, { assignment: 'custom', splitA: it.splitA || 50, splitB: it.splitB || 50 });
    else if (m === 'qty') { const h = Math.round(qty / 2); setItemAssign(it.id, { assignment: 'qty', qtyA: it.qtyA ?? h, qtyB: it.qtyB ?? (qty - h) }); }
    else { const h = Math.round(total / 2 * 100) / 100; setItemAssign(it.id, { assignment: 'amt', amtA: it.amtA ?? h, amtB: it.amtB ?? Math.round((total - h) * 100) / 100 }); }
  };
  return (
    <div style={{ padding: '0 14px 10px' }}>
      <div style={{ display: 'flex', border: '0.5px solid var(--border)', borderRadius: 8, overflow: 'hidden', width: 'fit-content', marginBottom: 6 }}>
        {[['pct', '%'], ['qty', 'Qty'], ['amt', sym]].map(([m, l]) => (
          <button key={m} onClick={() => setMode(m)} style={{ padding: '4px 12px', fontSize: 12, border: 'none', background: mode === m ? 'var(--acc)' : 'var(--card)', color: mode === m ? '#fff' : 'var(--text2)', cursor: 'pointer' }}>{l}</button>
        ))}
      </div>
      {mode === 'pct' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
          <span>{nameA}</span>
          <input className="inp" type="number" value={it.splitA ?? 50} style={{ width: 58 }} onChange={(e) => { const a = Math.min(100, Math.max(0, parseInt(e.target.value) || 0)); setItemAssign(it.id, { splitA: a, splitB: 100 - a }); }} />
          <span>% · {nameB} {100 - (it.splitA ?? 50)}%</span>
        </div>
      )}
      {mode === 'qty' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
          <span>{nameA}</span>
          <input className="inp" type="number" step="any" value={it.qtyA ?? 0} style={{ width: 54 }} onChange={(e) => { const a = Math.max(0, parseFloat(e.target.value) || 0); setItemAssign(it.id, { qtyA: a, qtyB: Math.max(0, qty - a) }); }} />
          <span>{nameB}</span>
          <input className="inp" type="number" step="any" value={it.qtyB ?? 0} style={{ width: 54 }} onChange={(e) => { const b = Math.max(0, parseFloat(e.target.value) || 0); setItemAssign(it.id, { qtyB: b, qtyA: Math.max(0, qty - b) }); }} />
          <span>of {qty}</span>
        </div>
      )}
      {mode === 'amt' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
          <input className="inp" type="number" placeholder={`${nameA} ${sym}`} value={it.amtA ?? ''} style={{ width: 78 }} onChange={(e) => { const a = Math.max(0, parseFloat(e.target.value) || 0); setItemAssign(it.id, { amtA: a, amtB: Math.max(0, Math.round((total - a) * 100) / 100) }); }} />
          <input className="inp" type="number" placeholder={`${nameB} ${sym}`} value={it.amtB ?? ''} style={{ width: 78 }} onChange={(e) => { const b = Math.max(0, parseFloat(e.target.value) || 0); setItemAssign(it.id, { amtB: b, amtA: Math.max(0, Math.round((total - b) * 100) / 100) }); }} />
          <span>of {fmtMoney(total, sym)}</span>
        </div>
      )}
    </div>
  );
}
// Shared assignment UI (#150) — one implementation for both items and discounts.
// No-mode rotating chip: tap label cycles A→B→Shared; ▾ (shared only) opens the share sub-modes.
function AssignChip({ cls, label, shared, id, openDd, setOpenDd, onCycle, shareOpts, onPick }) {
  return (
    <div className="assign-dd-wrap" onClick={(e) => e.stopPropagation()}>
      <div className={'assign-chip ' + cls}>
        <div className="chip-cycle" style={{ cursor: 'pointer', ...(shared ? {} : { padding: '4px 12px' }) }} onClick={onCycle}>{label}</div>
        {shared && <div className="chip-divider" />}
        {shared && <div className="chip-dd-btn" onClick={() => setOpenDd((x) => (x === id ? null : id))}>▾</div>}
      </div>
      {shared && (
        <div className={'assign-dropdown' + (openDd === id ? ' open' : '')}>
          {shareOpts.map(([v, dot, dl]) => (
            <div key={v} className="assign-dd-opt" onClick={() => onPick(v)}><div className="assign-dd-dot" style={{ background: dot }} />{dl}</div>
          ))}
        </div>
      )}
    </div>
  );
}
// Active-name mode: colored check circle.
function AssignCircle({ bg, border, check }) {
  return (
    <div style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${border}`, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {check && <svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  );
}
function Toggle({ label, on, pct, onToggle, onPct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button role="switch" aria-checked={on} aria-label={label} onClick={onToggle}
        style={{ width: 44, height: 26, borderRadius: 20, background: on ? 'var(--acc)' : '#CFD3D2', border: 'none', position: 'relative', flexShrink: 0, cursor: 'pointer', transition: 'background 0.15s', padding: 0 }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'left 0.15s' }} />
      </button>
      <span style={{ flex: 1, fontSize: 14 }}>{label}</span>
      {on && <input className="inp" type="number" value={pct} style={{ width: 64 }} onChange={(e) => onPct(parseFloat(e.target.value) || 0)} />}
      {on && <span style={{ color: 'var(--text3)', fontSize: 12 }}>%</span>}
    </div>
  );
}
function discTargetLabel(d, nameA, nameB) {
  switch (d.assignTo) {
    case 'a': return nameA;
    case 'b': return nameB;
    case 'prop': return 'proportional';
    case 'pct': return `${d.pctA}/${100 - d.pctA}%`;
    case 'fixed': return `fixed ${d.amtA}/${d.amtB}`;
    default: return '50/50';
  }
}
function Row({ l, r, bold }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontWeight: bold ? 700 : 400 }}><span>{l}</span><span>{r}</span></div>;
}
