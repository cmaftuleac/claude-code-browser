import React, { useEffect, useRef } from 'react';
import { useChatStore, selectActiveMessages } from '../stores/chat-store';
import { MessageBubble } from './MessageBubble';
import { ErrorBoundary } from './ErrorBoundary';

const STICK_THRESHOLD_PX = 40;

export function MessageList() {
  const messages = useChatStore(selectActiveMessages);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && (
        <div className="message-list__empty">
          No messages yet. Start a conversation or pick an element on the page.
        </div>
      )}
      {messages.map((msg) => (
        // One boundary per message: a single un-renderable message (e.g. bad
        // markdown/KaTeX) degrades to an inline notice instead of blanking the
        // whole chat. resetKeys re-tries as the content streams in.
        <ErrorBoundary
          key={msg.id}
          label="Message"
          resetKeys={[msg.content, msg.isStreaming]}
          fallback={
            <div className="message-bubble message-bubble--system">
              ⚠ This message could not be displayed.
            </div>
          }
        >
          <MessageBubble message={msg} />
        </ErrorBoundary>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
