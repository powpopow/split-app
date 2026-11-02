// Safe arithmetic evaluator for the quick-split amount fields (#147).
// Accepts digits, + - * / . and parentheses. Returns a finite number, or null if
// the string is empty / mid-typing / invalid. NEVER uses eval() or Function().

export function evalExpr(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (!/^[0-9+\-*/.()\s]+$/.test(s)) return null;

  const tokens = s.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g);
  if (!tokens) return null;

  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const out = [];
  const ops = [];
  let prev = null;
  for (const t of tokens) {
    if (/^[\d.]/.test(t)) {
      out.push(parseFloat(t));
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (!ops.length) return null; // unbalanced
      ops.pop();
    } else {
      // unary + / - at the start, after '(' or after another operator → prepend 0
      if ((t === '-' || t === '+') && (prev === null || prev === '(' || prev in prec)) out.push(0);
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop());
      ops.push(t);
    }
    prev = t;
  }
  while (ops.length) {
    const o = ops.pop();
    if (o === '(') return null; // unbalanced
    out.push(o);
  }

  const st = [];
  for (const tk of out) {
    if (typeof tk === 'number') { st.push(tk); continue; }
    const b = st.pop(), a = st.pop();
    if (a === undefined || b === undefined) return null;
    st.push(tk === '+' ? a + b : tk === '-' ? a - b : tk === '*' ? a * b : a / b);
  }
  if (st.length !== 1 || !isFinite(st[0])) return null;
  return st[0];
}
