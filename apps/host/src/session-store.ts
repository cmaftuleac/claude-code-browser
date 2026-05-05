/**
 * Session listing and message retrieval via the Claude Agent SDK.
 */

import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionInfo, SessionMessage, SessionMessageBlock } from '@claude-code-browser/shared';

export class SessionStore {
  async getSessions(): Promise<SessionInfo[]> {
    try {
      const sessions = await listSessions({ limit: 50 });
      return sessions.map((s) => {
        // Prefer firstPrompt (literal first user message, multi-line preserved) over
        // summary (often newline-collapsed, which defeats line-based metadata stripping).
        // Order: user-set title → first prompt → summary → id fallback.
        const fromFirst = stripPromptPrefix(s.firstPrompt ?? '').slice(0, 80);
        const fromSummary = stripPromptPrefix(s.summary ?? '').slice(0, 80);
        const title =
          s.customTitle ||
          fromFirst ||
          fromSummary ||
          `Session ${s.sessionId.slice(0, 8)}`;
        return {
          id: s.sessionId,
          title,
          lastModified: s.lastModified,
          cwd: s.cwd,
        };
      });
    } catch (err) {
      return [];
    }
  }

  async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    try {
      // No limit — load the full session. Claude Code handles compaction itself.
      const raw = await getSessionMessages(sessionId);
      const messages: SessionMessage[] = [];
      for (const entry of raw) {
        const blocks = extractBlocks(entry.message);
        // Synthetic user turns (tool_result-only) are intentionally hidden.
        // Assistant turns whose text was all filtered (system/IDE) are kept so the conversation flow stays intact.
        if (blocks.length === 0 && entry.type === 'user') continue;
        // Flat content = all text blocks joined
        let textContent = blocks
          .filter((b) => b.kind === 'text')
          .map((b) => b.content)
          .join('\n');
        // For user messages, strip the buildPrompt() prefix (URL, elements, etc.)
        if (entry.type === 'user') {
          textContent = stripPromptPrefix(textContent);
        }
        messages.push({
          role: entry.type === 'user' ? 'user' : 'assistant',
          content: textContent || blocks[0]?.content || '',
          blocks: entry.type === 'assistant' ? blocks : undefined,
        });
      }
      return messages;
    } catch {
      return [];
    }
  }
}

/** Strip the buildPrompt() metadata lines from user messages to recover the user's actual text.
 *  Works for both old (metadata-first) and new (user-first) prompt orderings — it filters
 *  metadata lines wherever they appear. Returns '' when everything is metadata. */
function stripPromptPrefix(text: string): string {
  const isMetadata = (l: string): boolean =>
    l.startsWith("I'm working on the page:") ||
    l.startsWith('Selected elements:') ||
    l.startsWith('Element ') ||
    l.startsWith('  DOM Path:') || l.startsWith('  XPath:') ||
    l.startsWith('  CSS:') || l.startsWith('  HTML:') ||
    l.startsWith('  Text:') || l.startsWith('  Position:') ||
    l.startsWith('Use the xpath') ||
    (l.startsWith('[') && l.includes('image(s) attached'));
  const userLines = text.split('\n').filter((l) => !isMetadata(l));
  return userLines.join('\n').trim();
}

function extractBlocks(message: unknown): SessionMessageBlock[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (typeof content === 'string') {
    return [{ kind: 'text', content }];
  }

  if (!Array.isArray(content)) return [];

  const blocks: SessionMessageBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      const text = (b.thinking as string).trim();
      if (text) blocks.push({ kind: 'thinking', content: text });
    } else if (b.type === 'text' && typeof b.text === 'string') {
      const text = (b.text as string).trim();
      // Skip system/IDE injected content
      if (text && !text.startsWith('<ide_') && !text.startsWith('<system-reminder>')) {
        blocks.push({ kind: 'text', content: text });
      }
    } else if (b.type === 'tool_use') {
      const name = (b.name as string) ?? 'tool';
      const input = b.input as Record<string, unknown> | undefined;
      let detail = name;
      if (input) {
        switch (name) {
          case 'Bash': detail = `Running Bash command\n\`\`\`\n${input.command}\n\`\`\``; break;
          case 'Read': detail = `Reading file\n\`${input.file_path}\``; break;
          case 'Edit': detail = `Editing file\n\`${input.file_path}\``; break;
          case 'Write': detail = `Writing file\n\`${input.file_path}\``; break;
          case 'Grep': detail = `Searching for \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`; break;
          case 'Glob': detail = `Finding files \`${input.pattern}\`${input.path ? ` in \`${input.path}\`` : ''}`; break;
          default: {
            if (name.startsWith('browser_')) { detail = `Running ${name.replace('_', ' ')}`; break; }
            const firstVal = Object.values(input)[0];
            if (firstVal && typeof firstVal === 'string') detail = `${name}: ${String(firstVal).slice(0, 120)}`;
          }
        }
      }
      blocks.push({ kind: 'tool_use', content: detail });
    }
  }
  return blocks;
}
