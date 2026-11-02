import { useState } from 'react';
import { useStore } from '../store.jsx';
import { monthLabel } from '../format.js';
import { filterBills, thisMonthKey, thisYear } from '../dates.js';
import { BillRow } from './Home.jsx';

export default function History() {
  const { bills, config, currentUser } = useStore();
  const sym = config.currencySymbol;
  const nameA = config.personA || 'Person A';
  const nameB = config.personB || 'Person B';
  const otherName = currentUser === 'b' ? nameA : nameB;

  // Date filter (#63) — reuses the timezone-safe filterBills used by Summary.
  const [filter, setFilter] = useState({ type: 'all' });
  const chips = [
    { label: 'All', f: { type: 'all' } },
    { label: 'Week', f: { type: 'week' } },
    { label: 'Month', f: { type: 'month', key: thisMonthKey() } },
    { label: '3 mo', f: { type: '3m', key: thisMonthKey() } },
    { label: 'Year', f: { type: 'year', key: thisYear() } },
  ];

  const ordered = [...filterBills(bills, filter)].reverse();
  const groups = {};
  ordered.forEach((b) => {
    const m = b.date ? b.date.slice(0, 7) : 'Unknown';
    (groups[m] ||= []).push(b);
  });

  return (
    <div className="screen">
      <div className="h1">History</div>
      <div className="chips" style={{ marginBottom: 14 }}>
        {chips.map((c) => (
          <button key={c.label} className={'chip' + (c.f.type === filter.type ? ' on' : '')} onClick={() => setFilter(c.f)}>{c.label}</button>
        ))}
      </div>
      {ordered.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontSize: 13, padding: 24, textAlign: 'center' }}>No bills in this range.</div>
      ) : Object.entries(groups).map(([m, bs]) => (
        <div key={m} style={{ marginBottom: 18 }}>
          <div className="sec-label">{m === 'Unknown' ? 'UNKNOWN DATE' : monthLabel(m).toUpperCase()}</div>
          <div className="card">
            {bs.map((b) => <BillRow key={b.id} b={b} currentUser={currentUser} sym={sym} nameA={nameA} nameB={nameB} otherName={otherName} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
