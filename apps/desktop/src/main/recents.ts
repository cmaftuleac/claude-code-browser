/**
 * Persisted recent-projects list — backed by a JSON file in
 * `app.getPath('userData')`. Capped at 24, deduped by path, most-recent first.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

const CAP = 24;

function file(): string {
  return join(app.getPath('userData'), 'recents.json');
}

function read(): RecentProject[] {
  try {
    const raw = readFileSync(file(), 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x.path === 'string' && typeof x.name === 'string' && typeof x.lastOpenedAt === 'number');
  } catch {
    return [];
  }
}

function write(items: RecentProject[]): void {
  try {
    const dir = dirname(file());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file(), JSON.stringify(items, null, 2), 'utf-8');
  } catch {
    /* swallow — recents are best-effort */
  }
}

export function listRecents(): RecentProject[] {
  return read().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, CAP);
}

export function addRecent(path: string, name: string): RecentProject[] {
  const existing = read().filter((x) => x.path !== path);
  const next = [{ path, name, lastOpenedAt: Date.now() }, ...existing].slice(0, CAP);
  write(next);
  return next;
}

export function removeRecent(path: string): RecentProject[] {
  const next = read().filter((x) => x.path !== path);
  write(next);
  return next;
}
