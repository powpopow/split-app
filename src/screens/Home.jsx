import { useState } from 'react';
import { useStore } from '../store.jsx';
import { fmtMoney, fmtDate, initials } from '../format.js';
import { isSettled } from '../calc.js';
import { catMeta } from '../config.js';

export default function Home() {
  const { bills, config, runningBalance, currentUser, switchPerspective, refresh } = useStore();
  const [syncing, setSyncing] = useState(false); // #163 spinning hero refresh (restored from old app)
  const doRefresh = async () => { if (syncing) return; setSyncing(true); try { await refresh(); } finally { setSyncing(false); } };
  const sym = config.currencySymbol;
  const nameA = config.personA || 'Person A';
  const nameB = config.personB || 'Person B';
  const myName = currentUser === 'b' ? nameB : nameA;
  const otherName = currentUser === 'b' ? nameA : nameB;
  const otherWho = currentUser === 'b' ? 'a' : 'b';
  const meAv = currentUser === 'b' ? 'av-b' : 'av-a';
  const otherAv = currentUser === 'b' ? 'av-a' : 'av-b';
  const myIni = currentUser === 'b' ? config.initialsB : config.initialsA;
  const otherIni = currentUser === 'b' ? config.initialsA : config.initialsB;

  const myBal = currentUser === 'b' ? -runningBalance : runningBalance;
  const settled = isSettled(myBal);
  const heroBg = settled || myBal > 0 ? 'var(--acc)' : '#E07575'; // softer terracotta hero red (matches original; not the vivid --red #E05454 used for delete/errors) — #161
  const label = settled ? 'All settled up' : myBal > 0 ? `Get from ${otherName}` : `Pay to ${otherName}`;

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthBills = bills.filter((b) => b.date && b.date.slice(0, 7) === thisMonth);
  const monthTotal = monthBills.reduce((s, b) => s + (b.grandTotal || 0), 0);
  const recent = [...bills].reverse().slice(0, 8);

  return (
    <div className="screen">
      <div className="head">
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Hi, {myName}</div>
          <div className="greet-sub">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</div>
        </div>
        <div className="av-stack">
          <div className={`av ${otherAv} back`} title={`View as ${otherName}`} onClick={() => switchPerspective(otherWho)}>{initials(otherName, otherIni)}</div>
          <div className={`av ${meAv} front`}>{initials(myName, myIni)}</div>
        </div>
      </div>

      <div className="hero" style={{ background: heroBg }}>
        <div className="hero-top">
          <span className="hero-label">Running balance</span>
          {/* #173 refresh pill — count + single circular arrow (spins while pulling from Sheets) */}
          <button className="hero-refresh-pill" title="Refresh from Sheets" onClick={doRefresh}>
            <span>{bills.length} bills</span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: syncing ? 'spin 0.7s linear infinite' : 'none' }}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
        <div className="hero-amt">{fmtMoney(myBal, sym)}</div>
        <div className="hero-sub">{label}</div>
      </div>

      <div className="stats">
        <div className="stat"><div className="stat-val">{monthBills.length}</div><div className="stat-lbl">Bills this month</div></div>
        <div className="stat"><div className="stat-val">{fmtMoney(monthTotal, sym)}</div><div className="stat-lbl">Spent this month</div></div>
      </div>

      <div className="sec-label">RECENT</div>
      {recent.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontSize: 13, padding: 24, textAlign: 'center' }}>No bills yet. Tap + to add one.</div>
      ) : (
        <div className="card">
          {recent.map((b) => <BillRow key={b.id} b={b} currentUser={currentUser} sym={sym} nameA={nameA} nameB={nameB} otherName={otherName} />)}
        </div>
      )}
    </div>
  );
}

export function BillRow({ b, currentUser, sym, nameA, nameB, otherName }) {
  const { openDetail, pendingIds } = useStore();
  const unsynced = pendingIds && pendingIds.has(b.id); // #164 not yet confirmed saved to the Sheet
  const netForA = b.paidBy === 'a' ? b.grandTotal - b.shareA : -b.shareA;
  const myNet = currentUser === 'b' ? -netForA : netForA;
  const positive = myNet > 0;
  const meta = catMeta(b.category);
  const payer = b.paidBy === 'a' ? nameA : nameB;
  return (
    <div className="bill-row" onClick={() => openDetail(b.id)}>
      <div className="cat-icon" style={{ background: meta.color + '22' }}>{meta.emoji}</div>
      <div className="bill-main">
        <div className="bill-name">{b.place || 'Unknown'}{unsynced && <span className="sync-dot" title="Not yet saved to the sheet — will sync automatically" />}</div>
        <div className="bill-sub">{fmtDate(b.date)} · {payer} paid · {fmtMoney(b.grandTotal, sym)} total</div>
      </div>
      <div className="bill-amt">
        <div className={positive ? 'amt-grn' : 'amt-red'}>{positive ? '+' : '-'}{fmtMoney(myNet, sym)}</div>
        <div className="bill-tag">{positive ? 'get back' : `pay ${otherName}`}</div>
      </div>
    </div>
  );
}
