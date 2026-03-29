/**
 * Custom browser tools that send requests to the Chrome extension
 * via native messaging. No Playwright or MCP server needed.
 */

import { z } from 'zod/v4';
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

/** Tool definitions for the Agent SDK's `tools` option */
export function getBrowserToolDefinitions() {
  return [
    {
      name: 'browser_navigate',
      description: 'Navigate the active browser tab to a URL. Returns the final URL and page title.',
      inputSchema: { url: z.string().describe('The URL to navigate to') },
      handler: async (args: { url: string }) => {
        log('browser_navigate:', args.url);
        const result = await browserRequest('navigate', { url: args.url });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    },
    {
      name: 'browser_snapshot',
      description: 'Get a structural snapshot of the current page — accessibility tree or simplified DOM.',
      inputSchema: {},
      handler: async () => {
        log('browser_snapshot');
        const result = await browserRequest('snapshot');
        const r = result as { url?: string; title?: string; snapshot?: string };
        return { content: [{ type: 'text' as const, text: `Page: ${r.title ?? '?'}\nURL: ${r.url ?? '?'}\n\n${r.snapshot ?? 'No snapshot'}` }] };
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Take a PNG screenshot of the visible area of the current browser tab.',
      inputSchema: {},
      handler: async () => {
        log('browser_screenshot');
        const result = await browserRequest('screenshot');
        const r = result as { dataUrl?: string };
        if (r.dataUrl) {
          const base64 = r.dataUrl.replace(/^data:image\/png;base64,/, '');
          return { content: [{ type: 'image' as const, data: base64, mimeType: 'image/png' }] };
        }
        return { content: [{ type: 'text' as const, text: 'Failed to capture screenshot' }] };
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element on the current page by CSS selector or XPath.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector'),
        xpath: z.string().optional().describe('XPath'),
      },
      handler: async (args: { selector?: string; xpath?: string }) => {
        log('browser_click:', args.selector ?? args.xpath);
        const result = await browserRequest('click', { selector: args.selector, xpath: args.xpath });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    },
    {
      name: 'browser_evaluate',
      description: 'Execute JavaScript in the context of the current page.',
      inputSchema: { expression: z.string().describe('JavaScript expression to evaluate') },
      handler: async (args: { expression: string }) => {
        log('browser_evaluate:', args.expression.slice(0, 100));
        const result = await browserRequest('evaluate', { expression: args.expression });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    },
  ];
}
