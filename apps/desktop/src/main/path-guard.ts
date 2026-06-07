/**
 * Symlink-safe project-root containment guard (pure; no Electron deps so it's
 * unit-testable). Lexical `path.resolve()` never dereferences symlinks, so a
 * symlinked *directory* inside the project (`<root>/link -> /etc`) could smuggle
 * a write/delete outside the root. We realpath the ANCESTOR chain but keep the
 * final component as-is, so a symlink *file* is still judged by its own location
 * (deleting/renaming the link itself is safe).
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Canonicalize for the containment check: realpath the deepest existing
 *  ancestor (resolving symlinks) and re-append the not-yet-existing tail + leaf. */
export function canonicalForGuard(p: string): string {
  const abs = resolve(p);
  let dir = dirname(abs);
  const leaf = basename(abs);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(dir), ...tail, leaf);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs; // nothing in the chain exists yet
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

/** True if `p` resolves inside `root` (symlink-safe). Returns false when no root. */
export function isInsideRoot(p: string, root: string | undefined): boolean {
  if (!root) return false;
  let realRoot: string;
  try { realRoot = realpathSync.native(root); } catch { realRoot = resolve(root); }
  const rel = relative(realRoot, canonicalForGuard(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
