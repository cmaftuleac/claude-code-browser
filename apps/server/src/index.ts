/**
 * Claude Code Browser — local server (web-mode backend).
 *
 * Runs the agent (via @claude-code-browser/agent-core) and exposes:
 *  - WebSocket at /ws    → ClientMessage/ServerMessage protocol (same as Electron main).
 *  - HTTP /fs/*          → readDir/readFile/writeFile + root probe.
 *  - WS fs:changed       → recursive file-watcher events pushed to clients.
 *
 * The renderer (apps/desktop) installs a window.ccb polyfill in the browser
 * that talks to this server, so the React app runs identically in Electron or
 * a plain web browser.
 *
 * Env:
 *   CCB_PORT   server port (default 9315)
 *   CCB_ROOT   project root the agent operates in (default cwd)
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readdir, readFile, writeFile, mkdir, stat, rename, rm, cp } from 'node:fs/promises';
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, watch, createReadStream, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CCB_PORT ?? 9315);
const ROOT = resolve(process.env.CCB_ROOT ?? process.cwd());
const VERSION = '0.2.0';

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','avif','tiff','tif','heic',
  'woff','woff2','ttf','otf','eot',
  'mp4','webm','mov','mp3','wav','ogg','m4a','flac','oga','aac','opus','wma','aiff','aif',
  'mkv','avi','m4v','mpeg','mpg','wmv','flv','3gp',
  'pdf','zip','gz','tar','wasm','node','so','dylib','dll','exe',
  'doc','docx','odt','rtf',
  'xls','xlsx','ods',
  'ppt','pptx','odp',
  'parquet','arrow','feather','ipc','orc','avro','msgpack',
  'sqlite','sqlite3','db','db3',
  'bin','dat','pkl','pyc','class','jar','war','ear',
  'iso','dmg','rar','7z','bz2','xz','lz4','zst',
]);
const TEXT_SIZE_LIMIT = 5 * 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

// ── WS clients + broadcast ──────────────────────────────────────────────────

const clients = new Set<WebSocket>();
type WireMessage = ServerMessage | { type: 'fs:changed'; paths: string[] } | { type: 'fs:root'; root: string; name: string };

function broadcast(msg: WireMessage): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}

// ── Agent core (lazy, ESM) ──────────────────────────────────────────────────

type AnyAgentManager = import('@claude-code-browser/agent-core').AgentManager;
type AnySessionStore = import('@claude-code-browser/agent-core').SessionStore;

let agentManager: AnyAgentManager | null = null;
let sessionStore: AnySessionStore | null = null;
let agentInit: Promise<void> | null = null;

async function ensureAgent(): Promise<void> {
  if (!agentInit) {
    agentInit = (async () => {
      const { AgentManager, SessionStore } = await import('@claude-code-browser/agent-core');
      agentManager = new AgentManager(
        (msg) => broadcast(msg),
        (requestId, action) => {
          // Browser tools require an embedded webview — no such thing in server mode.
          agentManager?.sendBrowserResponse(requestId, undefined, `Browser tool '${action}' is unavailable in server mode.`);
        },
      );
      sessionStore = new SessionStore();
      agentManager.setConfig(ROOT);
    })();
  }
  return agentInit;
}

async function dispatch(msg: ClientMessage): Promise<void> {
  await ensureAgent();
  switch (msg.type) {
    case 'ping':
      broadcast({ type: 'pong' });
      break;
    case 'health:check':
      broadcast({ type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true });
      break;
    case 'commands:list':
      broadcast({ type: 'commands:list', commands: [] });
      break;
    case 'chat:send':
      agentManager!.sendMessage({
        message: msg.message,
        sessionId: msg.sessionId,
        clientRequestId: msg.clientRequestId,
        anchors: msg.anchors,
        images: msg.images,
        url: msg.url,
        projectDir: msg.projectDir ?? ROOT,
        sources: msg.sources,
      }).catch((err) => console.error('sendMessage error:', err instanceof Error ? err.message : String(err)));
      break;
    case 'session:list': {
      const sessions = await sessionStore!.getSessions().catch(() => []);
      broadcast({ type: 'session:list', sessions });
      break;
    }
    case 'session:resume': {
      const messages = await sessionStore!.getSessionMessages(msg.sessionId).catch(() => []);
      broadcast({ type: 'session:messages', sessionId: msg.sessionId, messages });
      break;
    }
    case 'agent:interrupt':
      if (agentManager!.interruptSession(msg.sessionId ?? '')) {
        broadcast({ type: 'agent:status', sessionId: msg.sessionId ?? '', status: 'idle' });
      }
      break;
    case 'config:set':
      agentManager!.setConfig(msg.projectDir);
      break;
    case 'sources:set':
      broadcast({ type: 'sources:set', domain: msg.domain, paths: msg.paths });
      break;
    case 'browser:response':
      agentManager!.sendBrowserResponse(msg.requestId, msg.result, msg.error);
      break;
  }
}

// ── Filesystem ──────────────────────────────────────────────────────────────

function isInsideRoot(p: string): boolean {
  const rel = relative(ROOT, resolve(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.get('/health', (_req, res) => { res.json({ status: 'ok', version: VERSION }); });
app.get('/fs/root', (_req, res) => { res.json({ root: ROOT, name: basename(ROOT) }); });

app.get('/fs/readDir', async (req, res) => {
  const dir = String(req.query.dir ?? ROOT);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    res.json(entries
      .filter((e) => e.name !== '.DS_Store')
      .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)));
  } catch {
    res.json([]);
  }
});

app.get('/fs/readFile', async (req, res) => {
  const p = String(req.query.path ?? '');
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  if (BINARY_EXT.has(ext)) { res.json({ error: 'Binary file — not shown in the editor.' }); return; }
  try {
    const s = statSync(p);
    if (s.size > TEXT_SIZE_LIMIT) { res.json({ error: 'File too large for text view.' }); return; }
    res.json({ content: await readFile(p, 'utf-8') });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

app.get('/fs/statFile', (req, res) => {
  const p = String(req.query.path ?? '');
  try {
    const s = statSync(p);
    if (!s.isFile()) { res.json({ error: 'Not a file' }); return; }
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const isBinary = BINARY_EXT.has(ext) || s.size > TEXT_SIZE_LIMIT;
    res.json({ size: s.size, isBinary, mtimeMs: s.mtimeMs });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

/** Stream a file with HTTP Range support — feeds the browser's <video>/<audio>
 *  scrubber and <img> loader without buffering the whole file into RAM. */
app.get('/fs/stream', (req, res) => {
  const p = String(req.query.path ?? '');
  let stat;
  try { stat = statSync(p); } catch (err) { res.status(404).json({ error: String((err as Error).message) }); return; }
  if (!stat.isFile()) { res.status(400).json({ error: 'Not a file' }); return; }

  const range = req.headers.range;
  // Naive MIME by extension — Chromium's <video> works fine with octet-stream too.
  res.setHeader('Accept-Ranges', 'bytes');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(p).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.status(416).end(); return; }
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) { res.status(416).end(); return; }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  createReadStream(p, { start, end }).pipe(res);
});

app.get('/fs/readBinary', async (req, res) => {
  const p = String(req.query.path ?? '');
  const CAP = 256 * 1024 * 1024;
  try {
    const s = statSync(p);
    if (s.size > CAP) { res.json({ error: `File is too large to load whole (${(s.size / 1024 / 1024).toFixed(1)} MB).` }); return; }
    const data = await readFile(p);
    res.json({ base64: data.toString('base64'), size: s.size });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  }
});

app.get('/fs/readChunk', (req, res) => {
  const p = String(req.query.path ?? '');
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  const length = Math.min(1024 * 1024, Math.max(0, Math.floor(Number(req.query.length) || 0)));
  if (length === 0) { res.json({ base64: '', bytesRead: 0 }); return; }
  let fd: number | null = null;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, offset);
    res.json({ base64: buf.subarray(0, bytesRead).toString('base64'), bytesRead });
  } catch (err) {
    res.json({ error: String((err as Error).message) });
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
});

app.post('/fs/renameFile', async (req, res) => {
  const { oldPath, newName } = (req.body ?? {}) as { oldPath?: unknown; newName?: unknown };
  if (typeof oldPath !== 'string' || typeof newName !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = newName.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(oldPath)) { res.json({ ok: false, error: 'Refusing to rename outside the project root.' }); return; }
  const newPath = join(dirname(oldPath), trimmed);
  if (existsSync(newPath)) { res.json({ ok: false, error: `A file named "${trimmed}" already exists.` }); return; }
  try {
    await rename(oldPath, newPath);
    res.json({ ok: true, newPath });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Create an empty file inside the project root. Mirrors the Electron IPC. */
app.post('/fs/createFile', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(parent)) { res.json({ ok: false, error: 'Refusing to create outside the project root.' }); return; }
  const target = join(parent, trimmed);
  if (existsSync(target)) { res.json({ ok: false, error: `"${trimmed}" already exists.` }); return; }
  try {
    await writeFile(target, '', 'utf-8');
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Create an empty directory inside the project root. */
app.post('/fs/createFolder', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid name.' }); return;
  }
  if (!isInsideRoot(parent)) { res.json({ ok: false, error: 'Refusing to create outside the project root.' }); return; }
  const target = join(parent, trimmed);
  if (existsSync(target)) { res.json({ ok: false, error: `"${trimmed}" already exists.` }); return; }
  try {
    await mkdir(target);
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/** Append " 2", " 3"… until a free slot is found. Finder-style. */
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
  return direct;
}

app.post('/fs/copyPaths', async (req, res) => {
  const { srcPaths, destDir } = (req.body ?? {}) as { srcPaths?: unknown; destDir?: unknown };
  if (!Array.isArray(srcPaths) || typeof destDir !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(destDir)) { res.json({ ok: false, error: 'Refusing to copy outside the project root.' }); return; }
  try {
    const newPaths: string[] = [];
    for (const src of srcPaths) {
      if (typeof src !== 'string' || !src) continue;
      const target = resolveUniqueName(destDir, basename(src));
      await cp(src, target, { recursive: true, errorOnExist: false, force: false });
      newPaths.push(target);
    }
    res.json({ ok: true, newPaths });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

app.post('/fs/movePaths', async (req, res) => {
  const { srcPaths, destDir } = (req.body ?? {}) as { srcPaths?: unknown; destDir?: unknown };
  if (!Array.isArray(srcPaths) || typeof destDir !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(destDir)) { res.json({ ok: false, error: 'Refusing to move outside the project root.' }); return; }
  try {
    const newPaths: string[] = [];
    for (const src of srcPaths) {
      if (typeof src !== 'string' || !src) continue;
      if (!isInsideRoot(src)) { res.json({ ok: false, error: 'Refusing to move from outside the project root.' }); return; }
      if (dirname(src) === destDir) { newPaths.push(src); continue; }
      const target = resolveUniqueName(destDir, basename(src));
      await rename(src, target);
      newPaths.push(target);
    }
    res.json({ ok: true, newPaths });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

/**
 * Delete a path (file or folder) inside the project root.
 *
 * Web mode lacks Electron's `shell.trashItem`, so we fall back to a hard
 * recursive delete. The desktop app uses the IPC which goes to Trash —
 * recoverable. This endpoint is the unrecoverable variant; client UI must
 * make that distinction clear before calling.
 */
app.delete('/fs/path', async (req, res) => {
  const p = String(req.query.path ?? '');
  if (!p) { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(p)) { res.json({ ok: false, error: 'Refusing to delete outside the project root.' }); return; }
  try {
    await rm(p, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

// ── Recents (persisted JSON in ~/.ccb/) ────────────────────────────────────

interface RecentProject { path: string; name: string; lastOpenedAt: number; }
const RECENTS_FILE = join(homedir(), '.ccb', 'recents.json');
const RECENTS_CAP = 24;

function readRecents(): RecentProject[] {
  try {
    const raw = readFileSync(RECENTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x.path === 'string' && typeof x.name === 'string' && typeof x.lastOpenedAt === 'number');
  } catch { return []; }
}
function writeRecents(items: RecentProject[]): void {
  try {
    const dir = dirname(RECENTS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(RECENTS_FILE, JSON.stringify(items, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

app.get('/recents', (_req, res) => {
  res.json(readRecents().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, RECENTS_CAP));
});

app.post('/recents', (req, res) => {
  const { path: p, name } = (req.body ?? {}) as { path?: unknown; name?: unknown };
  if (typeof p !== 'string' || typeof name !== 'string') { res.status(400).json({ error: 'Bad request' }); return; }
  const next = [{ path: p, name, lastOpenedAt: Date.now() }, ...readRecents().filter((x) => x.path !== p)].slice(0, RECENTS_CAP);
  writeRecents(next);
  res.json(next);
});

app.delete('/recents', (req, res) => {
  const p = String(req.query.path ?? '');
  const next = readRecents().filter((x) => x.path !== p);
  writeRecents(next);
  res.json(next);
});

// ── Open arbitrary path / create empty project (no native dialog on server) ─

app.post('/fs/openFolder', async (req, res) => {
  const { path: p } = (req.body ?? {}) as { path?: unknown };
  if (typeof p !== 'string' || !p) { res.status(400).json({ error: 'path required' }); return; }
  try {
    const s = await stat(p);
    if (!s.isDirectory()) { res.status(400).json({ error: 'Not a directory' }); return; }
    res.json({ root: resolve(p), name: basename(p) });
  } catch (err) {
    res.status(404).json({ error: String((err as Error).message) });
  }
});

app.post('/fs/createProject', async (req, res) => {
  const { parent, name } = (req.body ?? {}) as { parent?: unknown; name?: unknown };
  if (typeof parent !== 'string' || typeof name !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    res.json({ ok: false, error: 'Invalid project name.' });
    return;
  }
  const expandedParent = parent.startsWith('~/') ? join(homedir(), parent.slice(2)) : (parent === '~' ? homedir() : parent);
  const target = join(expandedParent, trimmed);
  if (existsSync(target)) { res.json({ ok: false, error: `A folder named "${trimmed}" already exists.` }); return; }
  try {
    await mkdir(target, { recursive: true });
    res.json({ ok: true, path: target });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

app.post('/fs/writeFile', async (req, res) => {
  const { path: p, content } = (req.body ?? {}) as { path?: unknown; content?: unknown };
  if (typeof p !== 'string' || typeof content !== 'string') { res.json({ ok: false, error: 'Bad request' }); return; }
  if (!isInsideRoot(p)) { res.json({ ok: false, error: 'Refusing to write outside the project root.' }); return; }
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: String((err as Error).message) });
  }
});

// ── Renderer static (production / single-Node-service mode) ───────────────
// Same path whether run as src/index.ts (tsx) or dist/index.js — `apps/server/{src|dist}/../../desktop/dist-web`.
const STATIC_DIR = process.env.CCB_STATIC_DIR
  ? resolve(process.env.CCB_STATIC_DIR)
  : resolve(__dirname, '..', '..', 'desktop', 'dist-web');
const STATIC_AVAILABLE = existsSync(join(STATIC_DIR, 'index.html'));

if (STATIC_AVAILABLE) {
  app.use(express.static(STATIC_DIR));
  // SPA fallback: any GET that fell through the API routes returns index.html.
  // (WebSocket upgrades don't reach Express GET; /fs/* and /health are defined above.)
  app.get('*', (_req, res) => { res.sendFile(join(STATIC_DIR, 'index.html')); });
}

// ── FS watcher → broadcast fs:changed ──────────────────────────────────────

let watcher: FSWatcher | null = null;
function startWatching(root: string): void {
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
        broadcast({ type: 'fs:changed', paths });
      }, 120);
    });
  } catch {
    console.warn('[ccb-server] recursive watch unsupported on this platform');
  }
}
startWatching(ROOT);

// ── HTTP + WS bootstrap ────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[ccb-server] ws client connected (${clients.size} total)`);

  ws.send(JSON.stringify({ type: 'connection:ready', serverVersion: VERSION }));
  ws.send(JSON.stringify({ type: 'health', nodeVersion: process.version, claudeCodeInstalled: true, claudeAuthenticated: true }));
  ws.send(JSON.stringify({ type: 'fs:root', root: ROOT, name: basename(ROOT) }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as ClientMessage;
      void dispatch(msg);
    } catch (err) {
      console.error('[ccb-server] ws parse/dispatch error:', err instanceof Error ? err.message : String(err));
    }
  });
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { clients.delete(ws); });
});

server.listen(PORT, () => {
  console.log(`[ccb-server] listening on :${PORT}`);
  console.log(`[ccb-server] project root: ${ROOT}`);
  console.log(`[ccb-server] ws ws://localhost:${PORT}/ws · health http://localhost:${PORT}/health`);
  if (STATIC_AVAILABLE) {
    console.log(`[ccb-server] serving renderer from ${STATIC_DIR}`);
    console.log(`[ccb-server] open http://localhost:${PORT} in any browser`);
  } else {
    console.log(`[ccb-server] (no static renderer at ${STATIC_DIR} — run 'npm run build:web -w apps/desktop' to produce it)`);
  }
});
