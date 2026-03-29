import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../stores/chat-store';
import type { ElementAnchor } from '@claude-code-browser/shared';

interface Props {
  message: ChatMessage;
}

const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        if (href) chrome.tabs.create({ url: href });
      }}
    >
      {children}
    </a>
  ),
};

/** Render content with inline element chips for user messages */
function renderUserContent(content: string, anchors?: ElementAnchor[]) {
  if (!anchors || anchors.length === 0) {
    return <span>{content}</span>;
  }

  // Replace <tagName> tokens with chips
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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isInterrupted = isSystem && message.content === '_interrupted_';

  if (isInterrupted) {
    return <div className="message-bubble message-bubble--interrupted">interrupted</div>;
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {message.content}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
