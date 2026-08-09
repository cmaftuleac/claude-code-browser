import React from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore, selectActiveTitle, selectActivePhase } from '../stores/chat-store';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ReviewPrompt } from './ReviewPrompt';
import { TodoPanel } from './TodoPanel';

interface Props {
  send: (msg: ClientMessage) => void;
}

const PHASE_LABEL: Record<'compacting' | 'requesting', string> = {
  compacting: 'Compacting the conversation…',
  requesting: 'Waiting for the model…',
};

export function ChatSidebar({ send }: Props) {
  // Pinned above the scrolling message list; works for new/pending chats too.
  const title = useChatStore(selectActiveTitle);
  // Both phases are silent stretches with no tokens arriving — without a line here
  // they are indistinguishable from a hung session.
  const phase = useChatStore(selectActivePhase);

  return (
    <div className="chat-sidebar">
      {title && (
        <div className="chat-sidebar__session-title" title={title}>{title}</div>
      )}
      <TodoPanel />
      {phase && <div className="chat-sidebar__phase">{PHASE_LABEL[phase]}</div>}
      <MessageList />
      <ReviewPrompt />
      <ChatInput send={send} />
    </div>
  );
}
