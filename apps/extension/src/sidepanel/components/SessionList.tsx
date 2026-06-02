import React, { useState } from 'react';
import type { ClientMessage } from '@claude-code-browser/shared';
import { useChatStore, selectActiveSessionId } from '../stores/chat-store';
import { useConnectionStore } from '../stores/connection-store';
import { MY_TAB_ID } from '../tab';

interface Props {
  send: (msg: ClientMessage) => void;
}

const ownerKey = (id: string) => `ccb-session-owner-${id}`;

export function SessionList({ send }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  // Session id currently blocked because it's open in another (still-open) tab.
  const [blockedId, setBlockedId] = useState<string | null>(null);
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore(selectActiveSessionId);
  const targetTabUrl = useConnectionStore((s) => s.targetTabUrl);
  let origin = '';
  try { origin = new URL(targetTabUrl).host; } catch { /* no pinned http(s) tab */ }
  const selectSession = useChatStore((s) => s.selectSession);

  // Claim ownership of the session for this tab, then resume. Prevents two panels
  // (two host processes) from resuming the same session and corrupting its JSONL.
  const claimAndResume = (id: string) => {
    if (MY_TAB_ID != null) chrome.storage.local.set({ [ownerKey(id)]: MY_TAB_ID });
    setBlockedId(null);
    const needsResume = selectSession(id);
    if (needsResume) send({ type: 'session:resume', sessionId: id });
  };

  const handleResume = (id: string) => {
    if (id === activeSessionId) return;
    chrome.storage.local.get(ownerKey(id), (res) => {
      const owner = res[ownerKey(id)] as number | undefined;
      if (owner == null || owner === MY_TAB_ID) { claimAndResume(id); return; }
      // Owned by another tab — only block if that tab is still open; otherwise the
      // owner is stale (tab closed) and we reclaim it.
      chrome.tabs.get(owner, (tab) => {
        if (chrome.runtime.lastError || !tab) claimAndResume(id);
        else setBlockedId(id);
      });
    });
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
          {sorted.length === 0 && (
            <div className="session-list__empty">
              {origin
                ? 'No sessions yet for this site. Start a chat to create one.'
                : 'Open a web page to see its sessions.'}
            </div>
          )}
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
          {blockedId && (
            <div className="session-list__blocked">
              <div className="session-list__blocked-msg">
                This session is open in another tab. Opening it here too can corrupt
                its history.
              </div>
              <div className="session-list__blocked-actions">
                <button
                  className="session-list__blocked-btn session-list__blocked-btn--primary"
                  onClick={() => claimAndResume(blockedId)}
                >
                  Open here anyway
                </button>
                <button className="session-list__blocked-btn" onClick={() => setBlockedId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
