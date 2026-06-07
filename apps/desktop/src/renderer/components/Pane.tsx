import { AnimatePresence, motion } from 'framer-motion';
import { useUiStore } from '../stores/ui-store';
import { useTasksStore } from '../stores/tasks-store';
import { useBrowserStore } from '../stores/browser-store';
import { useTabDragStore } from '../stores/tab-drag-store';
import { type GroupNode, activeKeyOf } from '../lib/pane-layout';
import { parseTabKey } from '../lib/tab-key';
import { GroupTabBar } from './GroupTabBar';
import { TaskDocument } from './TaskDocument';
import { Composer } from './Composer';
import { FileTabBody } from './FileTabBody';
import { BrowserHostAnchor } from './BrowserHostAnchor';
import { SettingsPanel } from './SettingsPanel';

/**
 * A single editor group: its tab strip plus the bodies of every tab it holds.
 * Every body stays mounted (toggled with `hidden`) so Monaco models and chat
 * scroll survive switches *within* the group. The Preview tab renders only an
 * anchor — the actual <webview> lives in a single overlay positioned over it
 * (see BrowserOverlay), so it survives moving between groups without reloading.
 *
 * `data-pane-group` marks the body as a tab-drop target; dropping a dragged tab
 * here moves it into this group (the drag controller in lib/tab-dnd resolves it).
 */
export function Pane({ group }: { group: GroupNode }) {
  const activeGroupId = useUiStore((s) => s.activeGroupId);
  const focusGroup = useUiStore((s) => s.focusGroup);
  const selectTask = useTasksStore((s) => s.selectTask);
  const dropTarget = useTabDragStore((s) => s.target);
  const isActiveGroup = activeGroupId === group.id;
  const activeKey = activeKeyOf(group);
  // Highlight the body when a dragged tab is over it (not over the tab strip).
  const dropActive = !!dropTarget && dropTarget.groupId === group.id && dropTarget.index === null;

  // Clicking anywhere in the pane focuses its group, and — if its active tab is
  // a conversation — makes that the active task so the composer/state-rail track
  // the pane the user is working in.
  const onPaneFocus = (): void => {
    focusGroup(group.id);
    if (activeKey) {
      const t = parseTabKey(activeKey);
      if (t.kind === 'conv') selectTask(t.taskId);
      else if (t.kind === 'browser') useBrowserStore.getState().setActive(t.id);
    }
  };

  return (
    <div
      className={`pane ${isActiveGroup ? 'is-active-group' : ''}`}
      onPointerDownCapture={onPaneFocus}
    >
      <GroupTabBar group={group} />
      <div className="pane-content" data-pane-group={group.id}>
        {group.tabs.map((key) => {
          const tab = parseTabKey(key);
          return (
            <div key={key} className="workspace-pane" hidden={key !== activeKey}>
              {tab.kind === 'conv' && (
                <>
                  <TaskDocument taskId={tab.taskId} />
                  <Composer taskId={tab.taskId} />
                </>
              )}
              {tab.kind === 'file' && <FileTabBody path={tab.path} />}
              {tab.kind === 'browser' && <BrowserHostAnchor browserId={tab.id} />}
              {tab.kind === 'settings' && <SettingsPanel />}
            </div>
          );
        })}
        <AnimatePresence>
          {dropActive && (
            <motion.div
              key="pane-drop"
              className="pane-drop-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
