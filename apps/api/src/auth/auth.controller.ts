import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { GoogleService } from './google.service';
import { FineguideService } from './fineguide.service';
import { JwtAuthGuard, type JwtClaims } from './jwt-auth.guard';

interface OAuthState {
  mode: 'web' | 'loopback';
  redirect: string;
}

@Controller('auth')
export class AuthController {
  private readonly publicUrl = (process.env.CCB_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');

  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleService,
    private readonly fineguide: FineguideService,
    private readonly jwt: JwtService,
  ) {}

  @Post('signup')
  signup(@Body() body: { email?: string; password?: string; name?: string }) {
    return this.auth.signup(body?.email ?? '', body?.password ?? '', body?.name);
  }

  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.auth.login(body?.email ?? '', body?.password ?? '');
  }

  @Post('logout')
  @HttpCode(204)
  logout(): void {
    // Stateless: the client discards its token. (Bump token_version later for hard revoke.)
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: FastifyRequest & { user: JwtClaims }) {
    return { user: await this.auth.me(req.user.sub) };
  }

  @Get('google/start')
  googleStart(
    @Query('mode') mode: string,
    @Query('redirect') redirect: string,
    @Res() res: FastifyReply,
  ): void {
    const m: OAuthState['mode'] = mode === 'loopback' ? 'loopback' : 'web';
    if (m === 'loopback' && !this.google.isValidLoopback(redirect ?? '')) {
      throw new BadRequestException('Invalid loopback redirect target.');
    }
    // Federated: hand the whole hosted-login dance to fineguide.ai. It runs Google,
    // creates the user+org, mints the shared-secret JWT, and redirects back to the
    // client's target (web fragment / loopback) itself. apps/api just forwards.
    const base = this.fineguide.startRedirectBase;
    if (base) {
      const target = m === 'web' && !redirect ? this.publicUrl : redirect;
      const u = new URL(`${base}/auth/google/start`);
      u.searchParams.set('mode', m);
      u.searchParams.set('redirect', target ?? '');
      void res.redirect(u.toString(), 302);
      return;
    }
    if (!this.google.configured) throw new BadRequestException('Google sign-in is not configured.');
    // State is a short-lived signed JWT → CSRF defence + carries the loopback target statelessly.
    const state = this.jwt.sign(
      { mode: m, redirect: redirect ?? '', n: randomBytes(8).toString('hex') },
      { expiresIn: '10m' },
    );
    void res.redirect(this.google.buildAuthUrl(state), 302);
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') stateRaw: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    let state: OAuthState;
    try {
      state = this.jwt.verify<OAuthState>(stateRaw ?? '');
    } catch {
      throw new BadRequestException('Invalid or expired OAuth state.');
    }
    if (!code) throw new BadRequestException('Missing code.');

    const profile = await this.google.exchangeCode(code);
    const token = await this.auth.upsertGoogleUser(profile);

    if (state.mode === 'loopback') {
      if (!this.google.isValidLoopback(state.redirect)) {
        throw new BadRequestException('Invalid loopback redirect.');
      }
      const url = new URL(state.redirect);
      url.searchParams.set('token', token);
      void res.redirect(url.toString(), 302);
    } else {
      // Hand the SPA the token via URL fragment (never sent to servers/proxies/logs).
      void res.redirect(`${this.publicUrl}/#token=${encodeURIComponent(token)}`, 302);
    }
  }
}
