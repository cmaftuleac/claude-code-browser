/**
 * Custom browser tools that send requests to the Chrome extension
 * via native messaging. No Playwright or external MCP server needed.
 */

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeNativeMessage, log } from './native-io.js';
import type { ServerMessage } from '@claude-code-browser/shared';

// Pending browser request callbacks
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}>();

/** Called by the host message loop when a browser:response arrives */
export function handleBrowserResponse(requestId: string, result?: unknown, error?: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(result);
  }
}

/** Send a browser request to the extension and wait for the response */
function browserRequest(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });

    const msg: ServerMessage & { type: 'browser:request' } = {
      type: 'browser:request',
      requestId,
      action: action as 'navigate' | 'snapshot' | 'screenshot' | 'click' | 'evaluate',
      params,
    };
    writeNativeMessage(msg);

    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`Browser request timed out: ${action}`));
      }
    }, 30000);
  });
}

/** Register browser tools on an MCP server instance */
export function registerBrowserTools(server: McpServer): void {
  server.tool(
    'browser_navigate',
    'Navigate the active browser tab to a URL. Returns the final URL and page title.',
    { url: z.string().describe('The URL to navigate to') },
    async ({ url }) => {
      log('browser_navigate:', url);
      const result = await browserRequest('navigate', { url });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'browser_snapshot',
    'Get a structural snapshot of the current page — accessibility tree or simplified DOM.',
    {},
    async () => {
      log('browser_snapshot');
      const result = await browserRequest('snapshot');
      const r = result as { url?: string; title?: string; snapshot?: string };
      return { content: [{ type: 'text' as const, text: `Page: ${r.title ?? '?'}\nURL: ${r.url ?? '?'}\n\n${r.snapshot ?? 'No snapshot'}` }] };
    },
  );

  server.tool(
    'browser_screenshot',
    'Take a PNG screenshot of the visible area of the current browser tab.',
    {},
    async () => {
      log('browser_screenshot');
      const result = await browserRequest('screenshot');
      const r = result as { dataUrl?: string };
      if (r.dataUrl) {
        const base64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
        return { content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' }] };
      }
      return { content: [{ type: 'text' as const, text: 'Failed to capture screenshot' }] };
    },
  );

  server.tool(
    'browser_click',
    'Click an element on the current page by CSS selector or XPath.',
    {
      selector: z.string().optional().describe('CSS selector'),
      xpath: z.string().optional().describe('XPath'),
    },
    async ({ selector, xpath }) => {
      log('browser_click:', selector ?? xpath);
      const result = await browserRequest('click', { selector, xpath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'browser_evaluate',
    'Execute JavaScript in the context of the current page.',
    { expression: z.string().describe('JavaScript expression to evaluate') },
    async ({ expression }) => {
      log('browser_evaluate:', expression.slice(0, 100));
      const result = await browserRequest('evaluate', { expression });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
