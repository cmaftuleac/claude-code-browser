import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronLeft, AlertTriangle } from 'lucide-react';
import { PLAN_CATALOG, priceFor, type PlanId, type BillingInterval } from '@fineguide-tesseract/shared';
import { useAuthStore } from '../stores/auth-store';
import { Segmented } from './controls/Segmented';

const ANIM = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface Props {
  /** 'onboarding' = step 2 of the post-signup flow; 'settings' = Manage plan (with back). */
  mode: 'onboarding' | 'settings';
  /** Called after a plan is successfully recorded. */
  onSelected?: (plan: PlanId) => void;
  onBack?: () => void;
}

export function PlansView({ mode, onSelected, onBack }: Props) {
  const user = useAuthStore((s) => s.user);
  const setPlan = useAuthStore((s) => s.setPlan);
  const error = useAuthStore((s) => s.error);
  const currentPlan: PlanId = user?.plan ?? 'free';
  const currentInterval: BillingInterval = user?.interval === 'annual' ? 'annual' : 'monthly';

  const [billing, setBilling] = useState<BillingInterval>(currentInterval);
  const [pending, setPending] = useState<PlanId | null>(null);

  const choose = async (plan: PlanId): Promise<void> => {
    setPending(plan);
    try {
      await setPlan({ plan, interval: billing });
      onSelected?.(plan);
    } catch {
      /* error surfaced via the store */
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={`plans plans--${mode}`}>
      {mode === 'settings' && onBack && (
        <button className="auth-back" onClick={onBack} type="button">
          <ChevronLeft size={16} strokeWidth={2} />
          <span>Back</span>
        </button>
      )}

      <div className="plans__head">
        <h2 className="plans__title">{mode === 'onboarding' ? 'Choose your plan' : 'Plans & billing'}</h2>
        <p className="plans__sub">Switch anytime. Paid plans are free to select while billing is being set up.</p>
        <div className="plans__interval">
          <Segmented<BillingInterval>
            value={billing}
            onChange={setBilling}
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'annual', label: 'Annual · save 10%' },
            ]}
          />
        </div>
      </div>

      <div className="plans__grid">
        {PLAN_CATALOG.map((p) => {
          const annual = billing === 'annual';
          const total = priceFor(p.id, billing);
          // Only mark a plan "current" in Settings. In onboarding the account still
          // defaults to free, but the user must be able to pick Free to finish — so
          // nothing is disabled there.
          const isCurrent = mode === 'settings' && p.id === currentPlan && (p.id === 'free' || currentInterval === billing);
          const busy = pending === p.id;
          return (
            <motion.div
              key={p.id}
              className={`plan-card ${p.id === 'pro' ? 'plan-card--feature' : ''} ${isCurrent ? 'is-current' : ''}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ANIM}
            >
              {isCurrent && <div className="plan-card__badge">Current</div>}
              <div className="plan-card__name">{p.name}</div>
              <div className="plan-card__price">
                {p.monthlyUsd === 0 ? (
                  <span className="plan-card__amt">Free</span>
                ) : (
                  <>
                    <span className="plan-card__amt">${annual ? total : p.monthlyUsd}</span>
                    <span className="plan-card__per">{annual ? '/year' : '/month'}</span>
                  </>
                )}
              </div>
              <div className="plan-card__note">
                {p.monthlyUsd > 0 && annual ? `≈ $${Math.round(total / 12)}/mo, billed annually` : ' '}
              </div>
              <div className="plan-card__tagline">{p.tagline}</div>
              <ul className="plan-card__features">
                {p.features.map((f) => (
                  <li key={f}>
                    <Check size={13} strokeWidth={2.25} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                className={`auth-btn ${p.id === 'pro' ? 'auth-btn--primary' : 'auth-btn--ghost'}`}
                disabled={busy || isCurrent}
                onClick={() => void choose(p.id)}
                type="button"
              >
                {busy ? (
                  <span className="auth-spinner" />
                ) : isCurrent ? (
                  'Current plan'
                ) : mode === 'onboarding' ? (
                  p.id === 'free' ? 'Start free' : `Choose ${p.name}`
                ) : (
                  `Switch to ${p.name}`
                )}
              </button>
            </motion.div>
          );
        })}
      </div>

      {error && (
        <div className="auth-error plans__error">
          <AlertTriangle size={13} strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
