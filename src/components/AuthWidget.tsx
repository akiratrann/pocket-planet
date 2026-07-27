import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useI18n } from '../i18n';

/** Header entry point for accounts: a "Log in" button (guest) or an account
 *  menu (signed in). Opens a modal with a combined login / sign-up form. */
export default function AuthWidget() {
  const { t } = useI18n();
  const authUser = useAppStore((s) => s.authUser);
  const logout = useAppStore((s) => s.logout);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the account menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  if (authUser) {
    const initial = (authUser.name || authUser.email).trim().charAt(0).toUpperCase();
    return (
      <div className="acct" ref={menuRef}>
        <button
          className="acct__btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={authUser.name || authUser.email}
        >
          <span className="acct__avatar" aria-hidden>
            {initial}
          </span>
          <span className="acct__name">{authUser.name || authUser.email}</span>
        </button>
        {menuOpen && (
          <div className="acct__menu" role="menu">
            <div className="acct__meta">
              <div className="acct__meta-label">{t('signed_in_as')}</div>
              <div className="acct__meta-email">{authUser.email}</div>
            </div>
            <button
              className="acct__logout"
              role="menuitem"
              onClick={() => {
                logout();
                setMenuOpen(false);
              }}
            >
              {t('log_out')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button className="acct__login" onClick={() => setModalOpen(true)}>
        {t('log_in')}
      </button>
      {modalOpen && <AuthModal onClose={() => setModalOpen(false)} />}
    </>
  );
}

function AuthModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const login = useAppStore((s) => s.login);
  const signup = useAppStore((s) => s.signup);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') await signup(email, password, name);
      else await login(email, password);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal auth-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 className="auth-modal__title">{mode === 'signup' ? t('create_account') : t('welcome_back')}</h2>
        <p className="auth-modal__sub">{t('auth_subtitle')}</p>

        <form className="auth-form" onSubmit={submit}>
          {mode === 'signup' && (
            <label className="auth-field">
              <span>{t('name')}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('name_ph')}
                autoComplete="name"
              />
            </label>
          )}
          <label className="auth-field">
            <span>{t('email')}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('email_ph')}
              autoComplete="email"
              required
            />
          </label>
          <label className="auth-field">
            <span>{t('password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('password_ph')}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </label>

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? (mode === 'signup' ? t('auth_creating') : t('auth_signing_in')) : mode === 'signup' ? t('sign_up') : t('log_in')}
          </button>
        </form>

        <button
          className="auth-switch"
          onClick={() => {
            setError(null);
            setMode((m) => (m === 'login' ? 'signup' : 'login'));
          }}
        >
          {mode === 'login' ? t('no_account') : t('have_account')}
        </button>
        <button className="auth-guest" onClick={onClose}>
          {t('auth_or_guest')}
        </button>
      </div>
    </div>
  );
}
