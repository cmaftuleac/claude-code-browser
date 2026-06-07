import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type {
  User as PublicUser,
  AuthResult,
  ProfilePayload,
  PlanPayload,
  AccountType,
  PlanId,
  BillingInterval,
} from '@fineguide-tesseract/shared';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './passwords';
import type { JwtClaims } from './jwt-auth.guard';
import type { GoogleProfile } from './google.service';

const PLAN_IDS: PlanId[] = ['free', 'standard', 'pro'];

interface DbUser {
  id: string;
  email: string;
  name: string | null;
  passwordHash?: string | null;
  tokenVersion: number;
  accountType: string;
  orgId: string | null;
  orgName: string | null;
  plan: string;
  planInterval: string;
  onboardingComplete: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private toPublic(u: DbUser): PublicUser {
    return {
      id: u.id,
      email: u.email,
      name: u.name ?? undefined,
      accountType: u.accountType as AccountType,
      orgId: u.orgId ?? undefined,
      orgName: u.orgName ?? undefined,
      plan: u.plan as PlanId,
      interval: u.planInterval as BillingInterval,
      onboardingComplete: u.onboardingComplete,
    };
  }

  private issue(u: DbUser): string {
    const claims: JwtClaims = {
      sub: u.id,
      email: u.email,
      tv: u.tokenVersion,
      name: u.name ?? undefined,
      accountType: u.accountType as JwtClaims['accountType'],
      orgId: u.orgId ?? undefined,
      orgName: u.orgName ?? undefined,
      plan: u.plan as JwtClaims['plan'],
      interval: u.planInterval as JwtClaims['interval'],
      onboardingComplete: u.onboardingComplete,
    };
    return this.jwt.sign(claims);
  }

  async signup(email: string, password: string, name?: string): Promise<AuthResult> {
    if (!email.includes('@') || password.length < 8) {
      throw new BadRequestException('Email and a password of at least 8 characters are required.');
    }
    const norm = email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email: norm } })) {
      throw new ConflictException('An account with that email already exists.');
    }
    const user = await this.prisma.user.create({
      data: { email: norm, passwordHash: hashPassword(password), name: name ?? null },
    });
    return { token: this.issue(user), user: this.toPublic(user) };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new BadRequestException('Bad request');
    }
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Always run verify (even when the user is absent) to keep timing uniform.
    const ok = verifyPassword(password, user?.passwordHash);
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password.');
    return { token: this.issue(user), user: this.toPublic(user) };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.toPublic(user);
  }

  /** Link existing google account → match by email → create. Returns a fresh JWT. */
  async upsertGoogleUser(p: GoogleProfile): Promise<string> {
    const norm = p.email.toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      const linked = await tx.oAuthAccount.findUnique({
        where: { provider_providerUserId: { provider: 'google', providerUserId: p.sub } },
        include: { user: true },
      });
      if (linked) return this.issue(linked.user);

      let user = await tx.user.findUnique({ where: { email: norm } });
      if (!user) {
        user = await tx.user.create({ data: { email: norm, name: p.name ?? null } });
      }
      await tx.oAuthAccount.create({
        data: { provider: 'google', providerUserId: p.sub, userId: user.id },
      });
      return this.issue(user);
    });
  }

  /** Onboarding step 1: persist name + account type (+ org name). Returns a fresh token. */
  async updateProfile(userId: string, body: ProfilePayload): Promise<AuthResult> {
    const accountType: AccountType = body?.accountType === 'organization' ? 'organization' : 'individual';
    const orgName = accountType === 'organization' ? (body.orgName ?? '').trim() : null;
    if (accountType === 'organization' && !orgName) {
      throw new BadRequestException('Organization name is required.');
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: body?.name?.trim() || null,
        accountType,
        orgName,
        // A lightweight stand-in for the org the parent platform would create.
        orgId: accountType === 'organization' ? userId : null,
      },
    });
    return { token: this.issue(user), user: this.toPublic(user) };
  }

  /** Onboarding step 2 / "Manage plan": record the chosen plan (no charge yet) and
   *  mark onboarding complete (the terminal step). Returns a fresh token. */
  async setPlan(userId: string, body: PlanPayload): Promise<AuthResult> {
    const plan: PlanId = PLAN_IDS.includes(body?.plan) ? body.plan : 'free';
    const interval: BillingInterval = body?.interval === 'annual' ? 'annual' : 'monthly';
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { plan, planInterval: plan === 'free' ? 'monthly' : interval, onboardingComplete: true },
    });
    return { token: this.issue(user), user: this.toPublic(user) };
  }
}
