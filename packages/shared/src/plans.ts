/**
 * Subscription plan catalog — the single source of truth for plan ids, prices,
 * and feature copy. Shared by the cloud API (apps/api), the onboarding flow, the
 * plans page, and Settings. Hardcoded (not server-driven) on purpose so the plans
 * page renders offline; refine the feature lists / prices here as the product evolves.
 *
 * Billing is NOT yet wired to Stripe — selecting a paid plan only records the choice
 * (plan + interval) on the account; no charge is made.
 */

export type PlanId = 'free' | 'standard' | 'pro';
export type BillingInterval = 'monthly' | 'annual';

/** Discount applied to 12× the monthly price when billed annually. */
export const ANNUAL_DISCOUNT = 0.1;

export interface PlanInfo {
  id: PlanId;
  name: string;
  /** Monthly list price in whole USD (0 for free). */
  monthlyUsd: number;
  /** One-line positioning tagline shown under the plan name. */
  tagline: string;
  /** Feature bullets shown on the plan card (PROPOSAL — refine freely). */
  features: string[];
}

export const PLAN_CATALOG: PlanInfo[] = [
  {
    id: 'free',
    name: 'Free',
    monthlyUsd: 0,
    tagline: 'Try Tesseract on your own machine.',
    features: [
      '~50 agent messages / month',
      'Haiku-class models',
      '1 concurrent agent',
      'Up to 3 projects',
      'Basic embedded browser automation',
      'Community support',
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    monthlyUsd: 20,
    tagline: 'For individuals who build every day.',
    features: [
      '1,500 agent messages / month',
      'Sonnet + Haiku models',
      'Up to 3 concurrent agents',
      'Unlimited projects',
      'Cloud workspace sync',
      'Up to 3 team seats',
      'High reasoning effort',
      'Full browser automation',
      'Email support',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyUsd: 200,
    tagline: 'For power users and teams shipping at scale.',
    features: [
      'Unlimited agent messages (fair-use)',
      'Sonnet + Opus + early-access models',
      'Up to 10 concurrent agents',
      'Unlimited projects',
      'Cloud workspace sync',
      'Up to 25 team seats',
      'Max reasoning effort',
      'Parallel browser sessions',
      'Priority support + onboarding',
      'Early-access features',
    ],
  },
];

/** All valid plan ids (handy for runtime validation on the API side). */
export const PLAN_IDS: PlanId[] = ['free', 'standard', 'pro'];

export function planById(id: PlanId): PlanInfo {
  return PLAN_CATALOG.find((p) => p.id === id) ?? PLAN_CATALOG[0];
}

/**
 * Total price in whole USD for a plan at the given interval.
 *  - monthly → the monthly price
 *  - annual  → 12× monthly with the annual discount, rounded to a whole dollar
 *    (Standard → $216/yr, Pro → $2160/yr).
 */
export function priceFor(plan: PlanId, interval: BillingInterval): number {
  const monthly = planById(plan).monthlyUsd;
  if (interval === 'monthly') return monthly;
  return Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT));
}
