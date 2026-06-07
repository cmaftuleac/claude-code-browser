/**
 * Server-host browser handler (Mode A).
 *
 * Drives a headless Chromium (the `browser` compose service) over CDP via
 * playwright-core's connectOverCDP — no bundled-browser download, so the server
 * image stays lean. Implements the same five agent actions as the desktop
 * <webview> handler (apps/desktop/src/main/browser-tools.ts), reusing its
 * snapshot/click scripts verbatim so agent-visible output is byte-identical.
 *
 * One BrowserContext (cookie/storage isolation) + Page per session key. The
 * Page is also the capture source for the human mirror (Phase 2).
 */
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type { BrowserInputEvent } from '@fineguide-tesseract/shared';

const CDP_URL = process.env.CCB_BROWSER_CDP_URL ?? '';

/** Walk the live DOM into a compact, indented outline. (Verbatim from desktop.) */
const SNAPSHOT_SCRIPT = `(() => {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const lines = [];
  const walk = (el, depth) => {
    if (depth > 12 || lines.length > 4000) return;
    if (skip.has(el.tagName)) return;
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .slice(0, 60);
    lines.push('  '.repeat(depth) + '<' + el.tagName.toLowerCase() + id + cls + '>' + (own ? ' ' + own : ''));
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return lines.join('\\n');
})()`;

function clickScript(selector?: string, xpath?: string): string {
  return `(() => {
    let el = null;
    ${selector ? `el = document.querySelector(${JSON.stringify(selector)});` : ''}
    ${xpath ? `if (!el) el = document.evaluate(${JSON.stringify(xpath)}, document, null, 9, null).singleNodeValue;` : ''}
    if (!el) return { clicked: false, error: 'Element not found' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { clicked: true, tag: el.tagName.toLowerCase() };
  })()`;
}

let browserPromise: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  if (!CDP_URL) throw new Error('No headless browser configured (set CCB_BROWSER_CDP_URL to the browser service CDP endpoint).');
  if (!browserPromise) {
    browserPromise = chromium
      .connectOverCDP(CDP_URL)
      .then((b) => {
        // A dropped connection invalidates the pool; the next request reconnects.
        b.on('disconnected', () => { browserPromise = null; sessions.clear(); });
        return b;
      })
      .catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

interface HostPage { context: BrowserContext; page: Page; }
const sessions = new Map<string, HostPage>();

/** Ensure a per-session isolated BrowserContext + page. Also the capture source.
 *
 * Multi-tenant isolation (B3): callers pass a key already namespaced by user —
 * scopeBrowserId(userId, browserId) — so each tenant gets its OWN incognito-like
 * BrowserContext (isolated cookies/storage/cache) on the shared Chromium, while a
 * user's own agent + mirror still share one page (same scoped key). This is
 * data/profile isolation, not process isolation; for untrusted tenants, run a
 * Chromium process per user (separate `browser` container) instead. */
export async function getSessionPage(key: string): Promise<Page> {
  const existing = sessions.get(key);
  if (existing && !existing.page.isClosed()) return existing.page;
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('close', () => { if (sessions.get(key)?.page === page) sessions.delete(key); });
  sessions.set(key, { context, page });
  return page;
}

/** Run one agent browser action against the session's page. Mirrors the desktop handler. */
export async function handleServerBrowserRequest(
  browserId: string | undefined,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const page = await getSessionPage(browserId || 'default');
  switch (action) {
    case 'navigate': {
      const url = String(params.url ?? '');
      if (!url) throw new Error('navigate requires a url');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { url: page.url(), title: await page.title() };
    }
    case 'snapshot': {
      const snapshot = (await page.evaluate(SNAPSHOT_SCRIPT)) as string;
      return { url: page.url(), title: await page.title(), snapshot };
    }
    case 'screenshot': {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
    }
    case 'click': {
      return await page.evaluate(clickScript(params.selector as string | undefined, params.xpath as string | undefined));
    }
    case 'evaluate': {
      const expression = String(params.expression ?? '');
      if (!expression) throw new Error('evaluate requires an expression');
      return await page.evaluate(expression);
    }
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

// ── Human mirror: CDP screencast (fallback transport) + input injection ──────
//
// The WS fallback streams the page as JPEG frames via CDP Page.startScreencast.
// (The WebRTC primary, when a publisher is present, streams peer-to-peer
// instead — this screencast is the degraded path that always works.) Input is
// injected through Playwright's mouse/keyboard, which target the same page.

interface Mirror { cdp: CDPSession; }
const mirrors = new Map<string, Mirror>();

/** Begin screencasting a session's page; `onFrame` gets each JPEG. Idempotent. */
export async function startMirror(key: string, onFrame: (jpeg: Buffer) => void): Promise<{ width: number; height: number }> {
  const page = await getSessionPage(key);
  if (!mirrors.has(key)) {
    const cdp = await page.context().newCDPSession(page);
    mirrors.set(key, { cdp });
    cdp.on('Page.screencastFrame', (e) => {
      const ev = e as { data: string; sessionId: number };
      try { onFrame(Buffer.from(ev.data, 'base64')); } finally {
        cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => { /* socket gone */ });
      }
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  }
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  return vp;
}

/** Stop screencasting a session's page (last viewer detached / reap). */
export async function stopMirror(key: string): Promise<void> {
  const m = mirrors.get(key);
  if (!m) return;
  mirrors.delete(key);
  try { await m.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
  try { await m.cdp.detach(); } catch { /* ignore */ }
}

const MOUSE_BUTTON = ['left', 'middle', 'right'] as const;

/** Forward a human input event onto the session's page (CSS-px viewport coords). */
export async function dispatchInput(key: string, ev: BrowserInputEvent): Promise<void> {
  const page = await getSessionPage(key);
  if (ev.kind === 'mouse') {
    const button = MOUSE_BUTTON[ev.button ?? 0] ?? 'left';
    if (ev.action === 'move') await page.mouse.move(ev.x, ev.y);
    else if (ev.action === 'down') { await page.mouse.move(ev.x, ev.y); await page.mouse.down({ button }); }
    else if (ev.action === 'up') { await page.mouse.move(ev.x, ev.y); await page.mouse.up({ button }); }
    else if (ev.action === 'click') await page.mouse.click(ev.x, ev.y, { button, clickCount: ev.clickCount ?? 1 });
  } else if (ev.kind === 'wheel') {
    await page.mouse.move(ev.x, ev.y);
    await page.mouse.wheel(ev.deltaX, ev.deltaY);
  } else if (ev.kind === 'key') {
    if (ev.action === 'char' && ev.text) await page.keyboard.insertText(ev.text);
    else if (ev.action === 'down') await page.keyboard.down(ev.key);
    else if (ev.action === 'up') await page.keyboard.up(ev.key);
  }
}

/** History / reload / goto on a session's page; returns the resulting state. */
export async function navMirror(key: string, action: 'back' | 'forward' | 'reload' | 'goto', url?: string): Promise<{ url: string; title: string }> {
  const page = await getSessionPage(key);
  if (action === 'back') await page.goBack().catch(() => null);
  else if (action === 'forward') await page.goForward().catch(() => null);
  else if (action === 'reload') await page.reload().catch(() => null);
  else if (action === 'goto' && url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
  return { url: page.url(), title: await page.title() };
}

/** Tear down a session's page + context (on session reap / detach). */
export async function closeSessionPage(key: string): Promise<void> {
  await stopMirror(key);
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try { await s.context.close(); } catch { /* ignore */ }
}
