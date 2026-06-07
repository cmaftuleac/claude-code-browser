import { AnimatePresence, motion } from 'framer-motion';
import { useAuthStore } from '../stores/auth-store';
import { OnboardingFlow } from './OnboardingFlow';
import { BrandMark } from './icons/BrandMark';

const FADE = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Blocks the app with the post-signup onboarding flow when the signed-in account
 * still has onboardingComplete === false. Nested INSIDE AuthGate, so on web it only
 * mounts once authenticated, and on desktop (never gated) it passes through entirely
 * for anonymous users — preserving the offline-first "desktop is optional" rule.
 *
 * Pure render off the auth store (no init side-effect of its own — AuthGate owns init()).
 * The flow overlays the app; when setPlan() flips onboardingComplete, the overlay fades
 * out and reveals the app underneath.
 *
 * We withhold the (heavy, side-effectful) App until auth status is *settled* — on desktop
 * AuthGate passes through during 'unknown', so without this an authed-but-not-onboarded
 * user would flash the full workspace for a frame before being redirected to onboarding.
 * init() always resolves (me() never rejects — it's offline-tolerant), so the splash is
 * brief and always clears.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const settled = status !== 'unknown';
  const needsOnboarding = status === 'authed' && user != null && user.onboardingComplete === false;

  return (
    <>
      {settled && !needsOnboarding && children}
      <AnimatePresence>
        {!settled && (
          <motion.div key="splash" className="auth-splash" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE}>
            <div className="auth-splash__brand"><BrandMark size={20} /> FINEGUIDE TESSERACT</div>
          </motion.div>
        )}
        {needsOnboarding && (
          <motion.div
            key="onb"
            className="onb-gate"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE}
          >
            <OnboardingFlow />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
