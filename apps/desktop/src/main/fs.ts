/**
 * Project filesystem access for the IDE shell: open-folder dialog, lazy
 * directory listing, file read/write (guarded to the project root), and a
 * recursive watcher that notifies the renderer of on-disk changes (so the
 * agent's edits reflect live in open editors).
 */
import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from 'electron';
import { watch, type FSWatcher, openSync, readSync, closeSync, statSync, renameSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, cp, rm, rename as renameAsync } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isInsideRoot as isInsideRootGuard } from './path-guard.js';

/**
 * In-app deletion undo. Deleting moves the item into a per-deletion staging
 * folder (instead of straight to the OS Trash) and pushes it on this stack;
 * `fs:undoDelete` moves the most recent one back. Entries evicted past the cap
 * go to the system Trash (still Finder/Explorer-recoverable). `rename` is tried
 * first and falls back to copy+remove across volumes (EXDEV).
 */
interface TrashedItem { original: string; staged: string; stageDir: string }
/** Per-window undo stacks (keyed by webContents id) so window A's Cmd+Z never
 *  restores window B's deletion into B's project. */
const trashStacks = new Map<number, TrashedItem[]>();
const TRASH_UNDO_CAP = 25;
let trashSeq = 0;
function trashStackFor(wcId: number): TrashedItem[] {
  let s = trashStacks.get(wcId);
  if (!s) { s = []; trashStacks.set(wcId, s); }
  return s;
}
/** App-private staging dir. userData sits on the user's home volume, which is
 *  usually the same volume as their projects — so the delete/undo `rename` stays
 *  on the fast same-volume path far more often than /tmp (esp. Linux tmpfs).
 *  Falls back to tmpdir if called before the app is ready. */
function trashRoot(): string {
  try { return join(app.getPath('userData'), 'ccb-trash'); }
  catch { return join(tmpdir(), 'ccb-trash'); }
}
/** Move a staged item to the system Trash, then remove its (now-empty) staging
 *  folder. Trash first so we don't delete the file out from under trashItem. */
function evictToTrash(item: TrashedItem): void {
  void shell.trashItem(item.staged)
    .catch(() => { /* best effort */ })
    .finally(() => { void rm(item.stageDir, { recursive: true, force: true }).catch(() => {}); });
}

async function moveAcross(src: string, dest: string): Promise<void> {
  try {
    await renameAsync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/**
 * If `<dir>/<name>` already exists, append " 2", " 3", … (before the
 * extension) until we find a free slot — Finder-style collision handling
 * used by copy/move into a folder.
 */
function resolveUniqueName(dir: string, name: string): string {
  const direct = join(dir, name);
  if (!existsSync(direct)) return direct;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = join(dir, `${base} ${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return direct; // give up after 10k attempts; caller will surface the error
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif',
  'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv', '3gp',
  'pdf', 'zip', 'gz', 'tar', 'wasm', 'node', 'so', 'dylib', 'dll', 'exe',
  // Office documents (ZIP-based archives — UTF-8 read would return garbage).
  'doc', 'docx', 'odt', 'rtf',
  'xls', 'xlsx', 'ods',
  'ppt', 'pptx', 'odp',
  // Data / analytics / bytecode / databases — none of these read sanely as UTF-8.
  'parquet', 'arrow', 'feather', 'ipc', 'orc', 'avro', 'msgpack',
  'sqlite', 'sqlite3', 'db', 'db3',
  'bin', 'dat', 'pkl', 'pyc', 'class', 'jar', 'war', 'ear',
  'iso', 'dmg', 'rar', '7z', 'bz2', 'xz', 'lz4', 'zst',
]);

/** Above this size a text-extension file is also opened as binary (Monaco
 *  chokes on multi-MB files, and the IPC string transfer is expensive). */
const TEXT_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

// Multi-window: each window has its own project root + recursive watcher, keyed
// by the window's webContents id. Path guards check membership in ANY open
// window's root — a renderer only ever operates on its own project's paths, so
// the union just prevents escaping every project root (a safety net, not a
// cross-window security boundary).
const roots = new Map<number, string>();
/** One recursive watcher per RESOLVED root path, shared by every window viewing
 *  it (two windows on the same project don't spawn two watchers); fs:changed
 *  fans out to all those windows. */
interface RootWatch { watcher: FSWatcher; wcIds: Set<number> }
const rootWatches = new Map<string, RootWatch>();

/** The requesting window's project root (used to derive the agent cwd / scope
 *  the session list in main). */
export function rootForWindow(wcId: number): string | undefined {
  return roots.get(wcId);
}

// ── Durable open-project session (hot-exit) ─────────────────────────────────
// `roots` lives only in memory, so a kill/quit loses which projects were open.
// Mirror its values to disk (debounced + flushed on quit) so a cold launch can
// reopen them. `previousSessionRoots` snapshots the file BEFORE this run writes
// to it — that captured value is what the renderer restores from.
function sessionFile(): string {
  return join(app.getPath('userData'), 'last-session.json');
}
let previousSessionRoots: string[] | null = null;
/** The set of project roots open at the end of the previous session (cached on
 *  first read so this run's own writes can't clobber it). */
function getPreviousSessionRoots(): string[] {
  if (previousSessionRoots === null) {
    previousSessionRoots = [];
    try {
      const obj = JSON.parse(readFileSync(sessionFile(), 'utf-8')) as { roots?: unknown };
      if (Array.isArray(obj?.roots)) previousSessionRoots = obj.roots.filter((r): r is string => typeof r === 'string');
    } catch { /* none / corrupt → empty */ }
  }
  return previousSessionRoots;
}
let sessionWriteTimer: ReturnType<typeof setTimeout> | null = null;
function writeOpenRoots(): void {
  sessionWriteTimer = null;
  try {
    const dir = dirname(sessionFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sessionFile(), JSON.stringify({ roots: [...new Set(roots.values())] }));
  } catch { /* best-effort */ }
}
/** Persist the currently-open roots (debounced). Call whenever `roots` changes. */
function persistOpenRoots(): void {
  if (sessionWriteTimer) clearTimeout(sessionWriteTimer);
  sessionWriteTimer = setTimeout(writeOpenRoots, 400);
}
/** Force any pending open-roots write to disk now (called on app quit). */
export function flushOpenRootsSession(): void {
  if (sessionWriteTimer) { clearTimeout(sessionWriteTimer); writeOpenRoots(); }
}

/** Previous-session project roots that still exist on disk — main spawns one
 *  window per entry on a cold launch (deleted/moved projects are skipped). */
export function restorableSessionRoots(): string[] {
  return getPreviousSessionRoots().filter((r) => {
    try { return statSync(r).isDirectory(); } catch { return false; }
  });
}

/** Pre-seed a freshly-created window's project root so its renderer's
 *  `fs:currentRoot` resolves to it and `restoreWorkspaceOnStartup` reopens that
 *  project (the renderer's `openFolder` then attaches the watcher for real). */
export function seedWindowRoot(wcId: number, root: string): void {
  roots.set(wcId, resolve(root));
}

/** True if `p` is inside the requesting window's project root. Scoped per window
 *  (by webContents id) so one window can't write/delete inside another's project.
 *  Symlink-safe (see path-guard.isInsideRoot). */
function isInsideRoot(p: string, wcId: number): boolean {
  return isInsideRootGuard(p, roots.get(wcId));
}

/** Subscribe `wcId` to a recursive watcher on `root`, reusing an existing one
 *  for the same resolved path (idempotent — adding an already-subscribed id is a no-op). */
function attachWatch(root: string, wcId: number): void {
  const key = resolve(root);
  const existing = rootWatches.get(key);
  if (existing) { existing.wcIds.add(wcId); return; }
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel.split(sep).some((seg) => IGNORED.has(seg))) return;
      pending.add(join(root, rel));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        const rw = rootWatches.get(key);
        if (!rw) return;
        for (const id of rw.wcIds) {
          const wc = webContents.fromId(id);
          if (wc && !wc.isDestroyed()) wc.send('fs:changed', paths);
        }
      }, 120);
    });
    rootWatches.set(key, { watcher, wcIds: new Set([wcId]) });
  } catch {
    // recursive watch unsupported on some platforms — degrade gracefully.
  }
}

/** Unsubscribe `wcId` from `root`'s watcher, closing it when the last window leaves. */
function detachWatch(root: string, wcId: number): void {
  const rw = rootWatches.get(resolve(root));
  if (!rw) return;
  rw.wcIds.delete(wcId);
  if (rw.wcIds.size === 0) { rw.watcher.close(); rootWatches.delete(resolve(root)); }
}

/** Tear down a window's watcher subscription + root (window close / project close).
 *  Its still-staged deletions move to the system Trash (recoverable) and the undo
 *  stack is dropped. */
export function disposeWindowFs(wcId: number): void {
  const prev = roots.get(wcId);
  if (prev) detachWatch(prev, wcId);
  roots.delete(wcId);
  persistOpenRoots();
  // Note: the per-project workspace snapshot is intentionally NOT cleared here —
  // it's keyed by project root (see workspace-snapshots.ts) so reopening the
  // project later restores its tabs. A renderer reload keeps the window's root
  // (so it auto-restores); an explicit Close Project releases the root above, so
  // a reload after closing correctly returns Home.
  const stack = trashStacks.get(wcId);
  if (stack) { for (const item of stack) evictToTrash(item); trashStacks.delete(wcId); }
}

/** On startup, clear any staging dirs left behind by a previous run (the OS
 *  cleans tmp eventually, but this keeps deleted files from lingering). */
export function sweepStaleTrash(): void {
  void rm(trashRoot(), { recursive: true, force: true }).catch(() => {});
}

export function registerFsHandlers(): void {
  sweepStaleTrash();
  ipcMain.handle('fs:openFolder', async (e, explicitPath?: string) => {
    let root: string;
    if (typeof explicitPath === 'string' && explicitPath.length > 0) {
      // Caller already knows the path (recents / new-project flow). Validate it exists.
      const { existsSync, statSync } = await import('node:fs');
      if (!existsSync(explicitPath) || !statSync(explicitPath).isDirectory()) {
        return null;
      }
      root = resolve(explicitPath);
    } else {
      const win = BrowserWindow.fromWebContents(e.sender);
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      root = result.filePaths[0];
    }
    // Per-window root + watcher (keyed by the requesting window's webContents).
    const prev = roots.get(e.sender.id);
    if (prev && resolve(prev) !== resolve(root)) detachWatch(prev, e.sender.id);
    roots.set(e.sender.id, root);
    attachWatch(root, e.sender.id);
    app.addRecentDocument(root);
    persistOpenRoots();
    return { root, name: basename(root) };
  });

  /** The window closed its project (went Home) — drop its root + watcher so the
   *  watcher doesn't keep firing and its old root no longer authorizes writes. */
  ipcMain.handle('fs:releaseRoot', (e) => { disposeWindowFs(e.sender.id); });

  /** This window's currently-open project root (or null). The root lives in the
   *  main process keyed by webContents id, so it SURVIVES a renderer reload
   *  (Cmd+R) — letting the renderer restore the project instead of dropping to
   *  Home. It's also pre-seeded by `seedWindowRoot` on a cold launch so a
   *  restored window reopens its project. `closeProject` releases it, so an
   *  explicit close won't re-open. */
  ipcMain.handle('fs:currentRoot', (e) => {
    const root = roots.get(e.sender.id);
    return root ? { root, name: basename(root) } : null;
  });

  /** Open a native folder picker and return the chosen path WITHOUT any side
   *  effects (no current-root mutation, no watcher start, no recents bump).
   *  Used by NewProjectView's "Choose…" parent-dir picker. */
  ipcMain.handle('fs:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** Native "Save As" dialog (used to give an untitled scratch buffer a real
   *  path). Returns the chosen absolute path, or null if cancelled. */
  ipcMain.handle('fs:saveDialog', async (e, defaultPath?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      defaultPath: defaultPath || undefined,
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<DirEntry[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.name !== '.DS_Store')
        .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:readFile', async (_e, p: string): Promise<{ content?: string; error?: string }> => {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    if (BINARY_EXT.has(ext)) return { error: 'Binary file — not shown in the editor.' };
    try {
      // Don't pull multi-MB strings over IPC into Monaco — it hangs.
      const s = statSync(p);
      if (s.size > TEXT_SIZE_LIMIT) return { error: 'File too large for text view.' };
      return { content: await readFile(p, 'utf-8') };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  });

  /**
   * Pre-flight stat — tells the renderer how to open the file (text vs binary
   * vs too-large-for-hex). Used by tasks-store.openFile to pick a path.
   */
  ipcMain.handle('fs:statFile', async (_e, p: string): Promise<{
    size?: number;
    isBinary?: boolean;
    mtimeMs?: number;
    error?: string;
  }> => {
    try {
      const s = statSync(p);
      if (!s.isFile()) return { error: 'Not a file' };
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      const isBinary = BINARY_EXT.has(ext) || s.size > TEXT_SIZE_LIMIT;
      return { size: s.size, isBinary, mtimeMs: s.mtimeMs };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  });

  /**
   * Read a whole binary file as base64 — used by the data-grid view when it
   * needs to hand the entire file off to a parser (parquet, etc.). Capped at
   * 256 MB to keep memory sane; bigger files have to use streaming.
   */
  ipcMain.handle('fs:readBinary', async (_e, p: string): Promise<{
    base64?: string;
    size?: number;
    error?: string;
  }> => {
    const CAP = 256 * 1024 * 1024;
    try {
      const s = statSync(p);
      if (s.size > CAP) return { error: `File is too large to load whole (${(s.size / 1024 / 1024).toFixed(1)} MB).` };
      const data = await readFile(p);
      return { base64: data.toString('base64'), size: s.size };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  });

  /**
   * Read a byte range as base64 — drives the hex viewer's virtualized scroll.
   * length is capped at 1 MB per request.
   */
  ipcMain.handle('fs:readChunk', async (_e, p: string, offset: number, length: number): Promise<{
    base64?: string;
    bytesRead?: number;
    error?: string;
  }> => {
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const len = Math.min(1024 * 1024, Math.max(0, Math.floor(Number(length) || 0)));
    if (len === 0) return { base64: '', bytesRead: 0 };
    let fd: number | null = null;
    try {
      fd = openSync(p, 'r');
      const buf = Buffer.alloc(len);
      const bytesRead = readSync(fd, buf, 0, len, off);
      return { base64: buf.subarray(0, bytesRead).toString('base64'), bytesRead };
    } catch (err) {
      return { error: String((err as Error).message) };
    } finally {
      if (fd != null) try { closeSync(fd); } catch { /* ignore */ }
    }
  });

  ipcMain.handle('fs:revealInFinder', (_e, p: string): { ok: boolean; error?: string } => {
    try { shell.showItemInFolder(p); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err as Error).message) }; }
  });

  ipcMain.handle('fs:openExternal', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /**
   * "Open with…" — shows the system's app-chooser dialog and opens the file
   * with whatever the user picks. On macOS we use AppleScript's
   * `choose application` (native picker; cancellation = silent no-op).
   * On Windows we invoke the shell's "OpenAs" verb via `rundll32`.
   * On Linux we fall through to xdg-open (no native chooser exists).
   */
  ipcMain.handle('fs:openWith', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    const plat = osPlatform();
    if (plat === 'darwin') {
      const script = `
        on run argv
          set theFile to POSIX file (item 1 of argv) as alias
          try
            set theApp to choose application as alias
          on error number -128
            return "cancelled"
          end try
          tell application "Finder" to open theFile using theApp
          return "ok"
        end run
      `;
      return new Promise((resolveP) => {
        execFile('osascript', ['-e', script, p], (err, stdout) => {
          if (err) { resolveP({ ok: false, error: err.message }); return; }
          if (String(stdout).trim() === 'cancelled') { resolveP({ ok: true }); return; }
          resolveP({ ok: true });
        });
      });
    }
    if (plat === 'win32') {
      return new Promise((resolveP) => {
        execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], (err) => {
          if (err) { resolveP({ ok: false, error: err.message }); return; }
          resolveP({ ok: true });
        });
      });
    }
    // Linux fallback — no native chooser, defer to default handler.
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /**
   * Rename a file in place (changes only the basename; parent dir stays).
   * Guarded to project root and to safe filenames (no slashes, no traversal).
   */
  ipcMain.handle('fs:renameFile', async (e, oldPath: string, newName: string): Promise<{
    ok: boolean; newPath?: string; error?: string;
  }> => {
    if (typeof oldPath !== 'string' || typeof newName !== 'string') return { ok: false, error: 'Bad request' };
    const trimmed = newName.trim();
    if (!trimmed) return { ok: false, error: 'Name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid name.' };
    }
    if (!isInsideRoot(oldPath, e.sender.id)) return { ok: false, error: 'Refusing to rename outside the project root.' };
    const newPath = join(dirname(oldPath), trimmed);
    if (existsSync(newPath)) return { ok: false, error: `A file named "${trimmed}" already exists.` };
    try {
      renameSync(oldPath, newPath);
      return { ok: true, newPath };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('fs:writeFile', async (e, p: string, content: string): Promise<{ ok: boolean; error?: string }> => {
    if (!isInsideRoot(p, e.sender.id)) return { ok: false, error: 'Refusing to write outside the project root.' };
    try {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf-8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /**
   * Create an empty file inside the project tree. Used by the file-tree
   * context menu ("New File"). Refuses to overwrite an existing file.
   */
  ipcMain.handle('fs:createFile', async (
    e,
    parent: string,
    name: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'File name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid file name.' };
    }
    if (!isInsideRoot(parent, e.sender.id)) return { ok: false, error: 'Refusing to create outside the project root.' };
    const target = join(parent, trimmed);
    if (existsSync(target)) return { ok: false, error: `"${trimmed}" already exists.` };
    try {
      await writeFile(target, '', 'utf-8');
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /** Create an empty directory inside the project tree. */
  ipcMain.handle('fs:createFolder', async (
    e,
    parent: string,
    name: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'Folder name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid folder name.' };
    }
    if (!isInsideRoot(parent, e.sender.id)) return { ok: false, error: 'Refusing to create outside the project root.' };
    const target = join(parent, trimmed);
    if (existsSync(target)) return { ok: false, error: `"${trimmed}" already exists.` };
    try {
      await mkdir(target);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /**
   * Copy a set of paths into `destDir`. On name collision the basename is
   * suffixed with " 2", " 3", … (Finder-style). Returns the list of resolved
   * destination paths in the same order as the input. Sources may be outside
   * the project root (e.g. files dragged from Finder); the destination MUST
   * be inside the project root.
   */
  ipcMain.handle('fs:copyPaths', async (
    e,
    srcPaths: string[],
    destDir: string,
  ): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> => {
    if (!Array.isArray(srcPaths) || typeof destDir !== 'string') return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(destDir, e.sender.id)) return { ok: false, error: 'Refusing to copy outside the project root.' };
    try {
      const newPaths: string[] = [];
      for (const src of srcPaths) {
        if (typeof src !== 'string' || !src) continue;
        const target = resolveUniqueName(destDir, basename(src));
        // `cp` handles directories with recursive: true; for files it's a fast copy.
        await cp(src, target, { recursive: true, errorOnExist: false, force: false });
        newPaths.push(target);
      }
      return { ok: true, newPaths };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /**
   * Move (rename) a set of paths into `destDir`. Both sides MUST be inside
   * the project root. Falls back to copy+delete only if the rename fails
   * across devices (EXDEV) — we keep this strict to one filesystem for now.
   */
  ipcMain.handle('fs:movePaths', async (
    e,
    srcPaths: string[],
    destDir: string,
  ): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> => {
    if (!Array.isArray(srcPaths) || typeof destDir !== 'string') return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(destDir, e.sender.id)) return { ok: false, error: 'Refusing to move outside the project root.' };
    try {
      const newPaths: string[] = [];
      for (const src of srcPaths) {
        if (typeof src !== 'string' || !src) continue;
        if (!isInsideRoot(src, e.sender.id)) return { ok: false, error: 'Refusing to move from outside the project root.' };
        // Avoid no-op move (source already in destDir with same name).
        if (dirname(src) === destDir) { newPaths.push(src); continue; }
        const target = resolveUniqueName(destDir, basename(src));
        // moveAcross degrades to copy+delete on EXDEV (a submount/bind mount
        // inside the project tree), matching the delete/undo paths.
        await moveAcross(src, target);
        newPaths.push(target);
      }
      return { ok: true, newPaths };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /**
   * Delete a file or folder. Moves it into a per-deletion staging folder so the
   * deletion is UNDOABLE this session (fs:undoDelete). Entries past the undo cap
   * spill to the system Trash (still Finder/Explorer-recoverable).
   */
  ipcMain.handle('fs:deletePath', async (e, p: string): Promise<{ ok: boolean; error?: string }> => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(p, e.sender.id)) return { ok: false, error: 'Refusing to delete outside the project root.' };
    // Deleting the project root itself would orphan the watcher + root map and
    // leave the window pointing at nothing — refuse it (close the project instead).
    const root = roots.get(e.sender.id);
    if (root && resolve(p) === resolve(root)) return { ok: false, error: 'Refusing to delete the project root.' };
    try {
      const stageDir = join(trashRoot(), `${Date.now().toString(36)}-${++trashSeq}`);
      await mkdir(stageDir, { recursive: true });
      const staged = join(stageDir, basename(p));
      await moveAcross(p, staged);
      const stack = trashStackFor(e.sender.id);
      stack.push({ original: p, staged, stageDir });
      // Spill old undo entries to the real Trash so they stay recoverable and
      // the staging dir doesn't grow without bound.
      while (stack.length > TRASH_UNDO_CAP) evictToTrash(stack.shift()!);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /** Undo the most recent deletion in the REQUESTING window — move the staged
   *  item back to its original path (or a free name if occupied). Returns the
   *  restored path so the renderer can refresh the tree / reopen it. */
  ipcMain.handle('fs:undoDelete', async (e): Promise<{ ok: boolean; path?: string; isDir?: boolean; error?: string }> => {
    const stack = trashStacks.get(e.sender.id);
    const item = stack?.pop();
    if (!item) return { ok: false, error: 'Nothing to undo.' };
    // Only restore into this window's current project root (the original project
    // may have been closed/switched since the delete).
    if (!isInsideRoot(item.original, e.sender.id)) {
      stack!.push(item);
      return { ok: false, error: 'The original project is no longer open in this window.' };
    }
    try {
      let dest = item.original;
      if (existsSync(dest)) dest = resolveUniqueName(dirname(dest), basename(dest));
      await mkdir(dirname(dest), { recursive: true });
      await moveAcross(item.staged, dest);
      void rm(item.stageDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
      const isDir = (() => { try { return statSync(dest).isDirectory(); } catch { return false; } })();
      return { ok: true, path: dest, isDir };
    } catch (err) {
      // Restore failed — keep the entry so the user can retry.
      stack!.push(item);
      return { ok: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('fs:createProject', async (
    _e,
    parent: string,
    name: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    if (typeof parent !== 'string' || typeof name !== 'string') return { ok: false, error: 'Bad request' };
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Project name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid project name.' };
    }
    const expandedParent = expandHome(parent);
    const target = join(expandedParent, trimmed);
    const { existsSync, mkdirSync } = await import('node:fs');
    if (existsSync(target)) return { ok: false, error: `A folder named "${trimmed}" already exists.` };
    try {
      mkdirSync(target, { recursive: true });
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });
}
