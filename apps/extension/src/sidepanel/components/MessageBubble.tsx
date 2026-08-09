import React, { useMemo, useState } from 'react';
import { Markdown } from '../lib/markdown';
import { useChatStore, parseQuestions, type ChatMessage, type AgentQuestion } from '../stores/chat-store';
import type { ElementAnchor } from '@claude-code-browser/shared';

interface Props {
  message: ChatMessage;
}

/** Most human-relevant line from a tool's input (command / file path / …). */
function describePermissionInput(input: Record<string, unknown>): string {
  // `detail` first: an auto-decision card carries the host's already-condensed
  // one-liner under that key, and without it here the card rendered the literal
  // JSON ({"detail":"npm test"}) via the fallback below.
  for (const key of ['detail', 'command', 'plan', 'file_path', 'path', 'pattern', 'url']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  try { const j = JSON.stringify(input); return j && j !== '{}' ? j : ''; } catch { return ''; }
}

/** Open a plan in its own popup window, for when a long plan outgrows the panel.
 *  The text goes through chrome.storage.local under a one-shot key rather than the
 *  URL — plans routinely exceed a safe query-string length. */
function openPlanWindow(plan: string): void {
  const key = `ccb-plan-${crypto.randomUUID()}`;
  chrome.storage.local.set({ [key]: plan }, () => {
    const url = chrome.runtime.getURL(`plan.html?k=${encodeURIComponent(key)}`);
    // `type: 'popup'` gives a chromeless window (no tab strip / address bar).
    chrome.windows.create({ url, type: 'popup', width: 760, height: 900 }, () => {
      // If the window never opened, the key would linger in storage forever.
      if (chrome.runtime.lastError) chrome.storage.local.remove(key);
    });
  });
}

/** In-chat tool-approval card (agent:permission_request). Interactive until decided. */
function PermissionBubble({ message }: Props) {
  const respond = useChatStore((s) => s.respondPermission);
  const setRunMode = useChatStore((s) => s.setRunMode);
  const p = message.permission;
  if (!p) return null;
  const decided = p.decided;
  const headline = p.title || `Allow ${p.displayName || p.toolName}?`;
  // A plan is prose, not a command: it is markdown (headings, bullets, code spans)
  // and can run to dozens of lines. Rendering it through the monospace <pre> used
  // for commands showed raw markup hard-wrapped in a 150px box. Detected by the
  // `plan` input rather than the tool name so it also covers any other tool that
  // asks for approval of a written plan.
  const plan = typeof p.input.plan === 'string' && p.input.plan.trim() ? p.input.plan : null;
  const detail = plan ? '' : describePermissionInput(p.input);
  // "Allow and continue" = approve this call AND put THIS conversation into Bypass, so
  // nothing else is asked in it. It replaced "don't ask again", which only persisted a
  // rule for this one kind of call — a blanket promise it never made — and which is
  // meaningless on a plan card, since the next plan is a different plan. setRunMode is
  // scoped to the active conversation, so other chats keep the mode they were given.
  const allowAndContinue = () => {
    // Only un-gate the conversation if the approval actually reached the host. On a
    // dead port `respond` leaves the card live (correct), and flipping the mode anyway
    // would silently disable prompting for a click that visibly did nothing.
    if (respond(p.requestId, { behavior: 'allow' })) {
      setRunMode({ permissionMode: 'bypassPermissions' });
    }
  };
  return (
    <div className={`perm-card ${plan ? 'perm-card--plan' : ''} ${decided ? 'perm-card--decided' : ''}`}>
      <div className="perm-card__title">{headline}</div>
      {p.description && <div className="perm-card__desc">{p.description}</div>}
      {plan && (
        <>
          <div className="perm-card__plan"><Markdown>{plan}</Markdown></div>
          <button className="perm-card__expand" onClick={() => openPlanWindow(plan)}>
            Open in window ↗
          </button>
        </>
      )}
      {detail && <pre className="perm-card__detail">{detail}</pre>}
      {!decided ? (
        <div className="perm-card__actions">
          <button className="perm-card__btn perm-card__btn--allow" onClick={() => respond(p.requestId, { behavior: 'allow' })}>Allow</button>
          <button className="perm-card__btn" title="Allow this, then stop asking for the rest of this conversation" onClick={allowAndContinue}>Allow and continue</button>
          <button className="perm-card__btn perm-card__btn--deny" onClick={() => respond(p.requestId, { behavior: 'deny' })}>Deny</button>
        </div>
      ) : (
        <div className="perm-card__resolved">
          {decided === 'allow' ? 'Allowed'
            : decided === 'deny' ? 'Denied'
            : decided === 'auto' ? 'Auto-approved (unattended)'
            : 'No longer needed'}
        </div>
      )}
    </div>
  );
}

/** The agent asking the user to choose (AskUserQuestion). Unlike an approval card
 *  there is nothing to "allow" — the user's selections ARE the tool's result, so the
 *  card collects one answer per question and sends them together. */
function QuestionBubble({ message }: Props) {
  const answerQuestion = useChatStore((s) => s.answerQuestion);
  const respond = useChatStore((s) => s.respondPermission);
  const p = message.permission;
  const questions = useMemo(() => (p ? parseQuestions(p.input) : []), [p]);
  // Keyed by question INDEX, not text: two questions may legitimately share the same
  // text (that is what `header` disambiguates), and keying by it made them share one
  // answer slot — selecting an option for the first marked the second answered too,
  // and the agent received the first one's choice for both.
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  if (!p) return null;
  const decided = p.decided;

  // A malformed payload would otherwise render an unanswerable card that blocks the
  // turn — let the user dismiss it instead of trapping them.
  if (questions.length === 0) {
    return (
      <div className="question-card">
        <div className="question-card__title">The agent asked a question we couldn&apos;t read.</div>
        {!decided && (
          <div className="perm-card__actions">
            <button className="perm-card__btn perm-card__btn--deny" onClick={() => respond(p.requestId, { behavior: 'deny' })}>Dismiss</button>
          </div>
        )}
      </div>
    );
  }

  const toggle = (i: number, q: AgentQuestion, label: string) => {
    setPicked((prev) => {
      const cur = prev[i] ?? [];
      if (!q.multiSelect) return { ...prev, [i]: [label] };
      return { ...prev, [i]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });
  };

  const answered = questions.every((_q, i) => (picked[i]?.length ?? 0) > 0);
  // The wire format is keyed by question text (the tool's schema), so collapse to it
  // only at submit time. Identical texts merge there, which is the schema's own limit.
  const submit = () => answerQuestion(
    p.requestId,
    Object.fromEntries(questions.map((q, i) => [q.question, picked[i] ?? []])),
  );

  return (
    <div className={`question-card ${decided ? 'question-card--decided' : ''}`}>
      {questions.map((q, i) => (
        <div className="question-card__q" key={`${i}-${q.question}`}>
          {q.header && <div className="question-card__header">{q.header}</div>}
          <div className="question-card__title">{q.question}</div>
          <div className="question-card__options">
            {q.options.map((o) => {
              const chosen = (decided ? p.answers?.[q.question] ?? [] : picked[i] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  className={`question-card__opt ${chosen ? 'is-on' : ''}`}
                  disabled={!!decided}
                  aria-pressed={chosen}
                  onClick={() => toggle(i, q, o.label)}
                >
                  <span className="question-card__opt-label">{o.label}</span>
                  {o.description && <span className="question-card__opt-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {q.multiSelect && !decided && <div className="question-card__hint">Choose one or more</div>}
        </div>
      ))}
      {!decided ? (
        <div className="perm-card__actions">
          <button className="perm-card__btn perm-card__btn--allow" disabled={!answered} onClick={submit}>
            {answered ? 'Send answer' : 'Pick an option'}
          </button>
          <button className="perm-card__btn perm-card__btn--deny" onClick={() => respond(p.requestId, { behavior: 'deny' })}>Skip</button>
        </div>
      ) : (
        <div className="perm-card__resolved">
          {decided === 'allow' ? 'Answered'
            : decided === 'auto' ? 'Auto-answered (unattended)'
            : decided === 'deny' ? 'Skipped'
            : 'No longer needed'}
        </div>
      )}
    </div>
  );
}

/** A subagent (Task tool) card, updated in place as the task runs. */
function TaskBubble({ message }: Props) {
  const t = message.task;
  if (!t) return null;
  const icon = t.status === 'running' ? '◐' : t.status === 'completed' ? '✓' : '✗';
  return (
    <div className={`task-card task-card--${t.status}`}>
      <div className="task-card__head">
        <span className={`task-card__icon ${t.status === 'running' ? 'task-card__icon--spin' : ''}`}>{icon}</span>
        <span className="task-card__desc">{t.description}</span>
        {t.subagentType && <span className="task-card__type">{t.subagentType}</span>}
      </div>
      {t.status === 'running' && t.lastToolName && <div className="task-card__sub">{t.lastToolName}…</div>}
      {t.summary && <div className="task-card__summary"><Markdown>{t.summary}</Markdown></div>}
    </div>
  );
}

/** Render content with inline element chips for user messages */
function renderUserContent(content: string, anchors?: ElementAnchor[]) {
  if (!anchors || anchors.length === 0) {
    return <span>{content}</span>;
  }

  const parts: React.ReactNode[] = [];
  let remaining = content;
  let key = 0;

  for (const anchor of anchors) {
    const token = `<${anchor.tagName}>`;
    const idx = remaining.indexOf(token);
    if (idx >= 0) {
      if (idx > 0) {
        parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      }
      parts.push(
        <span key={key++} className="inline-chip inline-chip--history" title={anchor.domPath}>
          <span className="inline-chip__icon">{'\u29BE'}</span>
          <span className="inline-chip__label">&lt;{anchor.tagName}&gt;</span>
        </span>
      );
      remaining = remaining.slice(idx + token.length);
    }
  }

  if (remaining) {
    parts.push(<span key={key++}>{remaining}</span>);
  }

  return <>{parts}</>;
}

function ThinkingBubble({ message }: Props) {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  // Open while streaming, collapse when done — unless user manually toggled
  const expanded = manualToggle !== null ? manualToggle : message.isStreaming === true;

  return (
    <div className="message-bubble message-bubble--thinking" onClick={() => setManualToggle(!expanded)}>
      <div className="message-bubble__thinking-header">
        <span className="message-bubble__thinking-icon">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span>Thinking{message.isStreaming ? '...' : ''}</span>
      </div>
      {expanded && (
        <div className="message-bubble__thinking-content">
          {message.content}
        </div>
      )}
    </div>
  );
}

function ToolUseBubble({ message }: Props) {
  return (
    <div className="message-bubble message-bubble--tool-use">
      <span className="message-bubble__tool-icon">{'\u2692'}</span>
      <div className="message-bubble__tool-detail">
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isInterrupted = isSystem && message.content === '_interrupted_';

  if (isInterrupted) {
    return <div className="message-bubble message-bubble--interrupted">interrupted</div>;
  }

  if (message.kind === 'thinking') {
    return <ThinkingBubble message={message} />;
  }

  if (message.kind === 'tool_use') {
    return <ToolUseBubble message={message} />;
  }

  if (message.kind === 'permission') {
    return <PermissionBubble message={message} />;
  }

  if (message.kind === 'question') {
    return <QuestionBubble message={message} />;
  }

  if (message.kind === 'task') {
    return <TaskBubble message={message} />;
  }

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
        {isUser ? (
          renderUserContent(message.content, message.anchors)
        ) : (
          <Markdown>{message.content}</Markdown>
        )}
      </div>
    </div>
  );
}
