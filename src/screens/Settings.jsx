import { useState } from 'react';
import { useStore } from '../store.jsx';
import { categorize, catDesc } from '../ocr.js';
import * as api from '../api.js';
import { CURRENCIES, APP_VERSION } from '../config.js';
import { initials } from '../format.js';

export default function Settings() {
  const { config, updateConfig, currentUser, signOut, refresh, clearCache, bills, editBill, showToast } = useStore();
  const url = config.googleSheetUrl;
  const sym = config.currencySymbol;
  const [syncing, setSyncing] = useState(false); // #163 feedback for Sync & refresh
  const [clearing, setClearing] = useState(false);
  const doSync = async () => { if (syncing) return; setSyncing(true); try { await refresh(); } catch {} window.location.reload(); }; // full reload also busts a stale app cache (like the old app)
  const doClear = async () => { if (clearing) return; if (!window.confirm('Clear local data and re-sync from Sheets?')) return; setClearing(true); try { clearCache(); } catch {} setTimeout(() => setClearing(false), 900); };
  // #171 — backfill AI categories for EXISTING uncategorized bills (empty or 'other'). Explicit,
  // batched with a delay (free-tier rate limits), background patch via editBill. Reuses #170 signal.
  const [catRun, setCatRun] = useState(null); // { done, total } | null
  const needCat = (bills || []).filter((b) => !b.category || b.category === 'other');
  const runBackfill = async () => {
    if (catRun) return;
    if (!config.geminiApiKey) return alert('Add a Gemini API key first (Connection).');
    const todo = (bills || []).filter((b) => !b.category || b.category === 'other');
    if (!todo.length) return alert('All bills are already categorized.');
    if (!window.confirm(`Auto-categorize ${todo.length} uncategorized bill(s) with AI? Runs in the background — you can keep using the app.`)) return;
    setCatRun({ done: 0, total: todo.length });
    let done = 0;
    for (const b of todo) {
      try {
        const desc = catDesc(b.place, b.items);
        if (desc) { const cat = await categorize(desc, config.geminiApiKey); if (cat && cat !== b.category) editBill({ ...b, category: cat }); }
      } catch {}
      done += 1; setCatRun({ done, total: todo.length });
      await new Promise((r) => setTimeout(r, 1200)); // rate-limit friendly gap between calls
    }
    setCatRun(null);
    if (showToast) showToast('Categorization done ✓');
  };

  const renameMember = (who) => {
    const cur = who === 'a' ? config.personA : config.personB;
    const val = window.prompt('Name', cur || '');
    if (val == null) return;
    const v = val.trim();
    updateConfig(who === 'a' ? { personA: v } : { personB: v });
    api.setConfig(url, who === 'a' ? 'person_a' : 'person_b', v);
  };

  const cycleCurrency = () => {
    const i = CURRENCIES.findIndex((c) => c.code === config.currency);
    const c = CURRENCIES[(i + 1) % CURRENCIES.length];
    updateConfig({ currency: c.code, currencySymbol: c.sym });
    api.setConfig(url, 'currency', c.code); api.setConfig(url, 'currency_symbol', c.sym);
  };

  const editConn = (key, label) => {
    const val = window.prompt(label, config[key] || '');
    if (val != null) updateConfig({ [key]: val.trim() });
  };

  const chevron = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>;

  return (
    <div className="screen">
      <div className="h1">Settings</div>

      <div className="set-group">
        <div className="sec-label">GROUP MEMBERS</div>
        <div className="set-card">
          {[['a', config.personA || 'Person A'], ['b', config.personB || 'Person B']].map(([who, name]) => (
            <div key={who} className="set-row" onClick={() => renameMember(who)} style={{ cursor: 'pointer' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={`av ${who === 'a' ? 'av-a' : 'av-b'}`}>{initials(name, who === 'a' ? config.initialsA : config.initialsB)}</span>
                <span className="lbl">{name}</span>
              </span>
              {chevron}
            </div>
          ))}
        </div>
      </div>

      <div className="set-group">
        <div className="sec-label">PREFERENCES</div>
        <div className="set-card">
          <div className="set-row" onClick={cycleCurrency} style={{ cursor: 'pointer' }}>
            <span className="lbl">Currency</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="val">{config.currency} {sym}</span>{chevron}</span>
          </div>
        </div>
      </div>

      <div className="set-group">
        <div className="sec-label">ACCOUNT</div>
        <div className="set-card">
          <div className="set-row"><span className="lbl">Signed in as</span><span className="val">{currentUser === 'b' ? (config.personB || 'B') : (config.personA || 'A')}</span></div>
          <div className="set-row" onClick={signOut} style={{ cursor: 'pointer' }}><span className="lbl" style={{ color: 'var(--red)' }}>Sign out</span></div>
        </div>
      </div>

      <div className="set-group">
        <div className="sec-label">ABOUT</div>
        <div className="set-card">
          <div className="set-row"><span className="lbl">App version</span><span className="val">{APP_VERSION}</span></div>
          <div className="set-row"><span className="lbl">Backend version</span><span className="val">{config.gsVersion || '—'}</span></div>
          <div className="set-row" onClick={() => config.googleSheetEditUrl && window.open(config.googleSheetEditUrl, '_blank')} style={{ cursor: 'pointer' }}>
            <span className="lbl">Open Google Sheet</span>{chevron}
          </div>
          <div className="set-row" onClick={doSync} style={{ cursor: 'pointer', opacity: syncing ? 0.5 : 1 }}><span className="lbl">Sync &amp; refresh</span>{syncing && <span className="spinner-sm" />}</div>
          <div className="set-row" onClick={doClear} style={{ cursor: 'pointer', opacity: clearing ? 0.5 : 1 }}><span className="lbl">Clear cache</span>{clearing && <span className="spinner-sm" />}</div>
          {(needCat.length > 0 || catRun) && (
            <div className="set-row" onClick={runBackfill} style={{ cursor: 'pointer', opacity: catRun ? 0.5 : 1 }}>
              <span className="lbl">Auto-categorize bills</span>
              {catRun ? <span className="val">{catRun.done}/{catRun.total}…</span> : <span className="val">{needCat.length} to do</span>}
            </div>
          )}
        </div>
      </div>

      <div className="set-group">
        <div className="sec-label">CONNECTION (device-local)</div>
        <div className="set-card">
          <div className="set-row" onClick={() => editConn('googleSheetUrl', 'Apps Script URL')} style={{ cursor: 'pointer' }}>
            <span className="lbl">Apps Script URL</span><span className="val" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url ? '••• set' : 'not set'}</span>
          </div>
          <div className="set-row" onClick={() => editConn('geminiApiKey', 'Gemini API key')} style={{ cursor: 'pointer' }}>
            <span className="lbl">Gemini API key</span><span className="val">{config.geminiApiKey ? '••• set' : 'not set'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
