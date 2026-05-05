#!/usr/bin/env node
/**
 * Standalone stdio MCP server for browser tools.
 * Spawned by Claude Code as a child process.
 * Communicates with the main host via a TCP socket for browser request relay.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { createConnection, type Socket } from 'node:net';

const IPC_PORT = parseInt(process.env.CCB_IPC_PORT ?? '0', 10);
if (!IPC_PORT) {
  process.stderr.write('CCB_IPC_PORT not set\n');
  process.exit(1);
}

// ── IPC with host process ──────────────────────────────────────────────────

let ipcSocket: Socket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}>();

function connectIpc(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ port: IPC_PORT, host: '127.0.0.1' }, () => {
      ipcSocket = sock;
      resolve();
    });
    sock.on('error', reject);

    let buffer = '';
    sock.on('data', (data) => {
      buffer += data.toString();
      // Messages are newline-delimited JSON
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const pending = pendingRequests.get(msg.requestId)!;
            pendingRequests.delete(msg.requestId);
            if (msg.error) pending.reject(new Error(msg.error));
            else pending.resolve(msg.result);
          }
        } catch { /* ignore parse errors */ }
      }
    });
  });
}

function browserRequest(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!ipcSocket) return Promise.reject(new Error('IPC not connected'));
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    ipcSocket!.write(JSON.stringify({ requestId, action, params }) + '\n');

    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`Browser request timed out: ${action}`));
      }
    }, 30000);
  });
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'browser-tools', version: '0.1.0' });

server.tool(
  'browser_navigate',
  'Navigate the active browser tab to a URL. Returns the final URL and page title.',
  { url: z.string().describe('The URL to navigate to') },
  async ({ url }) => {
    const result = await browserRequest('navigate', { url });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'browser_snapshot',
  'Get a structural snapshot of the current page — accessibility tree or simplified DOM.',
  {},
  async () => {
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
    const result = await browserRequest('click', { selector, xpath });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'browser_evaluate',
  'Execute JavaScript in the context of the current page.',
  { expression: z.string().describe('JavaScript expression to evaluate') },
  async ({ expression }) => {
    const result = await browserRequest('evaluate', { expression });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main() {
  await connectIpc();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
