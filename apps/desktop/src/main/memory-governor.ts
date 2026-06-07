/**
 * Memory governor — the OS-pressure sensor for the desktop app.
 *
 * Electron exposes no JS "memory-pressure" event, so we synthesize a level
 * (normal | moderate | critical) from three inputs and hand escalations to an
 * actuator (wired in index.ts, which owns the backend / windows / sessions):
 *   1. App RSS  — Σ app.getAppMetrics().memory.workingSetSize, vs a budget.
 *   2. macOS kernel — sysctl kern.memorystatus_vm_pressure_level (the OS's own
 *      assessment; the authoritative signal on macOS where free-RAM is unreliable
 *      because the kernel uses most of it for cache).
 *   3. System free memory — os.freemem()/os.totalmem() (primary on non-macOS).
 * OOM crash events are wired separately in index.ts and force a critical reclaim.
 */
import { app } from 'electron';
import os from 'node:os';
import { execFile } from 'node:child_process';

/** Renderer-process pool cap (consolidation switch in index.ts). */
export const RENDERER_PROCESS_LIMIT = 4;

export type PressureLevel = 'normal' | 'moderate' | 'critical';

// ── Tunables ──────────────────────────────────────────────────────────────────
const POLL_NORMAL_MS = 20_000;     // relaxed cadence when healthy
const POLL_ELEVATED_MS = 5_000;    // faster while moderate/critical (cache stays warm)
const MODERATE_RSS_MB = 2_000;     // app working set that trips moderate
const CRITICAL_RSS_MB = 3_200;     // …and critical
const FREE_MODERATE = 0.12;        // free-RAM fraction (non-macOS) that trips moderate
const FREE_CRITICAL = 0.05;        // …and critical

const isMac = process.platform === 'darwin';
const RANK: Record<PressureLevel, number> = { normal: 0, moderate: 1, critical: 2 };
const worst = (a: PressureLevel, b: PressureLevel): PressureLevel => (RANK[a] >= RANK[b] ? a : b);

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 1_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Σ working set of every app process, in MB. */
function appRssMb(): number {
  try {
    const kb = app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
    return kb / 1024;
  } catch {
    return 0;
  }
}

function rssLevel(): PressureLevel {
  const mb = appRssMb();
  if (mb > CRITICAL_RSS_MB) return 'critical';
  if (mb > MODERATE_RSS_MB) return 'moderate';
  return 'normal';
}

/** Free-RAM heuristic — skipped on macOS (free-RAM there is misleadingly low). */
function freeLevel(): PressureLevel {
  if (isMac) return 'normal';
  const frac = os.freemem() / os.totalmem();
  if (frac < FREE_CRITICAL) return 'critical';
  if (frac < FREE_MODERATE) return 'moderate';
  return 'normal';
}

/** The macOS kernel's own VM pressure level (1 normal, 2 warn, 4 critical). */
async function kernelLevel(): Promise<PressureLevel> {
  if (!isMac) return 'normal';
  try {
    const v = parseInt((await execFileP('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).trim(), 10);
    if (v >= 4) return 'critical';
    if (v >= 2) return 'moderate';
    return 'normal';
  } catch {
    return 'normal'; // sysctl missing / unreadable → rely on the other signals
  }
}

interface GovernorHooks {
  /** Run reclaim for an escalation (or sustained critical). Implemented in index.ts. */
  onPressure(level: 'moderate' | 'critical'): void;
  /** Pressure returned to normal (optional — e.g. resume relaxed cadence). */
  onNormal?(): void;
}

/**
 * Start polling. Returns a stop() to clear the timer. Calls onPressure on upward
 * transitions, and re-fires on every elevated tick while critical (idempotent
 * reclaim) so sustained pressure keeps shedding newly-created load.
 */
export function startMemoryGovernor(hooks: GovernorHooks): () => void {
  let last: PressureLevel = 'normal';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let level: PressureLevel = worst(rssLevel(), freeLevel());
    level = worst(level, await kernelLevel());
    if (stopped) return;

    if (RANK[level] > RANK[last]) {
      // escalation
      hooks.onPressure(level as 'moderate' | 'critical');
    } else if (level === 'critical') {
      // sustained emergency — keep shedding
      hooks.onPressure('critical');
    } else if (level === 'normal' && last !== 'normal') {
      hooks.onNormal?.();
    }
    last = level;

    timer = setTimeout(() => void tick(), level === 'normal' ? POLL_NORMAL_MS : POLL_ELEVATED_MS);
  };

  timer = setTimeout(() => void tick(), POLL_NORMAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
