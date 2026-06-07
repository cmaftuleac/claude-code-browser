/**
 * Per-user workspace path resolution (Mode A multi-tenancy). Pure (no fs side
 * effects) so it's unit-testable; the caller does the mkdir.
 */
import { join } from 'node:path';

/** Make a user id safe to use as a single path segment — strips anything that
 *  isn't [A-Za-z0-9_-] (so '.', '/', '\\' can't escape the root) and caps length. */
export function sanitizeUserId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** The workspace root for a user: a per-user subtree under `root` when auth is
 *  on, else the shared `root` (local dev / single-tenant). */
export function resolveUserRoot(root: string, userId: string | null, requireAuth: boolean): string {
  if (!requireAuth || !userId) return root;
  return join(root, sanitizeUserId(userId));
}

/** Namespace a client-supplied browserId by user identity so each tenant gets
 *  its OWN isolated BrowserContext (incognito-like) on the shared headless
 *  Chromium — even when two users send the same id (notably 'default'). Returns
 *  the raw id unchanged when there's no user (single-tenant / local dev). The
 *  same scoped key is used on BOTH the agent and human paths so a user's own
 *  agent + mirror still share one page. (Closes review finding B3.) */
export function scopeBrowserId(userId: string | null, browserId: string): string {
  return userId ? `${sanitizeUserId(userId)}::${browserId}` : browserId;
}
