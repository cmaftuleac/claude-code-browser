/**
 * Per-origin project-folder resolution.
 *
 * A browser origin (host:port) maps to one project folder, which becomes the
 * session's cwd. Claude Code stores sessions at
 *   ~/.claude/projects/<nM(cwd)>/<sessionId>.jsonl
 * where the SDK's bucket encoder is nM(p) = p.replace(/[^a-zA-Z0-9]/g, '-').
 *
 * Write/read match holds iff we pass the *byte-identical normalized absolute path*
 * to both query({ cwd }) and listSessions({ dir }). So always route paths through
 * normalizeDir() before handing them to the SDK, and never re-implement nM here —
 * let the SDK encode (so write and read use the same encoder).
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Filesystem-safe folder name for a default project dir derived from an origin.
 *  Only used to *name* the default directory on disk (e.g. localhost:3000 ->
 *  localhost-3000); the SDK re-encodes the full absolute path for its bucket. */
export function slugOrigin(origin: string): string {
  return origin.replace(/[^A-Za-z0-9.-]/g, '-');
}

/** Normalize a path to a canonical absolute form: resolve `.`/`..`/relative, and
 *  strip a trailing slash. This is the single correctness guard that keeps the
 *  write cwd and the list dir encoding to the same bucket. */
export function normalizeDir(p: string): string {
  const r = resolve(p);
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

/** Resolve the project folder (cwd / list scope) for an origin.
 *  - configuredDir (the site's sources[0]) wins, normalized.
 *  - else a stable per-origin default under the home dir.
 *  - else undefined when the origin is unknown (caller decides the fallback). */
export function resolveProjectDir(origin?: string, configuredDir?: string): string | undefined {
  if (configuredDir) return normalizeDir(configuredDir);
  if (origin) return normalizeDir(join(homedir(), 'claude-code-browser', slugOrigin(origin)));
  return undefined;
}
