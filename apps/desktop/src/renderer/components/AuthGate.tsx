import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from '../stores/auth-store';
import { LoginView } from './LoginView';
import { BrandMark } from './icons/BrandMark';

const FADE = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Web: blocks the app with a login screen until authenticated (when the server
 * requires auth). Desktop: requireAuth is always false → a transparent pass-through
 * (the app is fully usable without login). Either way it runs auth-store.init() once.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const requireAuth = useAuthStore((s) => s.requireAuth);

  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);

  // Desktop (and ungated web servers): never block.
  if (!requireAuth) return <>{children}</>;

  return (
    <AnimatePresence mode="wait">
      {status === 'unknown' ? (
        <motion.div
          key="splash"
          className="auth-splash"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FADE}
        >
          <div className="auth-splash__brand"><BrandMark size={20} /> FINEGUIDE TESSERACT</div>
        </motion.div>
      ) : status !== 'authed' ? (
        <motion.div
          key="gate"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FADE}
        >
          <LoginView mode="gate" />
        </motion.div>
      ) : (
        <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
