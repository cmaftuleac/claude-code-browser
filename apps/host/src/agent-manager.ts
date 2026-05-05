/**
 * Core orchestration — bridges user messages to the Claude Agent SDK.
 */

import { query, renameSession } from '@anthropic-ai/claude-agent-sdk';
import type { ElementAnchor } from '@claude-code-browser/shared';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { log } from './native-io.js';

/** Find the SDK's cli.js — a Node.js script version of Claude Code.
 *  We run this under Node.js instead of the Bun-compiled binary to avoid
 *  Gatekeeper blocking native .node addon extraction from Chrome context. */
function findClaudeCliJs(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('Claude Agent SDK cli.js not found');
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

export interface StreamCallbacks {
  onSessionId: (sessionId: string) => void;
  onStream: (delta: string, messageId: string) => void;
  onThinking: (delta: string, messageId: string) => void;
  onToolUse: (toolName: string, summary: string) => void;
  onComplete: (result: string, sessionId: string, costUsd?: number) => void;
  onError: (error: string) => void;
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

export class AgentManager {
  private ipcServer: NetServer | null = null;
  private ipcPort = 0;
  private ipcClients = new Set<Socket>();
  private projectDir: string | undefined;
  private activeAbortControllers = new Map<string, AbortController>();
  private currentAbortController: AbortController | null = null;
  private browserCliPath: string;

  constructor(private onBrowserRequest: (requestId: string, action: string, params: Record<string, unknown>) => void) {
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
      // Write port to well-known file so browser-cli can find it (survives session resume)
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

  async sendMessage(params: SendMessageParams, callbacks: StreamCallbacks): Promise<void> {
    // Capture the user's clean text before image-attachment lines get appended below.
    // Used to set a stable customTitle on brand-new sessions.
    const isNewSession = !params.sessionId;
    const userTitleText = params.message.trim().slice(0, 80);

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

    const prompt = this.buildPrompt(params);
    const cwd = params.projectDir ?? this.projectDir ?? params.sources?.[0] ?? process.cwd();
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    let sessionId = params.sessionId ?? '';
    let currentToolName = '';
    let currentToolInput = '';
    let insideXmlToolBlock = false;

    try {
      const q = query({
        prompt,
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

      for await (const message of q) {
        if (!sessionId && 'session_id' in message && message.session_id) {
          sessionId = message.session_id as string;
          this.activeAbortControllers.set(sessionId, abortController);
          callbacks.onSessionId(sessionId);
          // For brand-new sessions, set a customTitle from the user's clean text so
          // the session list shows a meaningful, distinct title regardless of prompt prefix.
          if (isNewSession && userTitleText) {
            renameSession(sessionId, userTitleText).catch((err) => {
              log('renameSession failed:', err instanceof Error ? err.message : String(err));
            });
          }
        }

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
                callbacks.onToolUse(currentToolName, currentToolName);
              }
            }
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                callbacks.onThinking(event.delta.thinking, message.uuid);
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
                callbacks.onStream(text, message.uuid);
              }
              if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                currentToolInput += event.delta.partial_json;
              }
            }
            if (event.type === 'content_block_stop' && currentToolName) {
              // Parse accumulated input and build a detail string
              const detail = formatToolDetail(currentToolName, currentToolInput);
              if (detail) {
                callbacks.onToolUse('_update_', detail);
              }
              currentToolName = '';
              currentToolInput = '';
            }
            break;
          }
          case 'tool_use_summary': {
            const summary = (message as { summary: string }).summary;
            callbacks.onToolUse('_update_', summary);
            break;
          }
          case 'result': {
            const r = message as Record<string, unknown>;
            const sid = (r.session_id as string) || sessionId;
            if (r.subtype === 'success') {
              callbacks.onComplete(r.result as string, sid, r.total_cost_usd as number | undefined);
            } else {
              callbacks.onError((r.error as string) || 'Agent returned an error');
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        callbacks.onError('Query interrupted by user');
      } else {
        callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (sessionId) this.activeAbortControllers.delete(sessionId);
      this.currentAbortController = null;
    }
  }

  interruptSession(sessionId: string): boolean {
    // Try by session ID first
    const c = this.activeAbortControllers.get(sessionId);
    if (c) {
      log('Interrupting session:', sessionId);
      c.abort();
      this.activeAbortControllers.delete(sessionId);
      return true;
    }
    // Fallback: abort whatever is currently running
    if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
      log('Interrupting current query (session ID mismatch, requested:', sessionId, ')');
      this.currentAbortController.abort();
      return true;
    }
    log('No active query to interrupt for session:', sessionId);
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
