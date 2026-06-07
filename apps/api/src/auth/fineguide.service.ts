import { HttpException, Injectable } from '@nestjs/common';
import type { AuthResult, ProfilePayload, PlanPayload } from '@fineguide-tesseract/shared';
import { AuthService } from './auth.service';

/**
 * The seam between Tesseract and the fineguide.ai parent platform.
 *
 *  - FINEGUIDE_ORIGIN unset (or empty) → apps/api itself is the reference/mock
 *    implementation of the contract: profile/plan writes hit the local AuthService
 *    + Postgres, and the hosted-login `start` uses the local Google flow.
 *  - FINEGUIDE_ORIGIN set (e.g. https://fineguide.ai) → apps/api forwards profile/plan
 *    writes to the real platform and redirects the hosted-login `start` there.
 *
 * The renderer/desktop never know which — they always call the Tesseract backend.
 * The shared CCB_JWT_SECRET means fineguide-minted tokens verify here unchanged.
 */
@Injectable()
export class FineguideService {
  private readonly origin = (process.env.FINEGUIDE_ORIGIN ?? '').replace(/\/$/, '');

  constructor(private readonly auth: AuthService) {}

  /** True when delegating to a real external platform (vs. acting as the dev mock). */
  get federated(): boolean {
    return this.origin.length > 0;
  }

  /** Base to which the hosted-login `start` should redirect, or null to use the local flow. */
  get startRedirectBase(): string | null {
    return this.federated ? this.origin : null;
  }

  async updateProfile(userId: string, token: string, body: ProfilePayload): Promise<AuthResult> {
    if (!this.federated) return this.auth.updateProfile(userId, body);
    return this.forward('/fineguide/profile', token, body);
  }

  async setPlan(userId: string, token: string, body: PlanPayload): Promise<AuthResult> {
    if (!this.federated) return this.auth.setPlan(userId, body);
    return this.forward('/fineguide/plan', token, body);
  }

  private async forward(path: string, token: string, body: unknown): Promise<AuthResult> {
    const r = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))) as { message?: string };
      // Propagate the upstream status verbatim so the client can react to it
      // (a 4xx surfaces as an inline error; a genuine 401/403 is caught by the
      // next me() call, which is the single place that clears the session).
      throw new HttpException(detail?.message ?? `fineguide.ai request failed (${r.status})`, r.status);
    }
    return (await r.json()) as AuthResult;
  }
}
