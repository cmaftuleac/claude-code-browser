import React, { useState } from 'react';
import { useChatStore, selectActiveTodos } from '../stores/chat-store';

/** The agent's plan checklist (TodoWrite), pinned under the session title.
 *
 *  Collapsed to the active item by default — on a long plan the interesting line is
 *  "what is it doing right now", and the full list would push the conversation off
 *  screen in a side panel this narrow. */
export function TodoPanel() {
  const todos = useChatStore(selectActiveTodos);
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  // Fall back to the first unfinished item: the CLI briefly has no in_progress item
  // between finishing one and starting the next, and a blank row there reads as a stall.
  const headline = active?.activeForm || active?.content
    || todos.find((t) => t.status !== 'completed')?.content
    || 'All steps complete';

  return (
    <div className="todo-panel">
      <button className="todo-panel__head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="todo-panel__arrow">{open ? '▾' : '▸'}</span>
        <span className="todo-panel__headline">{headline}</span>
        <span className="todo-panel__count">{done}/{todos.length}</span>
      </button>
      {open && (
        <ol className="todo-panel__list">
          {todos.map((t, i) => (
            <li key={`${i}-${t.content}`} className={`todo-panel__item todo-panel__item--${t.status}`}>
              <span className="todo-panel__mark" aria-hidden="true">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className="todo-panel__text">{t.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
