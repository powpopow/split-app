import { useState } from 'react';
import { useStore } from '../store.jsx';
import { fmtMoney, initials } from '../format.js';
import { isSettled } from '../calc.js';
import { filterBills, thisMonthKey, thisYear, monthKeyOf } from '../dates.js';
import { CATEGORIES, catMeta } from '../config.js';

export default function Summary() {
  const { bills, config } = useStore();
  const sym = config.currencySymbol;
  const nameA = config.personA || 'Person A';
  const nameB = config.personB || 'Person B';

  const [filter, setFilter] = useState({ type: 'month', key: thisMonthKey() });
  const [pf, setPf] = useState('both'); // person filter: both | a | b
  const shown = filterBills(bills, filter);

  const chips = [
    { label: 'Week', f: { type: 'week' } },
    { label: 'Month', f: { type: 'month', key: thisMonthKey() } },
    { label: '3 mo', f: { type: '3m', key: thisMonthKey() } },
    { label: 'Year', f: { type: 'year', key: thisYear() } },
  ];

  // Category totals — value depends on the person filter (share vs grand total). Guarded (#109).
  const cats = {};
  Object.keys(CATEGORIES).forEach((k) => (cats[k] = 0));
  shown.forEach((b) => {
    const key = b.category in cats ? b.category : 'other';
    const v = pf === 'a' ? b.shareA : pf === 'b' ? b.shareB : b.grandTotal;
    cats[key] += v || 0;
  });
  const total = Object.values(cats).reduce((s, v) => s + v, 0);

  // Monthly bar data (per-person) across the months present in the filtered set.
  const months = {};
  shown.forEach((b) => {
    const m = monthKeyOf(b.date); if (!m) return;
    (months[m] ||= { a: 0, b: 0 });
    months[m].a += b.shareA || 0; months[m].b += b.shareB || 0;
  });
  const barData = Object.entries(months).sort(([a], [c]) => a.localeCompare(c))
    .map(([m, v]) => ({ label: new Date(m + '-02').toLocaleDateString('en-GB', { month: 'short' }), ...v }));
  const barMax = Math.max(1, ...barData.flatMap((d) => [d.a, d.b]));

  // Cost breakdown (guarded #109).
  const aPaid = shown.filter((b) => b.paidBy === 'a').reduce((s, b) => s + (b.grandTotal || 0), 0);
  const bPaid = shown.filter((b) => b.paidBy === 'b').reduce((s, b) => s + (b.grandTotal || 0), 0);
  const shareA = shown.reduce((s, b) => s + (b.shareA || 0), 0);
  const shareB = shown.reduce((s, b) => s + (b.shareB || 0), 0);
  const aNet = aPaid - shareA;
  const settle = isSettled(aNet) ? 'All settled up ✓'
    : aNet > 0 ? `${nameB} owes ${nameA} ${fmtMoney(aNet, sym)}` : `${nameA} owes ${nameB} ${fmtMoney(-aNet, sym)}`;

  return (
    <div className="screen">
      <div className="h1">Summary</div>

      <div className="chips">
        {chips.map((c) => (
          <button key={c.label} className={'chip' + (c.f.type === filter.type ? ' on' : '')} onClick={() => setFilter(c.f)}>{c.label}</button>
        ))}
      </div>

      {/* By category */}
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div className="sec-label" style={{ margin: 0 }}>BY CATEGORY</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[['both', 'Both'], ['a', nameA], ['b', nameB]].map(([k, l]) => {
              const on = pf === k;
              const col = k === 'a' ? 'var(--avA)' : k === 'b' ? 'var(--avB)' : 'var(--acc)'; // per-person colour when selected (#156)
              return (
                <button key={k} className={'chip chip-sm' + (on ? ' on' : '')} onClick={() => setPf(k)}
                  style={on ? { background: col, borderColor: col, color: '#fff' } : undefined}>{l}</button>
              );
            })}
          </div>
        </div>
        {total > 0 ? (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Donut cats={cats} total={total} sym={sym} />
            <div style={{ flex: 1 }}>
              {Object.entries(cats).filter(([, v]) => v > 0).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: '3px 0' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: catMeta(k).color }} />
                  <span style={{ flex: 1, color: 'var(--text2)' }}>{catMeta(k).label}</span>
                  <span style={{ fontWeight: 600 }}>{fmtMoney(v, sym)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : <div style={{ color: 'var(--text3)', fontSize: 13, padding: 8 }}>No data</div>}
      </div>

      {/* Monthly bar chart */}
      {barData.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 16 }}>
          <div className="sec-label">MONTHLY SPENDING</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 130, padding: '4px 0' }}>
            {barData.map((d, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }}>
                  <div style={{ width: 10, background: 'var(--avA)', borderRadius: '3px 3px 0 0', height: Math.max(2, (d.a / barMax) * 110) }} />
                  <div style={{ width: 10, background: 'var(--avB)', borderRadius: '3px 3px 0 0', height: Math.max(2, (d.b / barMax) * 110) }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>{d.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
            <Legend color="var(--avA)" label={nameA} />
            <Legend color="var(--avB)" label={nameB} />
          </div>
        </div>
      )}

      {/* Cost breakdown */}
      <div className="card" style={{ padding: 14 }}>
        <div className="sec-label">COST BREAKDOWN</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <PersonCol av="av-a" name={nameA} ini={config.initialsA} share={shareA} paid={aPaid} net={aNet} sym={sym} />
          <PersonCol av="av-b" name={nameB} ini={config.initialsB} share={shareB} paid={bPaid} net={-aNet} sym={sym} />
        </div>
        <div style={{ borderTop: '0.5px solid var(--border)', marginTop: 10, paddingTop: 10, fontWeight: 600 }}>{settle}</div>
      </div>
    </div>
  );
}

function Legend({ color, label }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: color }} />{label}</span>;
}
function PersonCol({ av, name, ini, share, paid, net, sym }) {
  const netColor = net > 0.01 ? 'var(--acc)' : net < -0.01 ? 'var(--red)' : 'var(--text3)';
  const netStr = Math.abs(net) < 0.01 ? '±0' : (net > 0 ? '+' : '−') + fmtMoney(net, sym);
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div className={`av ${av}`} style={{ width: 28, height: 28, fontSize: 10 }}>{initials(name, ini)}</div>
        <span style={{ fontWeight: 600 }}>{name}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>Their share</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{fmtMoney(share, sym)}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>Amount paid</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{fmtMoney(paid, sym)}</div>
      <div style={{ fontSize: 12, color: netColor, marginTop: 4 }}>net {netStr}</div>
    </div>
  );
}
function Donut({ cats, total, sym }) {
  const r = 52, cx = 68, cy = 68, circ = 2 * Math.PI * r;
  let cum = 0;
  const segs = Object.entries(cats).filter(([, v]) => v > 0).map(([k, v]) => {
    const len = (v / total) * circ;
    const el = (<circle key={k} cx={cx} cy={cy} r={r} fill="none" stroke={catMeta(k).color} strokeWidth="16"
      strokeDasharray={`${len} ${circ - len}`} transform={`rotate(${-90 + (cum / circ) * 360} ${cx} ${cy})`} />);
    cum += len; return el;
  });
  return (
    <svg width="136" height="136" viewBox="0 0 136 136" style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef2f1" strokeWidth="16" />
      {segs}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--text)">{fmtMoney(total, sym)}</text>
      <text x={cx} y={cy + 13} textAnchor="middle" fontSize="10" fill="var(--text3)">total</text>
    </svg>
  );
}
