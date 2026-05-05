import React, { useState } from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore } from '../stores/chat-store';

interface Props {
  send: (msg: ClientMessage) => void;
}

export function SessionList({ send }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const handleResume = (id: string) => {
    if (id === activeSessionId) return;
    selectSession(id);
    send({ type: 'session:resume', sessionId: id });
  };

  const sorted = [...sessions].sort((a, b) => b.lastModified - a.lastModified);

  return (
    <div className="session-list">
      <button className="session-list__toggle" onClick={() => setCollapsed(!collapsed)}>
        <span className="session-list__arrow">{collapsed ? '\u25B6' : '\u25BC'}</span>
        Sessions ({sessions.length})
      </button>

      {!collapsed && (
        <div className="session-list__items">
          {sorted.map((session) => {
            const d = new Date(session.lastModified);
            const date = d.toLocaleDateString();
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return (
              <button
                key={session.id}
                className={`session-list__item ${session.id === activeSessionId ? 'session-list__item--active' : ''}`}
                onClick={() => handleResume(session.id)}
              >
                <span className="session-list__title" title={session.title}>
                  {(session.title || 'Untitled').slice(0, 60)}
                </span>
                <span className="session-list__date">
                  {date} {time}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
