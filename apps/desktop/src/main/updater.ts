/**
 * Silent background auto-update for the packaged desktop app.
 *
 * Uses electron-updater against the public GitHub releases repo
 * (opentech-dev/tesseract-release — see electron-builder.yml `publish`). The
 * design is deliberately non-intrusive: the download runs in the background and
 * the update is applied on the next quit (autoInstallOnAppQuit). The renderer
 * surfaces only a subtle "Update ready · Relaunch" pill on `update-downloaded`,
 * letting eager users apply it immediately via `updater:installNow`.
 *
 * No-op in dev: electron-updater needs a real packaged, code-signed bundle to
 * verify and apply updates (macOS Squirrel checks the signature), so checks are
 * skipped when !app.isPackaged. The IPC handlers are still registered so the
 * renderer's `window.ccb.updater.*` calls resolve cleanly in dev.
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdaterEvent } from '@fineguide-tesseract/shared';

// electron-updater is CommonJS; under the bundler's ESM interop the named
// export isn't reliably hoisted, so destructure off the default. (Documented
// electron-updater + ESM workaround.)
const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 30_000; // let the app settle before the first check
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // re-check every 3h while running

/** The latest event, replayed to renderers that mount after it fired. */
let lastEvent: UpdaterEvent | null = null;

function broadcast(event: UpdaterEvent): void {
  lastEvent = event;
  // Only app windows — guest <webview>s don't listen on this channel.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('updater:event', event);
  }
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Network/feed errors are expected (offline, GitHub hiccup) — surface as a
    // soft error event; the renderer keeps quiet and we retry on the interval.
    broadcast({ kind: 'error', message: (err as Error)?.message ?? String(err) });
  }
}

export function startUpdater(): void {
  // Always available to the renderer, even in dev (no-op there).
  ipcMain.handle('updater:state', () => lastEvent);
  ipcMain.handle('updater:check', () => { if (app.isPackaged) void check(); });
  ipcMain.handle('updater:installNow', () => {
    if (!app.isPackaged) return;
    // isSilent=false → show the OS installer UI on Windows; isForceRunAfter=true
    // → relaunch the app after the update is applied on every platform. quit
    // fires before-quit, so workspace/open-roots flushes still run.
    autoUpdater.quitAndInstall(false, true);
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true; // pull the update in the background…
  autoUpdater.autoInstallOnAppQuit = true; // …and apply it when the user quits.

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) => broadcast({ kind: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => broadcast({ kind: 'none' }));
  autoUpdater.on('download-progress', (p) => broadcast({ kind: 'progress', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => broadcast({ kind: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => broadcast({ kind: 'error', message: err?.message ?? String(err) }));

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}
