import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '../stores/auth-store';
import { BrandMark } from './icons/BrandMark';

const ANIM = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
const SHAKE = { x: [0, -7, 6, -4, 3, 0], transition: { duration: 0.3 } };

// Federated builds collapse the card to a single "Continue with Google" CTA (no
// email/password). Desktop and dev/self-host keep the full form (email + password
// tabs + Google) — all three paths route through fineguide.ai. Opt in for a
// Google-only web deployment via VITE_CCB_FEDERATED.
const FEDERATED = import.meta.env.VITE_CCB_FEDERATED === 'true';

interface Props {
  /** 'gate' = full-screen web blocker (no back); 'push' = desktop pushed view (with back chevron). */
  mode: 'gate' | 'push';
  onBack?: () => void;
}

export function LoginView({ mode, onBack }: Props) {
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const error = useAuthStore((s) => s.error);
  const loading = useAuthStore((s) => s.loading);
  const login = useAuthStore((s) => s.login);
  const signup = useAuthStore((s) => s.signup);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const clearError = useAuthStore((s) => s.clearError);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    try {
      if (tab === 'login') await login(email.trim(), password);
      else await signup(email.trim(), password, name.trim() || undefined);
    } catch {
      /* error is surfaced via the store → card shake */
    }
  };

  const switchTab = (t: 'login' | 'signup'): void => {
    setTab(t);
    clearError();
  };

  return (
    <div className={mode === 'push' ? 'auth-view auth-view--push' : 'auth-view auth-view--gate'}>
      {mode === 'push' && onBack && (
        <button className="auth-back" onClick={onBack} type="button">
          <ChevronLeft size={16} strokeWidth={2} />
          <span>Back</span>
        </button>
      )}

      <motion.div
        className="auth-card"
        initial={mode === 'gate' ? { opacity: 0, y: 10, scale: 0.98 } : false}
        animate={error ? SHAKE : { opacity: 1, y: 0, scale: 1 }}
        transition={ANIM}
      >
        <div className="auth-card__brand"><BrandMark size={17} /> FINEGUIDE TESSERACT</div>
        <h1 className="auth-card__title">
          {FEDERATED ? 'Sign in to Tesseract' : tab === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>

        {FEDERATED ? (
          <>
            <p className="auth-card__sub">Sign in with your fineguide.ai account.</p>
            <AnimatePresence>
              {error && (
                <motion.div
                  key="err"
                  className="auth-error"
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={ANIM}
                >
                  <AlertTriangle size={13} strokeWidth={1.75} />
                  <span>{error}</span>
                </motion.div>
              )}
            </AnimatePresence>
            <button className="auth-btn auth-btn--google" disabled={loading} onClick={() => void loginWithGoogle()} type="button">
              {loading ? <span className="auth-spinner" /> : (<><GoogleMark /> Continue with Google</>)}
            </button>
          </>
        ) : (
          <LocalAuthBody
            tab={tab}
            switchTab={switchTab}
            name={name}
            setName={setName}
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            error={error}
            loading={loading}
            canSubmit={canSubmit}
            submit={submit}
            loginWithGoogle={loginWithGoogle}
            clearError={clearError}
          />
        )}
      </motion.div>
    </div>
  );
}

interface LocalAuthProps {
  tab: 'login' | 'signup';
  switchTab: (t: 'login' | 'signup') => void;
  name: string;
  setName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  loading: boolean;
  canSubmit: boolean;
  submit: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  clearError: () => void;
}

/** The legacy email/password + Google body, used in non-federated (dev/self-host) builds. */
function LocalAuthBody(p: LocalAuthProps) {
  const { tab, switchTab, name, setName, email, setEmail, password, setPassword, error, loading, canSubmit, submit, loginWithGoogle, clearError } = p;
  const googlePending = useAuthStore((s) => s.googlePending);
  const cancelGoogle = useAuthStore((s) => s.cancelGoogle);
  return (
    <>
        <div className="auth-tabs" role="tablist">
          <button className={`auth-tab ${tab === 'login' ? 'is-on' : ''}`} onClick={() => switchTab('login')} type="button">
            Sign in
          </button>
          <button className={`auth-tab ${tab === 'signup' ? 'is-on' : ''}`} onClick={() => switchTab('signup')} type="button">
            Create account
          </button>
          <motion.span
            className="auth-tabs__underline"
            animate={{ left: tab === 'login' ? '0%' : '50%' }}
            transition={ANIM}
          />
        </div>

        {/* A real <form> with named fields + a submit button so Chromium / macOS
            Keychain / password managers offer autofill and save. */}
        <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <AnimatePresence initial={false} mode="popLayout">
            {tab === 'signup' && (
              <motion.input
                key="name"
                className="auth-input"
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 38, marginBottom: 10 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={ANIM}
                name="name"
                placeholder="Name (optional)"
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
              />
            )}
          </AnimatePresence>

          <input
            className="auth-input"
            type="email"
            name="email"
            placeholder="Email"
            value={email}
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => { setEmail(e.target.value); if (error) clearError(); }}
          />
          <input
            className="auth-input"
            type="password"
            name="password"
            placeholder="Password"
            value={password}
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => { setPassword(e.target.value); if (error) clearError(); }}
          />

          <AnimatePresence>
            {error && (
              <motion.div
                key="err"
                className="auth-error"
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 10 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={ANIM}
              >
                <AlertTriangle size={13} strokeWidth={1.75} />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          <button className="auth-btn auth-btn--primary" disabled={!canSubmit} type="submit">
            {loading ? <span className="auth-spinner" /> : tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="auth-divider"><span>or</span></div>

        {googlePending ? (
          <>
            <button className="auth-btn auth-btn--google" disabled type="button">
              <span className="auth-spinner" /> Waiting for your browser…
            </button>
            <button className="auth-cancel" type="button" onClick={cancelGoogle}>Cancel</button>
          </>
        ) : (
          <button className="auth-btn auth-btn--google" disabled={loading} onClick={() => void loginWithGoogle()} type="button">
            <GoogleMark />
            Continue with Google
          </button>
        )}
    </>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
