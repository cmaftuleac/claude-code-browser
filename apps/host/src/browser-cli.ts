#!/usr/bin/env node
/**
 * CLI for browser tools — called by the agent via Bash tool.
 * Usage: browser-cli <action> [params-json]
 *   browser-cli navigate '{"url":"https://example.com"}'
 *   browser-cli screenshot
 *   browser-cli snapshot
 *   browser-cli click '{"selector":".btn"}'
 *   browser-cli evaluate '{"expression":"document.title"}'
 */

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function getIpcPort(): number {
  // Try env var first, then fall back to port file
  const envPort = parseInt(process.env.CCB_IPC_PORT ?? '0', 10);
  if (envPort) return envPort;
  try {
    return parseInt(readFileSync(join(tmpdir(), 'ccb-ipc-port'), 'utf-8').trim(), 10);
  } catch {
    return 0;
  }
}

const IPC_PORT = getIpcPort();
const action = process.argv[2];
const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};

if (!IPC_PORT || !action) {
  console.error('Usage: browser-cli <action> [params-json]');
  console.error('CCB_IPC_PORT not found in env or port file');
  process.exit(1);
}

const requestId = crypto.randomUUID();

const sock = createConnection({ port: IPC_PORT, host: '127.0.0.1' }, () => {
  sock.write(JSON.stringify({ requestId, action, params }) + '\n');
});

let buffer = '';
sock.on('data', (data) => {
  buffer += data.toString();
  const idx = buffer.indexOf('\n');
  if (idx !== -1) {
    const line = buffer.slice(0, idx);
    try {
      const msg = JSON.parse(line);
      if (msg.requestId === requestId) {
        if (msg.error) {
          console.error(msg.error);
          process.exit(1);
        } else {
          // For screenshots, output just the data URL
          const result = msg.result;
          if (typeof result === 'object' && result !== null) {
            if (action === 'snapshot') {
              console.log(`Page: ${result.title ?? '?'}\nURL: ${result.url ?? '?'}\n\n${result.snapshot ?? 'No snapshot'}`);
            } else if (action === 'screenshot' && result.dataUrl) {
              console.log('[Screenshot captured successfully]');
            } else {
              console.log(JSON.stringify(result, null, 2));
            }
          } else {
            console.log(String(result));
          }
          process.exit(0);
        }
      }
    } catch { /* ignore parse errors */ }
  }
});

sock.on('error', (err) => {
  console.error(`Connection failed: ${err.message}`);
  process.exit(1);
});

// Timeout
setTimeout(() => {
  console.error('Browser request timed out');
  process.exit(1);
}, 30000);
