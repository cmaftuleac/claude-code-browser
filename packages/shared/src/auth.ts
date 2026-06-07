/**
 * Auth types shared by the cloud API (apps/api), the agent/file gateway
 * (apps/server, verify-only), and the renderer/desktop transports.
 *
 * These are TYPE-ONLY — consumers import them with `import type`, so a
 * CommonJS NestJS app can reference them with no ESM/CJS runtime interop.
 */

import type { PlanId, BillingInterval } from './plans.js';

/** Whether the account is a single person or an organization. */
export type AccountType = 'individual' | 'organization';

/**
 * A signed-in user as exposed to clients (never includes the password hash).
 *
 * Identity + profile + subscription are owned by the fineguide.ai parent platform
 * (the apps/api reference implementation stands in during development). The extra
 * fields beyond {id,email,name} are derived from the JWT claims and/or `/auth/me`,
 * and are optional so older tokens and pre-onboarding users still parse.
 */
export interface User {
  id: string;
  email: string;
  name?: string;
  /** 'individual' (default) or 'organization' — set during onboarding step 1. */
  accountType?: AccountType;
  orgId?: string;
  orgName?: string;
  /** Current subscription plan (defaults to 'free'). */
  plan?: PlanId;
  /** Billing interval for paid plans (n/a for free). */
  interval?: BillingInterval;
  /** False until the user finishes the post-signup onboarding flow (the gate signal). */
  onboardingComplete?: boolean;
}

/** Result of a successful signup/login or a profile/plan write: the JWT plus the user. */
export interface AuthResult {
  token: string;
  user: User;
}

/**
 * Shape of the HS256 JWT payload minted by fineguide.ai (and the apps/api dev mock),
 * signed with the shared CCB_JWT_SECRET. A superset of the legacy {sub,email,tv} claims
 * — the verify-only gateway (apps/server) only reads `sub`; the client decodes the rest
 * to hydrate the profile offline (no network round-trip needed for the onboarding gate).
 */
export interface TesseractClaims {
  sub: string;
  email: string;
  name?: string;
  accountType?: AccountType;
  orgId?: string;
  orgName?: string;
  plan?: PlanId;
  interval?: BillingInterval;
  onboardingComplete?: boolean;
  /** token_version — reserved for hard revocation. */
  tv?: number;
  iat?: number;
  exp?: number;
}

/** Body of POST /fineguide/profile (onboarding step 1). */
export interface ProfilePayload {
  name?: string;
  accountType: AccountType;
  orgName?: string;
}

/** Body of POST /fineguide/plan (onboarding step 2 / Settings → Manage plan). */
export interface PlanPayload {
  plan: PlanId;
  interval: BillingInterval;
}
