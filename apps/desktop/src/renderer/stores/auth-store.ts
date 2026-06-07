import { create } from 'zustand';
import type { User, ProfilePayload, PlanPayload } from '@fineguide-tesseract/shared';

interface AuthState {
  /** 'unknown' until init() resolves; then 'anon' or 'authed'. */
  status: 'unknown' | 'anon' | 'authed';
  user: User | null;
  error: string | null;
  loading: boolean;
  /** True while a desktop system-browser Google sign-in is in flight (drives the Cancel control). */
  googlePending: boolean;
  /** True only on a gated web server — drives whether AuthGate blocks the app. */
  requireAuth: boolean;
  init(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, name?: string): Promise<void>;
  loginWithGoogle(): Promise<void>;
  /** Abort an in-flight Google sign-in (Cancel button / external browser abandoned). */
  cancelGoogle(): void;
  /** Onboarding step 1: persist name + account type, refresh the session. */
  updateProfile(payload: ProfilePayload): Promise<void>;
  /** Onboarding step 2 / Manage plan: record the chosen plan, refresh the session. */
  setPlan(payload: PlanPayload): Promise<void>;
  logout(): Promise<void>;
  clearError(): void;
}

let inited = false;

function friendly(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (!m || m === 'unauthorized') return 'Incorrect email or password.';
  return m;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: null,
  error: null,
  loading: false,
  googlePending: false,
  requireAuth: false,

  init: async () => {
    if (inited) return; // StrictMode-safe
    inited = true;
    // Out-of-band changes: web 401 bounce, desktop OAuth callback, other windows.
    window.ccb.auth.onChange((user) => set({ user, status: user ? 'authed' : 'anon' }));
    const requireAuth = await window.ccb.auth.requireAuth();
    set({ requireAuth });
    // Offline-tolerant: me() returns the cached user on network errors; only an
    // explicit 401/403 yields null (logged out).
    const user = await window.ccb.auth.me();
    set({ user, status: user ? 'authed' : 'anon' });
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const { user } = await window.ccb.auth.login(email, password);
      set({ user, status: 'authed', loading: false });
    } catch (e) {
      set({ error: friendly(e), loading: false });
      throw e;
    }
  },

  signup: async (email, password, name) => {
    set({ loading: true, error: null });
    try {
      const { user } = await window.ccb.auth.signup(email, password, name);
      set({ user, status: 'authed', loading: false });
    } catch (e) {
      set({ error: friendly(e), loading: false });
      throw e;
    }
  },

  loginWithGoogle: async () => {
    set({ loading: true, error: null, googlePending: true });
    try {
      // Web: never resolves (the page navigates away). Desktop: resolves when the
      // system-browser flow captures the code, or rejects on Cancel/timeout.
      const { user } = await window.ccb.auth.loginWithGoogle();
      set({ user, status: 'authed', loading: false, googlePending: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cancelled (user clicked Cancel / closed the browser) → just stop, no error banner.
      if (/cancel/i.test(msg)) { set({ loading: false, googlePending: false }); return; }
      set({ error: friendly(e), loading: false, googlePending: false });
      throw e;
    }
  },

  cancelGoogle: () => {
    void window.ccb.auth.cancelGoogleSignIn();
    set({ loading: false, googlePending: false });
  },

  updateProfile: async (payload) => {
    set({ loading: true, error: null });
    try {
      const { user } = await window.ccb.auth.updateProfile(payload);
      set({ user, status: 'authed', loading: false });
    } catch (e) {
      set({ error: friendly(e), loading: false });
      throw e;
    }
  },

  setPlan: async (payload) => {
    set({ loading: true, error: null });
    try {
      const { user } = await window.ccb.auth.setPlan(payload);
      set({ user, status: 'authed', loading: false });
    } catch (e) {
      set({ error: friendly(e), loading: false });
      throw e;
    }
  },

  logout: async () => {
    await window.ccb.auth.logout();
    set({ user: null, status: 'anon', error: null });
  },

  clearError: () => set({ error: null }),
}));
