import { createPortal } from 'react-dom';
import { MessageSquareText, Globe, Settings as SettingsIcon } from 'lucide-react';
import { useTabDragStore } from '../stores/tab-drag-store';
import { useTasksStore } from '../stores/tasks-store';
import { parseTabKey } from '../lib/tab-key';
import { isUntitledPath, untitledName } from '../lib/untitled';
import { iconFor } from '../lib/file-icon';

/**
 * A small label that follows the cursor while a tab is being dragged (mounted
 * once at the workspace root, portaled to <body>, click-through). Subscribes
 * only to the drag position + key so it re-renders cheaply during a drag and
 * not at all when idle.
 */
export function TabDragGhost() {
  const key = useTabDragStore((s) => s.key);
  const x = useTabDragStore((s) => s.x);
  const y = useTabDragStore((s) => s.y);
  const tasks = useTasksStore((s) => s.tasks);
  if (!key) return null;

  const tab = parseTabKey(key);
  let label: string;
  let icon: React.ReactNode;
  if (tab.kind === 'conv') {
    label = tasks.find((t) => t.id === tab.taskId)?.title ?? 'Conversation';
    icon = <MessageSquareText size={13} strokeWidth={1.75} />;
  } else if (tab.kind === 'browser') {
    label = 'Preview';
    icon = <Globe size={13} strokeWidth={1.75} />;
  } else if (tab.kind === 'settings') {
    label = 'Settings';
    icon = <SettingsIcon size={13} strokeWidth={1.75} />;
  } else {
    label = isUntitledPath(tab.path) ? untitledName(tab.path) : (tab.path.split('/').pop() ?? tab.path);
    const FI = iconFor(label).Icon;
    icon = <FI size={13} strokeWidth={1.75} />;
  }

  return createPortal(
    <div className="tab-drag-ghost" style={{ left: x, top: y }}>
      <span className="ws-tab__icon">{icon}</span>
      <span className="ws-tab__title">{label}</span>
    </div>,
    document.body,
  );
}
