import { Injectable } from '@nestjs/common';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
}

@Injectable()
export class GoogleService {
  private readonly clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  private readonly clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  private readonly publicUrl = (process.env.CCB_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, '');

  /** Must match exactly an Authorized redirect URI in the Google console. */
  get redirectUri(): string {
    return `${this.publicUrl}/auth/google/callback`;
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  buildAuthUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTH}?${p.toString()}`;
  }

  async exchangeCode(code: string): Promise<GoogleProfile> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });
    const tr = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!tr.ok) throw new Error(`google token exchange failed: ${tr.status}`);
    const { access_token } = (await tr.json()) as { access_token: string };
    const ur = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!ur.ok) throw new Error(`google userinfo failed: ${ur.status}`);
    return (await ur.json()) as GoogleProfile;
  }

  /** Only http loopback targets may receive a freshly minted token (native-app flow). */
  isValidLoopback(target: string): boolean {
    try {
      const u = new URL(target);
      if (u.protocol !== 'http:') return false;
      return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
    } catch {
      return false;
    }
  }
}
