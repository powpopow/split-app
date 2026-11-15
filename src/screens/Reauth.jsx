import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.jsx';
import { setIdToken, clearSession } from '../auth.js';
import { whoami } from '../api.js';

// #176 — shown OVER the app when the 60-day session has expired (or was revoked), instead of
// dumping the user back to Sign-in. Nothing is unmounted behind it, so signing in again drops you
// exactly where you were — including a half-finished bill parked in the basket.
export default function Reauth() {
  const { config, authedUser, signOut, endReauth, refresh } = useStore();
  const btnRef = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = async (resp) => {
      setError(''); setBusy(true);
      clearSession();                        // the old one is dead; don't let it answer for us
      setIdToken(resp.credential);           // one Google token, just to mint a new session
      try {
        const who = await whoami(config.googleSheetUrl); // rawPost stores the session it returns
        if (who && who.ok && who.person === authedUser) { endReauth(); refresh(); return; }
        if (who && who.ok) { setError('That is a different account. Sign out to switch.'); }
        else { setError(`Not authorised.${who && (who.reason || who.error) ? ' (' + (who.reason || who.error) + ')' : ''}`); }
      } catch {
        setError('Could not reach the server. Check your connection and try again.');
      } finally {
        if (!cancelled) setBusy(false);
      }
    };

    const init = () => {
      if (cancelled || !window.google?.accounts?.id || !btnRef.current) return false;
      window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: handle });
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', width: 240 });
      return true;
    };
    if (!init()) {
      const t = setInterval(() => { if (init()) clearInterval(t); }, 200);
      setTimeout(() => clearInterval(t), 5000);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.googleClientId, config.googleSheetUrl, authedUser]);

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>Session expired</div>
        <div style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center', lineHeight: 1.5 }}>
          Sign in again to continue. Nothing is lost — anything unsaved is still here.
        </div>
        <div ref={btnRef} style={{ opacity: busy ? 0.5 : 1, pointerEvents: busy ? 'none' : 'auto' }} />
        {error && <div style={errBox}>{error}</div>}
        <button onClick={signOut} style={linkBtn}>Sign out instead</button>
      </div>
    </div>
  );
}

const wrap = { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(15,32,39,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 };
const card = { background: '#fff', borderRadius: 16, padding: '26px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, maxWidth: 320, width: '100%', boxShadow: '0 12px 40px rgba(0,0,0,0.25)' };
const errBox = { background: '#FDECEC', color: '#B3261E', padding: '7px 12px', borderRadius: 8, fontSize: 12.5, textAlign: 'center' };
const linkBtn = { background: 'none', border: 'none', color: 'var(--text3)', fontSize: 12.5, textDecoration: 'underline', cursor: 'pointer', padding: 4 };
