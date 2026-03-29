import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../stores/chat-store';

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

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

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
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
