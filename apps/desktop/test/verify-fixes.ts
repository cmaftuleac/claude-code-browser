/**
 * Unit checks for the pure-logic security/correctness fixes from the review.
 * Run: node_modules/.bin/tsx apps/desktop/test/verify-fixes.ts
 * No test framework in the repo — this is a self-contained tsx runner.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isInsideRoot } from '../src/main/path-guard.js';
import { isSafeExternalUrl } from '../src/main/url-safety.js';
import { resolveRange } from '../src/main/media-range.js';
import { joinPath, parentDir } from '../src/renderer/lib/path-util.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m', name); }
  else { fail++; console.error('  \x1b[31m✗ FAIL\x1b[0m', name); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(`${name} → ${JSON.stringify(actual)}`, JSON.stringify(actual) === JSON.stringify(expected));
}

// ── S3: symlink-safe path containment guard ────────────────────────────────
console.log('\nS3 — isInsideRoot (symlink-safe path guard)');
{
  const root = mkdtempSync(join(tmpdir(), 'ccb-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ccb-outside-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'file.txt'), 'hi');
  writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
  // A symlinked DIRECTORY inside the project that points outside it.
  symlinkSync(outside, join(root, 'evil'));
  // A symlinked FILE inside the project that points to an outside file.
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leaflink'));

  check('normal file inside root is allowed', isInsideRoot(join(root, 'sub', 'file.txt'), root) === true);
  check('a subdir inside root is allowed', isInsideRoot(join(root, 'sub'), root) === true);
  check('the root itself is allowed', isInsideRoot(root, root) === true);
  check('a not-yet-created file inside root is allowed', isInsideRoot(join(root, 'sub', 'new.txt'), root) === true);
  check('../ traversal is blocked', isInsideRoot(join(root, '..', 'etc', 'passwd'), root) === false);
  check('absolute path outside root is blocked', isInsideRoot('/etc/passwd', root) === false);
  check('symlinked-DIR escape (root/evil/secret.txt) is blocked', isInsideRoot(join(root, 'evil', 'secret.txt'), root) === false);
  check('a symlink FILE itself is allowed (deleting the link is safe)', isInsideRoot(join(root, 'leaflink'), root) === true);
  check('no root → never inside', isInsideRoot(join(root, 'sub', 'file.txt'), undefined) === false);

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// ── S2: external-open URL allow-list ───────────────────────────────────────
console.log('\nS2 — isSafeExternalUrl (openExternal scheme allow-list)');
{
  for (const u of ['http://example.com', 'https://example.com/x?y=1', 'mailto:a@b.com']) {
    check(`allows ${u}`, isSafeExternalUrl(u) === true);
  }
  for (const u of [
    'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'data:text/html,x',
    'chrome://settings', 'smb://server/share', 'vscode://x', 'ftp://h/f', '', 'not a url',
  ]) {
    check(`blocks ${u || '(empty)'}`, isSafeExternalUrl(u) === false);
  }
}

// ── T6: media-file:// Range resolution (clamp / 0-byte / inverted) ──────────
console.log('\nT6 — resolveRange (media Range clamp)');
{
  eq('no header → full', resolveRange(null, 100), { kind: 'full' });
  eq('bytes=0-49 → partial', resolveRange('bytes=0-49', 100), { kind: 'partial', start: 0, end: 49 });
  eq('open-ended bytes=0- → to EOF', resolveRange('bytes=0-', 100), { kind: 'partial', start: 0, end: 99 });
  eq('bytes=50- → to EOF', resolveRange('bytes=50-', 100), { kind: 'partial', start: 50, end: 99 });
  eq('over-range end clamped', resolveRange('bytes=90-200', 100), { kind: 'partial', start: 90, end: 99 });
  eq('start past EOF → unsatisfiable', resolveRange('bytes=200-300', 100), { kind: 'unsatisfiable' });
  eq('range on 0-byte file → full', resolveRange('bytes=0-10', 0), { kind: 'full' });
  eq('garbage header → full', resolveRange('weird', 100), { kind: 'full' });
}

// ── L8: cross-platform path joins ──────────────────────────────────────────
console.log('\nL8 — joinPath / parentDir (cross-platform separators)');
{
  eq('posix join', joinPath('/a/b', 'c.txt'), '/a/b/c.txt');
  eq('posix join trailing slash', joinPath('/a/b/', 'c.txt'), '/a/b/c.txt');
  eq('windows join', joinPath('C:\\proj', 'c.txt'), 'C:\\proj\\c.txt');
  eq('windows join trailing sep', joinPath('C:\\proj\\', 'c.txt'), 'C:\\proj\\c.txt');
  eq('empty dir → name only', joinPath('', 'c.txt'), 'c.txt');
  eq('parentDir posix', parentDir('/a/b/c'), '/a/b');
  eq('parentDir windows', parentDir('C:\\a\\b'), 'C:\\a');
  eq('parentDir bare', parentDir('file'), '');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
