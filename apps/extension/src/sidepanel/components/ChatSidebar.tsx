import React from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore, selectActiveTitle } from '../stores/chat-store';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ReviewPrompt } from './ReviewPrompt';

interface Props {
  send: (msg: ClientMessage) => void;
}

export function ChatSidebar({ send }: Props) {
  // Pinned above the scrolling message list; works for new/pending chats too.
  const title = useChatStore(selectActiveTitle);

  return (
    <div className="chat-sidebar">
      {title && (
        <div className="chat-sidebar__session-title" title={title}>{title}</div>
      )}
      <MessageList />
      <ReviewPrompt />
      <ChatInput send={send} />
    </div>
  );
}
