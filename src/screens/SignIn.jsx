import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { COLORS } from '../config.js';
import { setIdToken, clearIdToken } from '../auth.js';
import { whoami } from '../api.js';

// Decode a Google ID-token JWT payload (no verification needed client-side; GSI already
// verified the signature — we only read the email to map to a person).
function decodeJWT(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch { return {}; }
}

export default function SignIn() {
  const { config, signIn } = useStore();
  const btnRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    // The server verifies the Google token and decides who you are (a | b) from the Config allow-list.
    const handle = async (resp) => {
      setError('');
      setIdToken(resp.credential);
      const email = (decodeJWT(resp.credential).email || '').toLowerCase();
      try {
        const who = await whoami(config.googleSheetUrl);
        if (who && who.ok && (who.person === 'a' || who.person === 'b')) signIn(who.person);
        else { clearIdToken(); setError(`${email || 'This account'} is not authorised to use this app.${who && (who.reason || who.error) ? ' (' + (who.reason || who.error) + ')' : ''}`); }
      } catch {
        clearIdToken();
        setError('Could not reach the server. Check your connection and try again.');
      }
    };

    const init = () => {
      if (cancelled || !window.google?.accounts?.id || !btnRef.current) return false;
      window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: handle });
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', width: 260 });
      return true;
    };
    // GSI script is async — poll briefly until it's ready.
    if (!init()) {
      const t = setInterval(() => { if (init()) clearInterval(t); }, 200);
      setTimeout(() => clearInterval(t), 5000);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.googleClientId, config.googleSheetUrl, signIn]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: COLORS.accent, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 32, color: '#fff', fontFamily: '-apple-system, sans-serif' }}>
      <div style={{ fontSize: 28, fontWeight: 700 }}>SplitApp</div>
      <div style={{ opacity: 0.85, fontSize: 14 }}>Sign in to continue</div>
      <div ref={btnRef} />
      {error && <div style={{ background: 'rgba(0,0,0,0.2)', padding: '8px 14px', borderRadius: 8, fontSize: 13 }}>{error}</div>}

      {isLocalhost() && (
        <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
          <button onClick={() => signIn('a')} style={devBtn}>Continue as {config.personA || 'A'} (dev)</button>
          <button onClick={() => signIn('b')} style={devBtn}>as {config.personB || 'B'} (dev)</button>
        </div>
      )}
    </div>
  );
}

// Dev-only bypass — active on localhost / private LAN IPs only, never in production.
function isLocalhost() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '') return true;
  return /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
const devBtn = { background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12 };
