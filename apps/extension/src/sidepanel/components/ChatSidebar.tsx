import React from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore } from '../stores/chat-store';
import { MessageList } from './MessageList';
import { MessageQueue } from './MessageQueue';
import { ChatInput } from './ChatInput';
import { ReviewPrompt } from './ReviewPrompt';

interface Props {
  send: (msg: ClientMessage) => void;
}

export function ChatSidebar({ send }: Props) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="chat-sidebar">
      {session && (
        <div className="chat-sidebar__session-title">{session.title}</div>
      )}
      <MessageList />
      <MessageQueue />
      <ReviewPrompt />
      <ChatInput send={send} />
    </div>
  );
}
