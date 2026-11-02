import { useState, useEffect } from 'react';
import { StoreProvider, useStore } from './store.jsx';
import { isUpdateAvailable } from './version-check.js';
import Home from './screens/Home.jsx';
import History from './screens/History.jsx';
import Summary from './screens/Summary.jsx';
import Settings from './screens/Settings.jsx';
import SignIn from './screens/SignIn.jsx';
import NewBillFlow from './screens/NewBillFlow.jsx';
import BillDetail from './screens/BillDetail.jsx';

const ICONS = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  summary: <><line x1="5" y1="20" x2="5" y2="11" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="19" y1="20" x2="19" y2="14" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></>,
};
const TABS = [
  { key: 'home', label: 'Home', Screen: Home },
  { key: 'history', label: 'History', Screen: History },
  { key: 'summary', label: 'Summary', Screen: Summary },
  { key: 'settings', label: 'Settings', Screen: Settings },
];

function Shell() {
  const { ready, authedUser, detailId, editing, stopEdit, toast } = useStore();
  const [tab, setTab] = useState('home');
  const [adding, setAdding] = useState(false);
  const [parked, setParked] = useState(false); // #149 — new-bill draft minimized to the basket (still mounted)
  const [updateReady, setUpdateReady] = useState(false); // #166 a newer build is deployed
  useEffect(() => {
    let alive = true;
    const check = () => { isUpdateAvailable().then((yes) => { if (alive && yes) setUpdateReady(true); }); };
    check();
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const Active = TABS.find((t) => t.key === tab).Screen;
  const closeAdd = () => { setAdding(false); setParked(false); };
  const afterSave = () => { setTab('home'); window.scrollTo(0, 0); }; // #165 land on Home; #167 reset scroll

  if (!ready) return <div style={{ padding: 24, color: '#999' }}>Loading…</div>;
  if (!authedUser) return <SignIn />;

  const navItem = (t) => (
    <button key={t.key} className={'nav-item' + (tab === t.key ? ' on' : '')} onClick={() => setTab(t.key)}>
      <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">{ICONS[t.key]}</svg>
      {t.label}
    </button>
  );

  return (
    <div className="app">
      {updateReady && (
        <button className="update-bar" onClick={() => window.location.reload()}>New version available — tap to reload</button>
      )}
      <Active />
      {detailId && <BillDetail />}
      {editing && <NewBillFlow editing={editing} onClose={stopEdit} />}
      {/* New-bill flow: kept mounted while parked (hidden) so the draft survives (#149). */}
      {adding && (
        <div style={{ display: parked ? 'none' : 'block' }}>
          <NewBillFlow onClose={closeAdd} onMinimize={() => setParked(true)} onSaved={afterSave} />
        </div>
      )}
      {/* Basket — resume a parked draft (Option B, bottom-right). */}
      {adding && parked && (
        <button onClick={() => setParked(false)} aria-label="Resume draft"
          style={{ position: 'fixed', right: 14, bottom: 74, width: 52, height: 52, borderRadius: '50%', background: '#2a3a38', color: '#fff', border: 'none', boxShadow: '0 6px 18px rgba(0,0,0,0.25)', zIndex: 45, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16v16l-2-1.5L16 20l-2-1.5L12 20l-2-1.5L8 20l-2-1.5L4 20z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="14" y2="13" /></svg>
          <span style={{ position: 'absolute', top: -2, right: -2, background: '#e07575', color: '#fff', fontSize: 10, width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>1</span>
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}
      <nav className="nav">
        {navItem(TABS[0])}
        {navItem(TABS[1])}
        <button className="nav-fab" aria-label="New bill" onClick={() => { if (adding) setParked(false); else setAdding(true); }}>
          <svg viewBox="0 0 24 24" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
        {navItem(TABS[2])}
        {navItem(TABS[3])}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
