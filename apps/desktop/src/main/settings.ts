/**
 * User settings persistence for the desktop app.
 *
 * Modeled on auth.ts (userData + read/write JSON + broadcast to all windows),
 * but PLAIN JSON — settings aren't secrets, so no safeStorage. The single
 * source of truth lives here in the main process; the renderer hydrates from
 * `settings:load`, writes via `settings:save`, and stays in sync across windows
 * through the `settings:onChange` broadcast.
 */
import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Settings,
  type SettingsPatch,
  DEFAULT_SETTINGS,
  mergeSettings,
} from '@fineguide-tesseract/shared';

function storeFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** In-memory cache so synchronous getters (getAgentSettings) never touch disk. */
let cache: Settings | null = null;

function readDisk(): Settings {
  try {
    if (!existsSync(storeFile())) return DEFAULT_SETTINGS;
    const json = readFileSync(storeFile(), 'utf-8');
    return mergeSettings(JSON.parse(json) as Partial<Settings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeDisk(value: Settings): void {
  try {
    const dir = dirname(storeFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(value, null, 2));
  } catch {
    /* best-effort — a failed write just means it won't persist this session */
  }
}

/** The current settings (cached; loads from disk on first access). */
export function getSettings(): Settings {
  if (!cache) cache = readDisk();
  return cache;
}

/** Tell every live window the settings changed so other windows stay in sync. */
function broadcast(value: Settings): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:onChange', value);
  }
}

/** Merge a partial patch over the current settings, persist, and broadcast. */
export function saveSettings(patch: SettingsPatch): Settings {
  const cur = getSettings();
  const next: Settings = {
    version: 1,
    appearance: { ...cur.appearance, ...patch.appearance },
    editor: { ...cur.editor, ...patch.editor },
    agent: {
      ...cur.agent,
      ...patch.agent,
      // mcpServers is replaced wholesale when present (add/remove are full sets).
      mcpServers: patch.agent?.mcpServers ?? cur.agent.mcpServers,
    },
    general: { ...cur.general, ...patch.general },
  };
  cache = next;
  writeDisk(next);
  broadcast(next);
  return next;
}

/** The agent-relevant subset, read by main when building a `chat:send`. Only
 *  non-empty values are returned so the SDK falls back to its defaults. */
export function getAgentSettings(): {
  model?: string;
  permissionMode?: Settings['agent']['permissionMode'];
  effort?: Exclude<Settings['agent']['effort'], ''>;
  mcpServers?: Settings['agent']['mcpServers'];
  maxTurns?: number;
  maxBudgetUsd?: number;
} {
  const a = getSettings().agent;
  return {
    ...(a.model ? { model: a.model } : {}),
    ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.mcpServers && Object.keys(a.mcpServers).length > 0 ? { mcpServers: a.mcpServers } : {}),
    ...(a.maxTurns && a.maxTurns > 0 ? { maxTurns: a.maxTurns } : {}),
    ...(a.maxBudgetUsd && a.maxBudgetUsd > 0 ? { maxBudgetUsd: a.maxBudgetUsd } : {}),
  };
}
