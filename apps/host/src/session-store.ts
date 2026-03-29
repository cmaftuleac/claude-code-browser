/**
 * Session listing and message retrieval via the Claude Agent SDK.
 */

import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionInfo, SessionMessage } from '@claude-code-browser/shared';

export class SessionStore {
  async getSessions(): Promise<SessionInfo[]> {
    try {
      const sessions = await listSessions({ limit: 50 });
      return sessions.map((s) => ({
        id: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt?.slice(0, 80) || `Session ${s.sessionId.slice(0, 8)}`,
        lastModified: s.lastModified,
        cwd: s.cwd,
      }));
    } catch (err) {
      return [];
    }
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    try {
      const raw = await getSessionMessages(sessionId, { limit: 100 });
      const messages: SessionMessage[] = [];
      for (const entry of raw) {
        const text = extractTextContent(entry.message);
        if (!text) continue;
        messages.push({
          role: entry.type === 'user' ? 'user' : 'assistant',
          content: text,
        });
      }
      return messages;
    } catch {
      return [];
    }
  }
}

function extractTextContent(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          const text = (b.text as string).trim();
          if (text.startsWith('<ide_') || text.startsWith('<system-reminder>')) continue;
          parts.push(text);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}
