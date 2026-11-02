// SplitApp — app state store (React context).
// Holds bills + config; running balance is DERIVED from bills (balanceFromBills) so it can
// never drift out of sync (structurally resolves #108). Writes update local state first and
// sync fire-and-forget — local is authoritative, no destructive re-pull after a write (#121).
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { CONFIG_DEFAULTS } from './config.js';
import { balanceFromBills } from './calc.js';
import * as api from './api.js';
import { clearIdToken } from './auth.js';

const StoreCtx = createContext(null);
export const useStore = () => useContext(StoreCtx);

export function StoreProvider({ children }) {
  const [bills, setBills] = useState([]);
  const [config, setConfig] = useState(CONFIG_DEFAULTS);
  const [ready, setReady] = useState(false);
  // #162 — ids of bills added locally but not yet confirmed present in a Sheet pull. A pending
  // bill is preserved across refresh() so a failed/racing write is never silently dropped.
  const [pendingIds, setPendingIds] = useState(() => new Set());
  // authedUser = the signed-in identity (persisted). currentUser = SESSION-only perspective
  // that defaults to it and can be flipped for "peek" without changing identity (#123).
  const [authedUser, setAuthedUser] = useState(() => localStorage.getItem('splitapp_user') || null);
  const [currentUser, setCurrentUser] = useState(() => localStorage.getItem('splitapp_user') || 'a');
  const switchPerspective = useCallback((who) => setCurrentUser(who), []);
  const signIn = useCallback((who) => { localStorage.setItem('splitapp_user', who); setAuthedUser(who); setCurrentUser(who); }, []);
  const signOut = useCallback(() => { localStorage.removeItem('splitapp_user'); clearIdToken(); setAuthedUser(null); }, []);
  useEffect(() => { api.onUnauthorized(signOut); return () => api.onUnauthorized(null); }, [signOut]); // token rejected/expired -> back to sign-in
  const loadConfig = useCallback(async (url) => {
    const c = await api.fetchConfig(url);
    if (c && Object.keys(c).length) setConfig((prev) => ({ ...prev, ...mapRemoteConfig(c) }));
    return c;
  }, []);
  // Lightweight UI nav: which bill's detail is open, and which bill is being edited.
  const [detailId, setDetailId] = useState(null);
  const [editing, setEditing] = useState(null);
  const openDetail = useCallback((id) => setDetailId(id), []);
  const closeDetail = useCallback(() => setDetailId(null), []);
  const startEdit = useCallback((bill) => { setEditing(bill); setDetailId(null); }, []);
  const stopEdit = useCallback(() => setEditing(null), []);
  const [toast, setToast] = useState(null); // #165 transient success/info toast
  const toastTimer = useRef(null);
  const showToast = useCallback((msg) => { setToast(msg); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 2200); }, []);

  const cfgRef = useRef(config);
  cfgRef.current = config;
  const billsRef = useRef(bills);
  billsRef.current = bills;
  const pendingRef = useRef(pendingIds);
  pendingRef.current = pendingIds;
  // #162 (A) — persistent write outbox {id: {action:'add'|'update'|'delete', bill?}}. Every write is
  // queued here and retried (on load / after each write / after refresh) until the server confirms it,
  // so a failed or un-acked write is never lost. addBill is an idempotent upsert server-side, so a
  // retry can't duplicate. Lives in its own localStorage key; not React state (never rendered).
  const outboxRef = useRef(null);
  const flushingRef = useRef(false);
  if (outboxRef.current === null) {
    try { outboxRef.current = JSON.parse(localStorage.getItem('splitapp_outbox') || '{}') || {}; } catch { outboxRef.current = {}; }
  }

  const runningBalance = balanceFromBills(bills); // derived — cannot drift (#108)

  // Hydrate from localStorage on mount, then a background refresh from Sheets.
  useEffect(() => {
    const { state, config: c } = api.loadLocal();
    if (c) setConfig((prev) => ({ ...prev, ...c }));
    if (state?.bills) setBills(state.bills);
    if (Array.isArray(state?.pendingIds)) { const p = new Set(state.pendingIds); pendingRef.current = p; setPendingIds(p); } // #162
    setReady(true);
  }, []);

  const persist = useCallback((nextBills, nextPending) => {
    const pend = nextPending || pendingRef.current; // #162 keep pending ids in the persisted blob
    api.saveLocal({ bills: nextBills, runningBalance: balanceFromBills(nextBills), pendingIds: [...pend] }, cfgRef.current);
  }, []);

  // ── #162 (A) outbox + pending helpers ──
  const saveOutbox = useCallback(() => {
    try { localStorage.setItem('splitapp_outbox', JSON.stringify(outboxRef.current || {})); } catch {}
  }, []);
  const enqueue = useCallback((id, entry) => { outboxRef.current = { ...(outboxRef.current || {}), [id]: entry }; saveOutbox(); }, [saveOutbox]);
  const dequeue = useCallback((id) => { const b = { ...(outboxRef.current || {}) }; delete b[id]; outboxRef.current = b; saveOutbox(); }, [saveOutbox]);
  const markPending = useCallback((id) => { const np = new Set(pendingRef.current); np.add(id); pendingRef.current = np; setPendingIds(np); }, []);
  const clearPending = useCallback((id) => { if (!pendingRef.current.has(id)) return; const np = new Set(pendingRef.current); np.delete(id); pendingRef.current = np; setPendingIds(np); }, []);

  // Push every queued write; drop each entry the server confirms ({ ok:true }). Serialized (flushingRef)
  // and idempotent, so it's safe to call liberally (after each write, after refresh, on load).
  const flushOutbox = useCallback(async () => {
    const url = cfgRef.current.googleSheetUrl;
    if (!url || flushingRef.current) return;
    const ids = Object.keys(outboxRef.current || {});
    if (!ids.length) return;
    flushingRef.current = true;
    try {
      for (const id of ids) {
        const entry = (outboxRef.current || {})[id];
        if (!entry) continue;
        let res;
        if (entry.action === 'delete') res = await api.removeBill(url, id);
        else if (entry.action === 'update') res = await api.putBill(url, { ...entry.bill, runningBalance: balanceFromBills(billsRef.current) });
        else res = await api.postBill(url, { ...entry.bill, runningBalance: balanceFromBills(billsRef.current) });
        if (res && res.ok) { dequeue(id); if (entry.action !== 'delete') clearPending(id); persist(billsRef.current); }
      }
    } finally { flushingRef.current = false; }
  }, [dequeue, clearPending, persist]);

  const addBill = useCallback((bill) => {
    enqueue(bill.id, { action: 'add', bill }); markPending(bill.id); // #162 (A) queue write + mark un-synced
    setBills((prev) => { const next = [...prev, bill]; persist(next); return next; });
    flushOutbox();
  }, [persist, enqueue, markPending, flushOutbox]);

  const editBill = useCallback((bill) => {
    // #162 (A) if an add for this id is still queued (never synced) keep it an 'add' upsert with the
    // latest data; otherwise it's an 'update' to an existing row.
    const queued = (outboxRef.current || {})[bill.id];
    enqueue(bill.id, { action: queued && queued.action === 'add' ? 'add' : 'update', bill });
    setBills((prev) => { const next = prev.map((b) => (b.id === bill.id ? bill : b)); persist(next); return next; });
    flushOutbox();
  }, [persist, enqueue, flushOutbox]);

  const deleteBill = useCallback((id) => {
    // #162 (A) if an add is still queued (never reached the Sheet) just drop it — nothing remote to
    // delete; otherwise queue a delete to retry until confirmed.
    const queued = (outboxRef.current || {})[id];
    if (queued && queued.action === 'add') { dequeue(id); clearPending(id); }
    else enqueue(id, { action: 'delete', id });
    setBills((prev) => { const next = prev.filter((b) => b.id !== id); persist(next); return next; });
    flushOutbox();
  }, [persist, enqueue, dequeue, clearPending, flushOutbox]);

  // Explicit refresh (foreground / pull-to-refresh) — the only place we overwrite from Sheets.
  const refresh = useCallback(async () => {
    const url = cfgRef.current.googleSheetUrl;
    if (!url) return;
    try {
      // Config FIRST so person names are known before we map each bill's paidBy (#120).
      const remoteCfg = await api.fetchConfig(url);
      const merged = { ...cfgRef.current, ...(remoteCfg && Object.keys(remoteCfg).length ? mapRemoteConfig(remoteCfg) : {}) };
      if (remoteCfg && Object.keys(remoteCfg).length) setConfig(merged);
      const remoteBills = await api.fetchBills(url, merged);
      // #162 — merge instead of blind replace. A pending id now present remotely is confirmed
      // (cleared); one still absent is an un-committed local write we keep. A previously-confirmed
      // bill that is now absent = a real remote delete -> not re-added (never resurrect #122).
      const remoteIds = new Set(remoteBills.map((b) => b.id));
      const nextPending = new Set([...pendingRef.current].filter((id) => !remoteIds.has(id)));
      const keptLocal = billsRef.current.filter((b) => nextPending.has(b.id) && !remoteIds.has(b.id));
      const mergedBills = [...remoteBills, ...keptLocal];
      pendingRef.current = nextPending; setPendingIds(nextPending);
      // #162 (A) an add is confirmed the moment its row exists remotely — drop it from the outbox so it
      // stops retrying (updates/deletes keep retrying until their own ok; they're idempotent).
      const box = { ...(outboxRef.current || {}) }; let boxChanged = false;
      for (const oid of Object.keys(box)) { if (box[oid].action === 'add' && remoteIds.has(oid)) { delete box[oid]; boxChanged = true; } }
      if (boxChanged) { outboxRef.current = box; saveOutbox(); }
      setBills(mergedBills);
      api.saveLocal({ bills: mergedBills, runningBalance: balanceFromBills(mergedBills), pendingIds: [...nextPending] }, merged);
      flushOutbox(); // push any still-queued writes now that we are online
    } catch { /* keep local */ }
  }, [saveOutbox, flushOutbox]);

  const clearCache = useCallback(() => { try { localStorage.removeItem('splitapp_state'); localStorage.removeItem('splitapp_outbox'); } catch {} outboxRef.current = {}; pendingRef.current = new Set(); setPendingIds(new Set()); setBills([]); refresh(); }, [refresh]); // #162 reset pending + outbox

  // Auto-pull from Sheets once we're hydrated and signed in (initial load / after sign-in).
  useEffect(() => { if (ready && authedUser) refresh(); }, [ready, authedUser, refresh]);

  const updateConfig = useCallback((patch) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      api.saveLocal({ bills, runningBalance: balanceFromBills(bills) }, next);
      return next;
    });
  }, [bills]);

  // Projected balance if `draft` (a new or edited bill) were saved — used by the confirm
  // preview so edits reverse the old bill correctly (structurally fixes #105).
  const projectedBalance = useCallback((draft) => {
    const list = bills.some((b) => b.id === draft.id)
      ? bills.map((b) => (b.id === draft.id ? draft : b))
      : [...bills, draft];
    return balanceFromBills(list);
  }, [bills]);

  const value = {
    bills, config, runningBalance, ready, currentUser, switchPerspective, pendingIds, // #164 expose unsynced-bill ids
    authedUser, signIn, signOut, loadConfig,
    detailId, editing, openDetail, closeDetail, startEdit, stopEdit, toast, showToast, // #165
    addBill, editBill, deleteBill, refresh, clearCache, updateConfig, setConfig, projectedBalance,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

// Map Sheets Config-tab keys → CONFIG shape.
function mapRemoteConfig(c) {
  const out = {};
  if (c.gemini_key) out.geminiApiKey = c.gemini_key;
  if (c.gs_version) out.gsVersion = c.gs_version;
  if (c.person_a) out.personA = c.person_a;
  if (c.person_b) out.personB = c.person_b;
  if (c.currency) out.currency = c.currency;
  if (c.currency_symbol) out.currencySymbol = c.currency_symbol;
  if (c.person_a_emails) out.personAEmails = String(c.person_a_emails).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (c.person_b_emails) out.personBEmails = String(c.person_b_emails).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (c.person_a_initials) out.initialsA = String(c.person_a_initials).trim().toUpperCase().slice(0, 2); // #157
  if (c.person_b_initials) out.initialsB = String(c.person_b_initials).trim().toUpperCase().slice(0, 2);
  return out;
}
