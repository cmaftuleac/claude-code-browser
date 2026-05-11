import React from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore, selectActiveSessionId } from '../stores/chat-store';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ReviewPrompt } from './ReviewPrompt';

interface Props {
  send: (msg: ClientMessage) => void;
}

export function ChatSidebar({ send }: Props) {
  const activeSessionId = useChatStore(selectActiveSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const session = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;

  return (
    <div className="chat-sidebar">
      {session && (
        <div className="chat-sidebar__session-title">{session.title}</div>
      )}
      <MessageList />
      <ReviewPrompt />
      <ChatInput send={send} />
    </div>
  );
}
