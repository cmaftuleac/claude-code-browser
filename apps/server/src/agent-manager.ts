/**
 * Core orchestration — bridges user messages to the Claude Agent SDK.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ElementAnchor } from '@claude-code-browser/shared';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpManager } from './cdp-manager.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendMessageParams {
  message: string;
  sessionId?: string;
  anchors?: ElementAnchor[];
  images?: string[];  // base64 data URLs
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

// ── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Claude Code Browser, an AI assistant helping developers inspect and fix web pages.
You have access to the user's browser via Playwright MCP connected through Chrome DevTools Protocol.

CRITICAL RULES:
- The user provides a specific tab URL. ALWAYS use browser_tabs first to list tabs, find the one matching the URL, and switch to it before any interaction.
- Never interact with other tabs unless explicitly asked.
- When element selectors are provided, use them with Playwright tools to locate and inspect those exact elements.
- You can read and edit project source files if a project directory is configured.
- Always confirm before making destructive changes to source files.`;

// ── Class ────────────────────────────────────────────────────────────────────

export class AgentManager {
  private cdpManager: CdpManager;
  private projectDir: string | undefined;
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(cdpManager: CdpManager) {
    this.cdpManager = cdpManager;
  }

  setConfig(projectDir?: string, cdpPort?: number): void {
    if (projectDir) this.projectDir = projectDir;
    if (cdpPort) this.cdpManager.setPort(cdpPort);
  }

  async sendMessage(params: SendMessageParams, callbacks: StreamCallbacks): Promise<void> {
    // Save attached images to temp files so Claude can read them
    if (params.images && params.images.length > 0) {
      const imgDir = join(tmpdir(), 'ccb-images');
      await mkdir(imgDir, { recursive: true });
      const paths: string[] = [];
      for (let i = 0; i < params.images.length; i++) {
        const dataUrl = params.images[i];
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
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

    const cdpAvailable = await this.cdpManager.isAvailable();
    const mcpServers = cdpAvailable ? this.cdpManager.getMcpConfig() : undefined;
    console.log(`[agent] CDP available: ${cdpAvailable}, MCP config:`, mcpServers ? JSON.stringify(mcpServers) : 'none');

    // Temporary sessionId until SDK provides the real one
    let sessionId = params.sessionId ?? '';

    try {
      const q = query({
        prompt,
        options: {
          allowedTools: cdpAvailable
            ? ['mcp__playwright__*', 'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']
            : ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'acceptEdits',
          systemPrompt: SYSTEM_PROMPT,
          includePartialMessages: true,
          cwd,
          abortController,
          ...(mcpServers && { mcpServers }),
          ...(params.sessionId && { resume: params.sessionId }),
        },
      });

      for await (const message of q) {
        // Capture session_id from first message that has it
        if (!sessionId && 'session_id' in message && message.session_id) {
          sessionId = message.session_id as string;
          this.activeAbortControllers.set(sessionId, abortController);
          callbacks.onSessionId(sessionId);
        }

        switch (message.type) {
          case 'stream_event': {
            // SDKPartialAssistantMessage — contains BetaRawMessageStreamEvent
            const event = message.event as unknown as { type: string; delta?: { type: string; text?: string } };
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
              callbacks.onStream(event.delta.text, message.uuid);
            }
            break;
          }

          case 'tool_use_summary': {
            // SDKToolUseSummaryMessage
            const summary = (message as { summary: string }).summary;
            callbacks.onToolUse('tool', summary);
            break;
          }

          case 'result': {
            // SDKResultMessage (success or error)
            const result = message as Record<string, unknown>;
            const resolvedSessionId = (result.session_id as string) || sessionId;

            if (result.subtype === 'success') {
              callbacks.onComplete(
                result.result as string,
                resolvedSessionId,
                result.total_cost_usd as number | undefined,
              );
            } else {
              callbacks.onError((result.error as string) || 'Agent returned an error');
            }
            break;
          }

          // Ignore other message types (system, status, auth, etc.)
        }
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        callbacks.onError('Query interrupted by user');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        callbacks.onError(message);
      }
    } finally {
      if (sessionId) {
        this.activeAbortControllers.delete(sessionId);
      }
    }
  }

  interruptSession(sessionId: string): boolean {
    const controller = this.activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(sessionId);
      return true;
    }
    return false;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private buildPrompt(params: SendMessageParams): string {
    const parts: string[] = [];

    if (params.url) {
      parts.push(`I'm working on this specific browser tab: ${params.url}`);
      parts.push('IMPORTANT: Use browser_tabs to find this exact tab by URL, then switch to it before interacting. Do NOT use other tabs.');
    }

    if (params.anchors && params.anchors.length > 0) {
      parts.push('');
      parts.push('Selected elements:');
      for (let i = 0; i < params.anchors.length; i++) {
        const a = params.anchors[i];
        const rect = a.boundingRect;
        parts.push(`\nElement ${i + 1}:`);
        parts.push(`  DOM Path: ${a.domPath}`);
        if (rect) {
          parts.push(`  Position: top=${Math.round(rect.y)}px, left=${Math.round(rect.x)}px, width=${Math.round(rect.width)}px, height=${Math.round(rect.height)}px`);
        }
        parts.push(`  XPath: ${a.xpath}`);
        parts.push(`  CSS: ${a.selector}`);
        parts.push(`  HTML: ${a.htmlSnippet}`);
        if (a.textPreview) {
          parts.push(`  Text: "${a.textPreview}"`);
        }
      }
      parts.push('\nUse the xpath or CSS selectors to locate these elements.');
    }

    if (params.images && params.images.length > 0) {
      parts.push('');
      parts.push(`[${params.images.length} image(s) attached — see below]`);
    }

    parts.push('');
    parts.push(params.message);

    return parts.join('\n');
  }
}
