/**
 * Persisted workspace snapshots — the open-tabs + split-layout for each project,
 * keyed by project root, so a project's layout is restored when it's reopened
 * (after an app restart or from the Home screen), not just across a Cmd+R reload.
 *
 * An in-memory map is the live source of truth (updated synchronously when the
 * renderer pushes a snapshot, so a reload reads the freshest copy even before
 * the debounced disk write lands). It's mirrored to `userData/workspaces.json`
 * and LRU-capped so it can't grow without bound. The snapshot is opaque here —
 * only the renderer knows its shape; we just key on its `root` field.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Most-recent N projects to remember layouts for. */
const MAX_PROJECTS = 30;

let cache: Map<string, unknown> | null = null;
let writeTimer: NodeJS.Timeout | null = null;

function storeFile(): string {
  return join(app.getPath('userData'), 'workspaces.json');
}

function load(): Map<string, unknown> {
  if (cache) return cache;
  cache = new Map();
  try {
    if (existsSync(storeFile())) {
      const obj = JSON.parse(readFileSync(storeFile(), 'utf-8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    }
  } catch {
    /* corrupt/missing → start empty */
  }
  return cache;
}

function flushWrite(): void {
  writeTimer = null;
  try {
    const dir = dirname(storeFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(Object.fromEntries(load())));
  } catch {
    /* best-effort */
  }
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrite, 800);
}

/** The saved snapshot for a project root (or null). */
export function getWorkspaceSnapshot(root: string): unknown {
  return load().get(root) ?? null;
}

/** Store the snapshot under its own `root`, as most-recently-used; LRU-prune. */
export function saveWorkspaceSnapshot(snapshot: unknown): void {
  const root = (snapshot as { root?: unknown } | null)?.root;
  if (typeof root !== 'string' || !root) return;
  const c = load();
  c.delete(root);          // re-insert at the end → most-recently-used
  c.set(root, snapshot);
  while (c.size > MAX_PROJECTS) {
    const oldest = c.keys().next().value;
    if (oldest === undefined) break;
    c.delete(oldest);
  }
  scheduleWrite();
}

/** Force any pending debounced write to disk now (called on app quit). */
export function flushWorkspaceSnapshots(): void {
  if (writeTimer) { clearTimeout(writeTimer); flushWrite(); }
}
