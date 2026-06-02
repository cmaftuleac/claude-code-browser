/**
 * Browser tool actions executed directly against the embedded <webview>'s
 * webContents. These are the desktop equivalent of the extension's
 * browser-handler.ts — same action names/results, but no Chrome APIs: we own
 * the guest, so we drive it with Electron's webContents methods.
 *
 * Called from main's onBrowserRequest, which Claude Code reaches over the
 * agent-core IPC socket (via the spawned browser-cli).
 */
import type { WebContents } from 'electron';

/** Walk the live DOM into a compact, indented outline. Runs inside the guest. */
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

export async function handleBrowserRequest(
  guest: WebContents | null,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!guest || guest.isDestroyed()) {
    throw new Error('No page loaded in the embedded browser. Open a URL first.');
  }

  switch (action) {
    case 'navigate': {
      const url = String(params.url ?? '');
      if (!url) throw new Error('navigate requires a url');
      await guest.loadURL(url);
      return { url: guest.getURL(), title: guest.getTitle() };
    }
    case 'snapshot': {
      const snapshot = (await guest.executeJavaScript(SNAPSHOT_SCRIPT)) as string;
      return { url: guest.getURL(), title: guest.getTitle(), snapshot };
    }
    case 'screenshot': {
      const image = await guest.capturePage();
      return { dataUrl: image.toDataURL() };
    }
    case 'click': {
      return guest.executeJavaScript(
        clickScript(params.selector as string | undefined, params.xpath as string | undefined),
      );
    }
    case 'evaluate': {
      const expression = String(params.expression ?? '');
      if (!expression) throw new Error('evaluate requires an expression');
      // true → run in the page's main world and resolve the (serializable) result.
      return guest.executeJavaScript(expression, true);
    }
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}
