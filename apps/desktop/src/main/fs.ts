/**
 * Project filesystem access for the IDE shell: open-folder dialog, lazy
 * directory listing, file read/write (guarded to the project root), and a
 * recursive watcher that notifies the renderer of on-disk changes (so the
 * agent's edits reflect live in open editors).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { watch, type FSWatcher, openSync, readSync, closeSync, statSync, renameSync, existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, cp, rename as renameAsync } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

let currentRoot: string | null = null;
let watcher: FSWatcher | null = null;

function isInsideRoot(p: string): boolean {
  if (!currentRoot) return false;
  const rel = relative(currentRoot, resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function startWatching(root: string, getWin: () => BrowserWindow | null): void {
  watcher?.close();
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (rel.split(sep).some((seg) => IGNORED.has(seg))) return;
      pending.add(join(root, rel));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        getWin()?.webContents.send('fs:changed', paths);
      }, 120);
    });
  } catch {
    // recursive watch unsupported on some platforms — degrade gracefully.
  }
}

export function registerFsHandlers(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('fs:openFolder', async (_e, explicitPath?: string) => {
    let root: string;
    if (typeof explicitPath === 'string' && explicitPath.length > 0) {
      // Caller already knows the path (recents / new-project flow). Validate it exists.
      const { existsSync, statSync } = await import('node:fs');
      if (!existsSync(explicitPath) || !statSync(explicitPath).isDirectory()) {
        return null;
      }
      root = resolve(explicitPath);
    } else {
      const win = getWin();
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      root = result.filePaths[0];
    }
    currentRoot = root;
    startWatching(root, getWin);
    app.addRecentDocument(root);
    return { root, name: basename(root) };
  });

  /** Open a native folder picker and return the chosen path WITHOUT any side
   *  effects (no current-root mutation, no watcher start, no recents bump).
   *  Used by NewProjectView's "Choose…" parent-dir picker. */
  ipcMain.handle('fs:pickFolder', async (): Promise<string | null> => {
    const win = getWin();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
  ipcMain.handle('fs:renameFile', async (_e, oldPath: string, newName: string): Promise<{
    ok: boolean; newPath?: string; error?: string;
  }> => {
    if (typeof oldPath !== 'string' || typeof newName !== 'string') return { ok: false, error: 'Bad request' };
    const trimmed = newName.trim();
    if (!trimmed) return { ok: false, error: 'Name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid name.' };
    }
    if (!isInsideRoot(oldPath)) return { ok: false, error: 'Refusing to rename outside the project root.' };
    const newPath = join(dirname(oldPath), trimmed);
    if (existsSync(newPath)) return { ok: false, error: `A file named "${trimmed}" already exists.` };
    try {
      renameSync(oldPath, newPath);
      return { ok: true, newPath };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  ipcMain.handle('fs:writeFile', async (_e, p: string, content: string): Promise<{ ok: boolean; error?: string }> => {
    if (!isInsideRoot(p)) return { ok: false, error: 'Refusing to write outside the project root.' };
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
    _e,
    parent: string,
    name: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'File name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid file name.' };
    }
    if (!isInsideRoot(parent)) return { ok: false, error: 'Refusing to create outside the project root.' };
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
    _e,
    parent: string,
    name: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> => {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'Folder name is required.' };
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
      return { ok: false, error: 'Invalid folder name.' };
    }
    if (!isInsideRoot(parent)) return { ok: false, error: 'Refusing to create outside the project root.' };
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
    _e,
    srcPaths: string[],
    destDir: string,
  ): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> => {
    if (!Array.isArray(srcPaths) || typeof destDir !== 'string') return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(destDir)) return { ok: false, error: 'Refusing to copy outside the project root.' };
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
    _e,
    srcPaths: string[],
    destDir: string,
  ): Promise<{ ok: boolean; newPaths?: string[]; error?: string }> => {
    if (!Array.isArray(srcPaths) || typeof destDir !== 'string') return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(destDir)) return { ok: false, error: 'Refusing to move outside the project root.' };
    try {
      const newPaths: string[] = [];
      for (const src of srcPaths) {
        if (typeof src !== 'string' || !src) continue;
        if (!isInsideRoot(src)) return { ok: false, error: 'Refusing to move from outside the project root.' };
        // Avoid no-op move (source already in destDir with same name).
        if (dirname(src) === destDir) { newPaths.push(src); continue; }
        const target = resolveUniqueName(destDir, basename(src));
        await renameAsync(src, target);
        newPaths.push(target);
      }
      return { ok: true, newPaths };
    } catch (err) {
      return { ok: false, error: String((err as Error).message) };
    }
  });

  /**
   * Move a file or folder to the system trash. Far safer than `rm -rf` —
   * recoverable via Finder/Explorer. Uses Electron's `shell.trashItem`.
   */
  ipcMain.handle('fs:deletePath', async (_e, p: string): Promise<{ ok: boolean; error?: string }> => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'Bad request' };
    if (!isInsideRoot(p)) return { ok: false, error: 'Refusing to delete outside the project root.' };
    try {
      await shell.trashItem(p);
      return { ok: true };
    } catch (err) {
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
