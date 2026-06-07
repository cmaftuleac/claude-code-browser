import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, AlertTriangle } from 'lucide-react';
import type { AccountType } from '@fineguide-tesseract/shared';
import { useAuthStore } from '../stores/auth-store';
import { PlansView } from './PlansView';
import { BrandMark } from './icons/BrandMark';

const ANIM = { duration: 0.22, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Post-signup, two-step flow shown full-screen by OnboardingGate while the account
 * has onboardingComplete === false. Step 1 collects name + individual/organization;
 * step 2 picks a plan. The gate releases when setPlan() (step 2) flips the flag.
 */
export function OnboardingFlow() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(user?.name ?? '');
  const [accountType, setAccountType] = useState<AccountType>('individual');
  const [orgName, setOrgName] = useState('');

  const isOrg = accountType === 'organization';
  const canContinue = name.trim().length > 0 && (!isOrg || orgName.trim().length > 0) && !loading;

  const submitProfile = async (): Promise<void> => {
    if (!canContinue) return;
    try {
      await updateProfile({
        name: name.trim(),
        accountType,
        orgName: isOrg ? orgName.trim() : undefined,
      });
      setStep(2);
    } catch {
      /* error surfaced via the store → shown inline */
    }
  };

  const flipType = (): void => {
    setAccountType((t) => (t === 'individual' ? 'organization' : 'individual'));
    clearError();
  };

  return (
    <div className="onb">
      <div className="onb__head">
        <div className="onb__brand"><BrandMark size={18} /> FINEGUIDE TESSERACT</div>
        <Steps step={step} />
      </div>

      <AnimatePresence mode="wait">
        {step === 1 ? (
          <motion.div
            key="s1"
            className="onb__panel"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={ANIM}
          >
            <h1 className="onb__title">{isOrg ? 'Set up your organization' : 'Tell us about you'}</h1>
            <p className="onb__sub">{isOrg ? 'A few basics to set up your team account.' : 'A few basics to personalize your account.'}</p>

            <label className="onb__label">Your name</label>
            <input
              className="auth-input"
              placeholder="Jane Doe"
              value={name}
              autoFocus
              spellCheck={false}
              onChange={(e) => { setName(e.target.value); if (error) clearError(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isOrg) void submitProfile(); }}
            />

            <AnimatePresence initial={false} mode="popLayout">
              {isOrg && (
                <motion.div
                  key="org"
                  style={{ overflow: 'hidden' }}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={ANIM}
                >
                  <label className="onb__label onb__label--spaced">Organization name</label>
                  <input
                    className="auth-input"
                    placeholder="Acme Inc."
                    value={orgName}
                    spellCheck={false}
                    onChange={(e) => { setOrgName(e.target.value); if (error) clearError(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void submitProfile(); }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

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

            <button className="auth-btn auth-btn--primary onb__continue" disabled={!canContinue} onClick={() => void submitProfile()} type="button">
              {loading ? <span className="auth-spinner" /> : 'Continue'}
            </button>

            <button className="onb__switch" type="button" onClick={flipType}>
              {isOrg ? 'Register as an individual?' : 'Register as an organization?'}
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="s2"
            className="onb__panel onb__panel--wide"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={ANIM}
          >
            <PlansView mode="onboarding" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Steps({ step }: { step: 1 | 2 }) {
  const items: Array<{ n: 1 | 2; label: string }> = [
    { n: 1, label: 'Profile' },
    { n: 2, label: 'Plan' },
  ];
  return (
    <div className="onb__steps">
      {items.map(({ n, label }) => (
        <div key={n} className={`onb__step ${step === n ? 'is-on' : ''} ${step > n ? 'is-done' : ''}`}>
          <span className="onb__step-dot">{step > n ? <Check size={12} strokeWidth={2.5} /> : n}</span>
          <span className="onb__step-lbl">{label}</span>
        </div>
      ))}
    </div>
  );
}
