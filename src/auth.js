// SplitApp — Google ID-token holder. The token is sent with every request to the Apps Script
// backend, which verifies it server-side. ID tokens last ~1 hour; refreshIdToken() asks Google
// for a fresh one silently (One Tap auto-select) and gives up after a few seconds.

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
