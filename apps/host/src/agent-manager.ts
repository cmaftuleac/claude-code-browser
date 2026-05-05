/**
 * Core orchestration — bridges user messages to the Claude Agent SDK using
 * streaming-input mode. One long-lived Query per session lets new user
 * messages be injected mid-turn without interrupting the agent.
 */

import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ElementAnchor, ServerMessage } from '@claude-code-browser/shared';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { log } from './native-io.js';

/** Find the SDK's cli.js — a Node.js script version of Claude Code.
 *  We run this under Node.js instead of the Bun-compiled binary to avoid
 *  Gatekeeper blocking native .node addon extraction from Chrome context.
 *
 *  cli.js is not in the SDK's package.json `exports`, so we can't resolve it
 *  directly. Instead, resolve the SDK's main entry and look in the same dir.
 *  This works regardless of install layout (workspace, hoisted npm, npx cache). */
function findClaudeCliJs(): string {
  const require = createRequire(import.meta.url);
  const sdkMain = require.resolve('@anthropic-ai/claude-agent-sdk');
  const cliJs = join(dirname(sdkMain), 'cli.js');
  if (!existsSync(cliJs)) {
    throw new Error(`Claude Agent SDK cli.js not found at ${cliJs}. The installed SDK version may not ship cli.js — apps/host/package.json pins @anthropic-ai/claude-agent-sdk to a version that includes it.`);
  }
  return cliJs;
}

export interface SendMessageParams {
  message: string;
  sessionId?: string;
  anchors?: ElementAnchor[];
  images?: string[];
  url: string;
  projectDir?: string;
  sources?: string[];
}

function formatToolDetail(name: string, rawInput: string): string {
  try {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    switch (name) {
      case 'Bash': return `Running Bash command\n\`\`\`\n${input.command}\n\`\`\``;
      case 'Read': return `Reading file\n\`${input.file_path}\``;
      case 'Edit': return `Editing file\n\`${input.file_path}\``;
      case 'Write': return `Writing file\n\`${input.file_path}\``;
      case 'Grep': return `Searching for \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`;
      case 'Glob': return `Finding files \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`;
      default: {
        if (name.startsWith('browser_')) return `Running ${name.replace('_', ' ')}`;
        const firstVal = Object.values(input)[0];
        if (firstVal && typeof firstVal === 'string') return `${name}: ${String(firstVal).slice(0, 120)}`;
        return name;
      }
    }
  } catch {
    return name;
  }
}

/**
 * Push-based AsyncIterable used as the streaming-input prompt for query().
 * Resolves pending next() calls when push() is called; closes cleanly on end().
 */
class AsyncMessagePump<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}

interface LiveSession {
  /** Empty until the SDK reports session_id on the first frame */
  sessionId: string;
  pump: AsyncMessagePump<SDKUserMessage>;
  query: Query;
  abort: AbortController;
  cwd: string;
  /** Set once for brand-new sessions so we can renameSession after init */
  pendingTitle: string;
}

export class AgentManager {
  private ipcServer: NetServer | null = null;
  private ipcPort = 0;
  private ipcClients = new Set<Socket>();
  private projectDir: string | undefined;
  private liveSessions = new Map<string, LiveSession>();
  /** Sessions whose canonical sessionId is not yet known (first frame pending) */
  private pendingLiveSessions = new Set<LiveSession>();
  private browserCliPath: string;

  constructor(
    private send: (msg: ServerMessage) => void,
    private onBrowserRequest: (requestId: string, action: string, params: Record<string, unknown>) => void,
  ) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.browserCliPath = join(__dirname, 'browser-cli.js');
    this.startIpcServer();
  }

  private startIpcServer(): void {
    this.ipcServer = createServer((socket) => {
      this.ipcClients.add(socket);
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          try {
            const msg = JSON.parse(line) as { requestId: string; action: string; params: Record<string, unknown> };
            this.onBrowserRequest(msg.requestId, msg.action, msg.params);
          } catch { /* ignore */ }
        }
      });
      socket.on('close', () => this.ipcClients.delete(socket));
      socket.on('error', () => this.ipcClients.delete(socket));
    });
    this.ipcServer.listen(0, '127.0.0.1', () => {
      const addr = this.ipcServer!.address();
      this.ipcPort = typeof addr === 'object' && addr ? addr.port : 0;
      log('IPC server listening on port', this.ipcPort);
      const portFile = join(tmpdir(), 'ccb-ipc-port');
      writeFile(portFile, String(this.ipcPort)).catch(() => {});
    });
  }

  sendBrowserResponse(requestId: string, result?: unknown, error?: string): void {
    const msg = JSON.stringify({ requestId, result, error }) + '\n';
    for (const client of this.ipcClients) {
      try { client.write(msg); } catch { /* ignore */ }
    }
  }

  setConfig(projectDir?: string): void {
    if (projectDir) this.projectDir = projectDir;
  }

  private buildSystemPrompt(url?: string): string {
    const cli = `${process.execPath} ${this.browserCliPath}`;
    const pageInfo = url ? `\nThe user's current browser tab is: ${url}` : '';
    return `You are Claude Code Browser, an AI assistant helping developers inspect and fix web pages.
You have direct access to the user's browser tab via CLI tools. Use the Bash tool to call them:${pageInfo}

BROWSER TOOLS (use via Bash):
- \`${cli} navigate '{"url":"<url>"}'\` — Navigate to a URL
- \`${cli} snapshot\` — Get page DOM structure
- \`${cli} screenshot\` — Take a screenshot
- \`${cli} click '{"selector":"<css>"}'\` — Click an element
- \`${cli} evaluate '{"expression":"<js>"}'\` — Run JavaScript on the page

CRITICAL RULES:
- The browser tools operate on the user's pinned browser tab, not any other tab.
- Use snapshot to see the page structure before making changes.
- Use screenshot to see the visual state.
- When element selectors are provided, use click or evaluate to interact.
- You can read and edit project source files if a project directory is configured.
- Always confirm before making destructive changes to source files.`;
  }

  async sendMessage(params: SendMessageParams): Promise<void> {
    // Save attached images to disk and append paths to the user message.
    if (params.images && params.images.length > 0) {
      const imgDir = join(tmpdir(), 'ccb-images');
      await mkdir(imgDir, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < params.images.length; i++) {
        const match = params.images[i].match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          const filePath = join(imgDir, `img-${Date.now()}-${i}.${ext}`);
          await writeFile(filePath, Buffer.from(match[2], 'base64'));
          paths.push(filePath);
        }
      }
      if (paths.length > 0) {
        params.message += '\n\nAttached images (use Read tool to view them):\n' + paths.map((p) => `- ${p}`).join('\n');
      }
    }

    const userText = this.buildPrompt(params);

    // Find or create a LiveSession for this conversation.
    let live: LiveSession | null = params.sessionId ? this.liveSessions.get(params.sessionId) ?? null : null;
    if (!live) {
      live = this.createLiveSession(params);
    }

    const sdkMsg: SDKUserMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: userText },
    };
    live.pump.push(sdkMsg);
  }

  private createLiveSession(params: SendMessageParams): LiveSession {
    const cwd = params.projectDir ?? this.projectDir ?? params.sources?.[0] ?? process.cwd();
    const abortController = new AbortController();
    const pump = new AsyncMessagePump<SDKUserMessage>();
    const isNewSession = !params.sessionId;
    const pendingTitle = isNewSession ? params.message.trim().slice(0, 80) : '';

    const q = query({
      prompt: pump,
      options: {
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        spawnClaudeCodeProcess: (options) => {
          const cliJs = findClaudeCliJs();
          const child = spawn(process.execPath, [cliJs, ...options.args], {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return child as any;
        },
        systemPrompt: this.buildSystemPrompt(params.url),
        includePartialMessages: true,
        cwd,
        additionalDirectories: params.sources,
        abortController,
        ...(params.sessionId && { resume: params.sessionId }),
      },
    });

    const live: LiveSession = {
      sessionId: params.sessionId ?? '',
      pump,
      query: q,
      abort: abortController,
      cwd,
      pendingTitle,
    };

    if (params.sessionId) this.liveSessions.set(params.sessionId, live);
    else this.pendingLiveSessions.add(live);

    this.runConsumer(live).catch((err) => log('Consumer error:', err instanceof Error ? err.message : String(err)));
    return live;
  }

  private async runConsumer(live: LiveSession): Promise<void> {
    let currentToolName = '';
    let currentToolInput = '';
    let insideXmlToolBlock = false;

    try {
      for await (const message of live.query) {
        // Resolve canonical sessionId on first frame that carries it.
        if (!live.sessionId && 'session_id' in message && message.session_id) {
          const sid = message.session_id as string;
          live.sessionId = sid;
          this.pendingLiveSessions.delete(live);
          this.liveSessions.set(sid, live);
          this.send({ type: 'session:created', sessionId: sid });
          if (live.pendingTitle) {
            const title = live.pendingTitle;
            live.pendingTitle = '';
            renameSession(sid, title).catch((err) => {
              log('renameSession failed:', err instanceof Error ? err.message : String(err));
            });
          }
        }

        const sid = live.sessionId;

        switch (message.type) {
          case 'stream_event': {
            const event = message.event as unknown as {
              type: string;
              content_block?: { type: string; name?: string };
              delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
            };

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use' && event.content_block.name) {
                currentToolName = event.content_block.name;
                currentToolInput = '';
                this.send({ type: 'agent:tool_use', sessionId: sid, toolName: currentToolName, summary: currentToolName });
              }
            }
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                this.send({ type: 'chat:stream', sessionId: sid, delta: event.delta.thinking, messageId: message.uuid, kind: 'thinking' });
              }
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                const text = event.delta.text;
                // Detect opening of XML tool blocks and suppress all content until closed
                if (/<(?:tool_call|tool_result|function_calls|antml:function_calls)[\s>]/i.test(text)) {
                  insideXmlToolBlock = true;
                  break;
                }
                if (insideXmlToolBlock) {
                  if (/<\/(?:tool_call|tool_result|function_calls|antml:function_calls)\s*>/i.test(text)) {
                    insideXmlToolBlock = false;
                  }
                  break;
                }
                if (/<\/?(?:invoke|antml:invoke|antml:parameter)[\s>]/.test(text)) break;
                if (/<parameter\s+name=/.test(text)) break;
                if (/^\s*<\/(?:parameter|invoke|function_calls)>\s*$/.test(text)) break;
                this.send({ type: 'chat:stream', sessionId: sid, delta: text, messageId: message.uuid, kind: 'text' });
              }
              if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                currentToolInput += event.delta.partial_json;
              }
            }
            if (event.type === 'content_block_stop' && currentToolName) {
              const detail = formatToolDetail(currentToolName, currentToolInput);
              if (detail) {
                this.send({ type: 'agent:tool_use', sessionId: sid, toolName: '_update_', summary: detail });
              }
              currentToolName = '';
              currentToolInput = '';
            }
            break;
          }
          case 'tool_use_summary': {
            const summary = (message as { summary: string }).summary;
            this.send({ type: 'agent:tool_use', sessionId: sid, toolName: '_update_', summary });
            break;
          }
          case 'result': {
            const r = message as Record<string, unknown>;
            const turnSid = (r.session_id as string) || sid;
            const turnMessageId = (r.uuid as string) || crypto.randomUUID();
            if (r.subtype === 'success') {
              this.send({
                type: 'chat:complete',
                sessionId: turnSid,
                result: r.result as string,
                messageId: turnMessageId,
                costUsd: r.total_cost_usd as number | undefined,
              });
              this.send({ type: 'agent:status', sessionId: turnSid, status: 'idle' });
            } else {
              this.send({ type: 'chat:error', sessionId: turnSid, error: (r.error as string) || 'Agent returned an error' });
              this.send({ type: 'agent:status', sessionId: turnSid, status: 'error' });
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      const sid = live.sessionId;
      if (live.abort.signal.aborted) {
        this.send({ type: 'chat:error', sessionId: sid, error: 'Query interrupted by user' });
      } else {
        this.send({ type: 'chat:error', sessionId: sid, error: err instanceof Error ? err.message : String(err) });
      }
      this.send({ type: 'agent:status', sessionId: sid, status: 'error' });
    } finally {
      if (live.sessionId) this.liveSessions.delete(live.sessionId);
      this.pendingLiveSessions.delete(live);
      try { live.query.close(); } catch { /* ignore */ }
    }
  }

  interruptSession(sessionId: string): boolean {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      log('Interrupting session:', sessionId);
      live.query.interrupt().catch((err) => {
        log('interrupt() failed, falling back to abort:', err instanceof Error ? err.message : String(err));
        try { live.abort.abort(); } catch { /* ignore */ }
      });
      return true;
    }
    // Fallback for the rare case interrupt arrives before sessionId is resolved.
    for (const pending of this.pendingLiveSessions) {
      log('Interrupting pending session (no canonical id yet)');
      pending.query.interrupt().catch(() => {
        try { pending.abort.abort(); } catch { /* ignore */ }
      });
      return true;
    }
    log('No active session to interrupt for:', sessionId);
    return false;
  }

  private buildPrompt(params: SendMessageParams): string {
    // User text leads so the SDK's auto-generated session summary picks up the human-readable line,
    // not the anchor metadata block (which is identical across sessions).
    const parts: string[] = [params.message];
    if (params.anchors && params.anchors.length > 0) {
      parts.push('', 'Selected elements:');
      for (let i = 0; i < params.anchors.length; i++) {
        const a = params.anchors[i];
        const rect = a.boundingRect;
        parts.push(`\nElement ${i + 1}:`);
        parts.push(`  DOM Path: ${a.domPath}`);
        if (rect) parts.push(`  Position: top=${Math.round(rect.y)}px, left=${Math.round(rect.x)}px, width=${Math.round(rect.width)}px, height=${Math.round(rect.height)}px`);
        parts.push(`  XPath: ${a.xpath}`, `  CSS: ${a.selector}`, `  HTML: ${a.htmlSnippet}`);
        if (a.textPreview) parts.push(`  Text: "${a.textPreview}"`);
      }
    }
    return parts.join('\n');
  }
}
