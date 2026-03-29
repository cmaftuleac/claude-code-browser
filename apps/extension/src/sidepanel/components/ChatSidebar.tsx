import React from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface Props {
  send: (msg: ClientMessage) => void;
}

export function ChatSidebar({ send }: Props) {
  return (
    <div className="chat-sidebar">
      <MessageList />
      <ChatInput send={send} />
    </div>
  );
}
