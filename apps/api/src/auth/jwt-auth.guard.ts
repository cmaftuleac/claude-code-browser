import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

export interface JwtClaims {
  sub: string;
  email: string;
  tv: number;
  // Rich profile/subscription claims (a superset of the legacy {sub,email,tv}).
  // Optional so legacy tokens and the verify-only gateway still parse fine.
  name?: string;
  accountType?: 'individual' | 'organization';
  orgId?: string;
  orgName?: string;
  plan?: 'free' | 'standard' | 'pro';
  interval?: 'monthly' | 'annual';
  onboardingComplete?: boolean;
}

/** Requires a valid Bearer JWT; attaches the decoded claims to req.user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtClaims }>();
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && /^Bearer\s+/i.test(header)
        ? header.replace(/^Bearer\s+/i, '')
        : null;
    if (!token) throw new UnauthorizedException();
    try {
      req.user = this.jwt.verify<JwtClaims>(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
