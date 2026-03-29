/**
 * Core orchestration — bridges user messages to the Claude Agent SDK.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ElementAnchor } from '@claude-code-browser/shared';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { log } from './native-io.js';

function findClaudeExecutable(): string | undefined {
  // Check common locations since Chrome launches with minimal PATH
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    join(homedir(), '.npm-global', 'bin', 'claude'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH as fallback
  try {
    return execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface SendMessageParams {
  message: string;
  sessionId?: string;
  anchors?: ElementAnchor[];
  images?: string[];
  url: string;
  projectDir?: string;
}

export interface StreamCallbacks {
  onSessionId: (sessionId: string) => void;
  onStream: (delta: string, messageId: string) => void;
  onToolUse: (toolName: string, summary: string) => void;
  onComplete: (result: string, sessionId: string, costUsd?: number) => void;
  onError: (error: string) => void;
}

const SYSTEM_PROMPT = `You are Claude Code Browser, an AI assistant helping developers inspect and fix web pages.
You have direct access to the user's browser tab via custom browser tools (browser_navigate, browser_snapshot, browser_screenshot, browser_click, browser_evaluate).

CRITICAL RULES:
- The user provides a specific tab URL. The browser tools operate on the active tab in their Chrome browser.
- Use browser_snapshot to see the page structure before making changes.
- Use browser_screenshot to see the visual state of the page.
- When element selectors are provided, use browser_click or browser_evaluate to interact with those elements.
- You can read and edit project source files if a project directory is configured.
- Always confirm before making destructive changes to source files.`;

export class AgentManager {
  private browserToolsConfig: ReturnType<typeof import('./browser-tools.js').createBrowserTools> extends infer T ? T : never;
  private projectDir: string | undefined;
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(browserTools: unknown) {
    this.browserToolsConfig = browserTools as typeof this.browserToolsConfig;
  }

  setConfig(projectDir?: string): void {
    if (projectDir) this.projectDir = projectDir;
  }

  async sendMessage(params: SendMessageParams, callbacks: StreamCallbacks): Promise<void> {
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
    const cwd = params.projectDir ?? this.projectDir ?? process.cwd();
    const abortController = new AbortController();

    let sessionId = params.sessionId ?? '';

    try {
      const q = query({
        prompt,
        options: {
          allowedTools: [
            'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
            'mcp__browser__browser_navigate',
            'mcp__browser__browser_snapshot',
            'mcp__browser__browser_screenshot',
            'mcp__browser__browser_click',
            'mcp__browser__browser_evaluate',
          ],
          permissionMode: 'bypassPermissions',
          pathToClaudeCodeExecutable: findClaudeExecutable(),
          systemPrompt: SYSTEM_PROMPT,
          includePartialMessages: true,
          cwd,
          abortController,
          mcpServers: { browser: this.browserToolsConfig },
          ...(params.sessionId && { resume: params.sessionId }),
        },
      });

      for await (const message of q) {
        if (!sessionId && 'session_id' in message && message.session_id) {
          sessionId = message.session_id as string;
          this.activeAbortControllers.set(sessionId, abortController);
          callbacks.onSessionId(sessionId);
        }

        switch (message.type) {
          case 'stream_event': {
            const event = message.event as unknown as { type: string; delta?: { type: string; text?: string } };
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              callbacks.onStream(event.delta.text, message.uuid);
            }
            break;
          }
          case 'tool_use_summary':
            callbacks.onToolUse('tool', (message as { summary: string }).summary);
            break;
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
    }
  }

  interruptSession(sessionId: string): boolean {
    const c = this.activeAbortControllers.get(sessionId);
    if (c) { c.abort(); this.activeAbortControllers.delete(sessionId); return true; }
    return false;
  }

  private buildPrompt(params: SendMessageParams): string {
    const parts: string[] = [];
    if (params.url) {
      parts.push(`I'm working on the page: ${params.url}`);
    }
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
      parts.push('\nUse the xpath or CSS selectors to locate these elements.');
    }
    if (params.images && params.images.length > 0) {
      parts.push('', `[${params.images.length} image(s) attached — see below]`);
    }
    parts.push('', params.message);
    return parts.join('\n');
  }
}
