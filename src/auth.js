// SplitApp — credential holder.
// TWO credentials live here (#176):
//   1. The APP SESSION token minted by our Apps Script backend after it verifies a Google ID token.
//      This is the normal credential: it lasts 60 days and renews itself past halfway, so the app
//      stays signed in across days. Prefer it for every request.
//   2. The Google ID token, used only to obtain (1). It lasts ~1 hour, which is why it cannot be the
//      session on its own — relying on it is what sent users back to Sign-in every morning.
// refreshIdToken() silently asks Google for a fresh ID token; it is best-effort only (One Tap will
// often decline), so nothing depends on it succeeding any more.

const SESSION_KEY = 'splitapp_session';
const KEY = 'splitapp_idtoken';

function tokenExp(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)).exp || 0;
  } catch { return 0; }
}

/** The stored token if it still has >30s left, else ''. */
export function getIdToken() {
  try {
    const t = localStorage.getItem(KEY) || '';
    return t && tokenExp(t) > Date.now() / 1000 + 30 ? t : '';
  } catch { return ''; }
}

export function setIdToken(token) {
  try { localStorage.setItem(KEY, token); } catch {}
}

export function clearIdToken() {
  try { localStorage.removeItem(KEY); } catch {}
}

/** Silently request a fresh ID token. Resolves '' if Google needs the user to sign in again. */
export function refreshIdToken(clientId) {
  return new Promise((resolve) => {
    const gsi = window.google?.accounts?.id;
    if (!gsi) return resolve('');
    let settled = false;
    const finish = (t) => { if (!settled) { settled = true; resolve(t || ''); } };
    gsi.initialize({
      client_id: clientId,
      auto_select: true,
      callback: (resp) => {
        if (resp?.credential) { setIdToken(resp.credential); finish(resp.credential); } else finish('');
      },
    });
    gsi.prompt((n) => { if (n.isNotDisplayed?.() || n.isSkippedMoment?.()) finish(''); });
    setTimeout(() => finish(''), 6000);
  });
}

// ── app session (#176) ───────────────────────────────────
/** The backend-issued session token, or ''. Checked server-side; not parsed here. */
export function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

export function setSession(token) {
  try { if (token) localStorage.setItem(SESSION_KEY, token); } catch {}
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}
