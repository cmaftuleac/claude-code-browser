import React, { useState } from 'react';
import { Markdown } from '../lib/markdown';
import { useChatStore, type ChatMessage } from '../stores/chat-store';
import type { ElementAnchor } from '@fineguide-tesseract/shared';

interface Props {
  message: ChatMessage;
}

/** Most human-relevant line from a tool's input (command / file path / …). */
function describePermissionInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'plan', 'file_path', 'path', 'pattern', 'url']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  try { const j = JSON.stringify(input); return j && j !== '{}' ? j : ''; } catch { return ''; }
}

/** In-chat tool-approval card (agent:permission_request). Interactive until decided. */
function PermissionBubble({ message }: Props) {
  const respond = useChatStore((s) => s.respondPermission);
  const p = message.permission;
  if (!p) return null;
  const decided = p.decided;
  const headline = p.title || `Allow ${p.displayName || p.toolName}?`;
  const detail = describePermissionInput(p.input);
  return (
    <div className={`perm-card ${decided ? 'perm-card--decided' : ''}`}>
      <div className="perm-card__title">{headline}</div>
      {p.description && <div className="perm-card__desc">{p.description}</div>}
      {detail && <pre className="perm-card__detail">{detail}</pre>}
      {!decided ? (
        <div className="perm-card__actions">
          <button className="perm-card__btn perm-card__btn--allow" onClick={() => respond(p.requestId, { behavior: 'allow' })}>Allow</button>
          <button className="perm-card__btn" onClick={() => respond(p.requestId, { behavior: 'allow', persist: true })}>Allow &amp; don&apos;t ask again</button>
          <button className="perm-card__btn perm-card__btn--deny" onClick={() => respond(p.requestId, { behavior: 'deny' })}>Deny</button>
        </div>
      ) : (
        <div className="perm-card__resolved">{decided === 'allow' ? 'Allowed' : decided === 'deny' ? 'Denied' : 'No longer needed'}</div>
      )}
    </div>
  );
}

/** Render content with inline element chips for user messages */
function renderUserContent(content: string, anchors?: ElementAnchor[]) {
  if (!anchors || anchors.length === 0) {
    return <span>{content}</span>;
  }

  const parts: React.ReactNode[] = [];
  let remaining = content;
  let key = 0;

  for (const anchor of anchors) {
    const token = `<${anchor.tagName}>`;
    const idx = remaining.indexOf(token);
    if (idx >= 0) {
      if (idx > 0) {
        parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      }
      parts.push(
        <span key={key++} className="inline-chip inline-chip--history" title={anchor.domPath}>
          <span className="inline-chip__icon">{'\u29BE'}</span>
          <span className="inline-chip__label">&lt;{anchor.tagName}&gt;</span>
        </span>
      );
      remaining = remaining.slice(idx + token.length);
    }
  }

  if (remaining) {
    parts.push(<span key={key++}>{remaining}</span>);
  }

  return <>{parts}</>;
}

function ThinkingBubble({ message }: Props) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  // Open while streaming, collapse when done — unless user manually toggled
  const expanded = manualToggle !== null ? manualToggle : message.isStreaming === true;

  return (
    <div className="message-bubble message-bubble--thinking" onClick={() => setManualToggle(!expanded)}>
      <div className="message-bubble__thinking-header">
        <span className="message-bubble__thinking-icon">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span>Thinking{message.isStreaming ? '...' : ''}</span>
      </div>
      {expanded && (
        <div className="message-bubble__thinking-content">
          {message.content}
        </div>
      )}
    </div>
  );
}

function ToolUseBubble({ message }: Props) {
  return (
    <div className="message-bubble message-bubble--tool-use">
      <span className="message-bubble__tool-icon">{'\u2692'}</span>
      <div className="message-bubble__tool-detail">
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isInterrupted = isSystem && message.content === '_interrupted_';

  if (isInterrupted) {
    return <div className="message-bubble message-bubble--interrupted">interrupted</div>;
  }

  if (message.kind === 'thinking') {
    return <ThinkingBubble message={message} />;
  }

  if (message.kind === 'tool_use') {
    return <ToolUseBubble message={message} />;
  }

  if (message.kind === 'permission') {
    return <PermissionBubble message={message} />;
  }

  return (
    <div
      className={`message-bubble ${isUser ? 'message-bubble--user' : isSystem ? 'message-bubble--system' : 'message-bubble--assistant'}`}
    >
      {message.images && message.images.length > 0 && (
        <div className="message-bubble__images">
          {message.images.map((src, i) => (
            <img key={i} src={src} alt="Attached" className="message-bubble__image" />
          ))}
        </div>
      )}
      <div className="message-bubble__content">
        {isUser ? (
          renderUserContent(message.content, message.anchors)
        ) : (
          <Markdown>{message.content}</Markdown>
        )}
      </div>
    </div>
  );
}
