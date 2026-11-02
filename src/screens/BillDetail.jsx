import { useStore } from '../store.jsx';
import { recalc } from '../calc.js';
import { fmtMoney, fmtDate, initials } from '../format.js';
import { catMeta } from '../config.js';
import { evalExpr } from '../expr.js';

const fieldNum = (e) => evalExpr(e) || 0;

// Grouped bill-breakdown detail, ported 1:1 from the old app's showBillDetail (#158): Shared section +
// per-person sections (own items + personal discounts + shared portion + subtotal) + totals + payment.
export default function BillDetail() {
  const { bills, detailId, config, closeDetail, startEdit, deleteBill, editBill } = useStore();
  const bill = bills.find((b) => b.id === detailId);
  if (!bill) return null;

  const sym = config.currencySymbol;
  const nameA = config.personA || 'Person A';
  const nameB = config.personB || 'Person B';
  const meta = catMeta(bill.category);

  const billQuick = bill.quick || bill.charges?.quick || null;
  const isQuick = bill.mode === 'quick' || bill.charges?.mode === 'quick'
    || ((bill.items || []).length === 0 && (bill.grandTotal || 0) > 0);

  const items = bill.items || [];
  const charges = bill.charges || {};
  const chDiscs = charges.discounts || [];
  const calc = recalc(items, charges);

  const shareA = isQuick ? (bill.shareA || 0) : calc.shareA;
  const shareB = isQuick ? (bill.shareB || 0) : calc.shareB;
  const grand = isQuick ? (bill.grandTotal || 0) : calc.grandTotal;
  const payer = bill.paidBy === 'a' ? nameA : nameB;
  const payee = bill.paidBy === 'a' ? nameB : nameA;
  const owes = bill.paidBy === 'a' ? shareB : shareA;
  const del = () => { if (window.confirm('Delete this bill?')) { deleteBill(bill.id); closeDetail(); } };

  // ── breakdown helpers (ported) ──
  // #168: an item explicitly split by qty / ratio / amount is now listed under each person
  // (see splitRowsFor), not in the Shared group. Only plain 50/50 shared items stay shared.
  const isSplit = (a) => a === 'qty' || a === 'custom' || a === 'amt';
  const itemRowsFor = (filter) => {
    const rows = [];
    items.forEach((it) => {
      const total = it.price * (it.qty || 1);
      const disc = it.discount || 0;
      if (filter === 'shared') {
        if (it.assignment === 'a' || it.assignment === 'b') return;
        if (isSplit(it.assignment)) return; // #168: split items now shown per person
        rows.push({ id: it.id, name: it.name + (it.qty > 1 ? ' ×' + it.qty : ''), amt: total, disc, discLabel: it.discountLabel });
      } else {
        if (it.assignment !== filter) return;
        rows.push({ id: it.id, name: it.name + (it.qty > 1 ? ' ×' + it.qty : ''), amt: total, disc, discLabel: it.discountLabel });
      }
    });
    return rows;
  };
  // #168: per-person rows for split items (qty/custom/amt) — each shows that person's portion.
  const splitRowsFor = (person) => {
    const rows = [];
    items.forEach((it) => {
      if (!isSplit(it.assignment)) return;
      const total = it.price * (it.qty || 1);
      const d = it.discount || 0;
      let amt = 0, disc = 0, qtyLabel = '';
      if (it.assignment === 'qty') {
        const q = person === 'a' ? (it.qtyA || 0) : (it.qtyB || 0);
        const qT = (it.qtyA || 0) + (it.qtyB || 0);
        amt = it.price * q; if (d && qT > 0) disc = d * q / qT;
        qtyLabel = q > 0 ? ' ×' + q : '';
      } else if (it.assignment === 'amt') {
        const a = person === 'a' ? (it.amtA || 0) : (it.amtB || 0);
        amt = a; if (d && total > 0) disc = d * a / total;
      } else { // custom ratio
        const split = person === 'a' ? (it.splitA || 50) / 100 : (it.splitB || 50) / 100;
        amt = total * split; if (d) disc = d * split;
      }
      if (amt <= 0 && disc <= 0) return; // this person has no portion of the item
      rows.push({ id: it.id, name: it.name + qtyLabel, amt, disc, discLabel: it.discountLabel });
    });
    return rows;
  };
  // #168: shared portion now covers ONLY plain 50/50 shared items — split items are
  // listed as their own per-person rows above, so they must not be double-counted here.
  const sharedPortionFor = (person) => {
    let amt = 0, disc = 0;
    items.forEach((it) => {
      if (it.assignment === 'a' || it.assignment === 'b') return;
      if (isSplit(it.assignment)) return;
      const total = it.price * (it.qty || 1);
      const d = it.discount || 0;
      const split = person === 'a' ? (it.splitA || 50) / 100 : (it.splitB || 50) / 100;
      amt += total * split; if (d) disc += d * split;
    });
    return { amt, disc };
  };
  const discTypeLabel = (d) => d.assignTo === 'prop' ? 'proportional'
    : d.assignTo === 'pct' ? `${d.pctA || 50}/${100 - (d.pctA || 50)}%`
    : d.assignTo === 'fixed' ? `fixed ${fmtMoney(d.amtA || 0, sym)}/${fmtMoney(d.amtB || 0, sym)}`
    : '50/50';

  const sharedRows = itemRowsFor('shared');
  const sharedBillDiscs = chDiscs.filter((d) => d.amt && d.assignTo !== 'a' && d.assignTo !== 'b');
  const totalDisc = (calc.itemDiscA || 0) + (calc.itemDiscB || 0) + (calc.personalDiscA || 0) + (calc.personalDiscB || 0) + (calc.sharedDiscA || 0) + (calc.sharedDiscB || 0);

  const ItemLine = ({ r }) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', padding: '2px 0' }}>
        <span>{r.name}</span><span>{fmtMoney(r.amt, sym)}</span>
      </div>
      {r.disc > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#2a9d5c', padding: '0 0 2px 8px' }}>
          <span>{r.discLabel || 'Discount'}</span><span>−{fmtMoney(r.disc, sym)}</span>
        </div>
      )}
    </>
  );

  const personSection = (person, avCls, name, ini, share) => {
    const ownRows = [...itemRowsFor(person), ...splitRowsFor(person)]; // #168: include split-item portions
    const personalDiscs = chDiscs.filter((d) => d.amt && d.assignTo === person);
    const shared = sharedPortionFor(person);
    if (!ownRows.length && !(shared.amt > 0) && !personalDiscs.length && !share) return null;
    return (
      <div style={{ padding: '10px 14px', borderTop: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div className={`av ${avCls}`} style={{ width: 24, height: 24, fontSize: 9 }}>{initials(name, ini)}</div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
        </div>
        <div style={{ paddingLeft: 32 }}>
          {ownRows.map((r) => <ItemLine key={r.id} r={r} />)}
          {personalDiscs.map((d) => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0 2px 8px' }}>
              <span style={{ color: 'var(--text3)' }}>{d.label || 'Discount'}</span><span style={{ color: '#2a9d5c' }}>−{fmtMoney(d.amt, sym)}</span>
            </div>
          ))}
          {shared.amt > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text3)', padding: '4px 0 0', borderTop: '0.5px dashed var(--border)', marginTop: 4 }}>
              <span>+ Shared portion</span><span>{fmtMoney(shared.amt - shared.disc, sym)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, padding: '4px 0 0' }}>
            <span>Subtotal</span><span>{fmtMoney(share, sym)}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-head">
        <button className="back-btn" onClick={closeDetail}>‹ Back</button>
        <strong>Bill detail</strong>
      </div>

      <div className="screen">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div className="cat-icon" style={{ background: meta.color + '22', width: 44, height: 44, fontSize: 20 }}>{meta.emoji}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>{bill.place || 'Unknown'}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(bill.date)} · {payer} paid</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
          <span style={{ color: 'var(--text3)' }}>Category</span>
          <select value={bill.category || ''} onChange={(e) => editBill({ ...bill, category: e.target.value })}
            style={{ padding: '5px 8px', borderRadius: 8, border: '0.5px solid var(--border)', background: 'var(--card)', fontSize: 13 }}>
            <option value="">Uncategorized</option>
            <option value="food">Food &amp; drink</option><option value="shop">Shopping</option>
            <option value="cafe">Café</option><option value="transport">Transport</option><option value="other">Other</option>
          </select>
        </div>

        <div className="sec-label">BILL BREAKDOWN</div>
        <div className="card" style={{ padding: 0, marginBottom: 16 }}>
          {isQuick ? (
            <div style={{ padding: '12px 14px', fontSize: 13 }}>
              <Row l={`${nameA} only`} r={fmtMoney(fieldNum(billQuick?.aExpr), sym)} />
              <Row l={`${nameB} only`} r={fmtMoney(fieldNum(billQuick?.bExpr), sym)} />
              <Row l="Shared (50/50)" r={fmtMoney(Math.max(0, grand - fieldNum(billQuick?.aExpr) - fieldNum(billQuick?.bExpr)), sym)} />
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text3)' }}>No item detail — edit to add items.</div>
          ) : (
            <>
              {(sharedRows.length > 0 || sharedBillDiscs.length > 0) && (
                <div style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--text3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Shared</span>
                  </div>
                  <div style={{ paddingLeft: 32 }}>
                    {sharedRows.map((r) => <ItemLine key={r.id} r={r} />)}
                    {sharedBillDiscs.map((d) => (
                      <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '4px 0 0', borderTop: '0.5px dashed var(--border)', marginTop: 4 }}>
                        <span style={{ color: 'var(--text3)' }}>{d.label || 'Discount'} ({discTypeLabel(d)})</span><span style={{ color: '#2a9d5c' }}>−{fmtMoney(d.amt, sym)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {personSection('a', 'av-a', nameA, config.initialsA, shareA)}
              {personSection('b', 'av-b', nameB, config.initialsB, shareB)}

              <div style={{ padding: '10px 14px', fontSize: 12, borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text3)', padding: '2px 0' }}><span>Item subtotal</span><span>{fmtMoney(calc.subtotal, sym)}</span></div>
                {totalDisc > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: '#2a9d5c', padding: '2px 0' }}><span>Total discount</span><span>−{fmtMoney(totalDisc, sym)}</span></div>}
                {calc.sc > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text3)', padding: '2px 0' }}><span>SC {calc.scPct}%</span><span>+{fmtMoney(calc.sc, sym)}</span></div>}
                {calc.vat > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text3)', padding: '2px 0' }}><span>VAT {calc.vatPct}%</span><span>+{fmtMoney(calc.vat, sym)}</span></div>}
                {(calc.feeA + calc.feeB) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text3)', padding: '2px 0' }}><span>{(charges.fees || []).map((f) => f.label).join(' + ') || 'Fees'}</span><span>+{fmtMoney(calc.feeA + calc.feeB, sym)}</span></div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, padding: '6px 0 0', borderTop: '0.5px solid var(--border)', marginTop: 4, fontSize: 14 }}><span>Grand total</span><span>{fmtMoney(grand, sym)}</span></div>
              </div>
            </>
          )}
        </div>

        <div className="sec-label">PAYMENT</div>
        <div className="card" style={{ padding: '4px 0', fontSize: 13, marginBottom: 16 }}>
          <div className="card-row"><span>Paid by</span><span style={{ fontWeight: 500 }}>{payer}</span></div>
          <div className="card-row"><span>{nameA}'s share</span><span>{fmtMoney(shareA, sym)}</span></div>
          <div className="card-row"><span>{nameB}'s share</span><span>{fmtMoney(shareB, sym)}</span></div>
          <div className="card-row" style={{ borderTop: '0.5px solid var(--border)' }}><span style={{ fontWeight: 500 }}>{payee} owes {payer}</span><span style={{ fontWeight: 600, color: '#2a9d5c' }}>+{fmtMoney(owes, sym)}</span></div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => startEdit(bill)} style={{ flex: 1, padding: 13, border: '1px solid var(--acc)', borderRadius: 12, background: 'var(--card)', color: 'var(--acc)', cursor: 'pointer', fontWeight: 600 }}>Edit</button>
          <button onClick={del} style={{ flex: 1, padding: 13, border: 'none', borderRadius: 12, background: 'var(--red)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function Row({ l, r, bold }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontWeight: bold ? 700 : 400 }}><span>{l}</span><span>{r}</span></div>;
}
