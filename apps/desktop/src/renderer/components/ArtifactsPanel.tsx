import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, FolderInput, Copy } from 'lucide-react';
import { useTasksStore, selectActiveTask, EMPTY_ARTIFACTS } from '../stores/tasks-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { iconFor } from '../lib/file-icon';
import { ContextMenu, type CtxItem } from './ContextMenu';

export function ArtifactsPanel() {
  const artifacts = useTasksStore((s) => {
    const t = selectActiveTask(s);
    return t?.artifacts ?? EMPTY_ARTIFACTS;
  });
  const openFile = useWorkspaceStore((s) => s.openFile);
  const root = useWorkspaceStore((s) => s.root);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  if (artifacts.length === 0) {
    return <div className="state-section__empty">Files Claude edits or creates land here.</div>;
  }

  // Dedupe by path, keep most recent.
  const seen = new Map<string, typeof artifacts[number]>();
  for (const a of artifacts) seen.set(a.path, a);
  const items = [...seen.values()].sort((a, b) => b.ts - a.ts);

  const copyPath = (path: string, relative: boolean): void => {
    const p = relative && root && path.startsWith(root)
      ? path.slice(root.length).replace(/^\//, '')
      : path;
    void navigator.clipboard.writeText(p).catch(() => { /* clipboard may be blocked */ });
  };

  const buildItems = (path: string): CtxItem[] => {
    const isElectron = window.ccb.isElectron;
    return [
      { kind: 'item', label: 'Open', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: () => { void openFile(path); } },
      { kind: 'divider' },
      ...(isElectron
        ? [{ kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(path); } }]
        : []),
      { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, false) },
      { kind: 'item', label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(path, true) },
    ];
  };

  return (
    <div className="artifact-list">
      <AnimatePresence initial={false}>
        {items.map((a) => {
          const { Icon, hue } = iconFor(a.path.split('/').pop() ?? a.path);
          return (
            <motion.button
              key={a.path}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="artifact-item"
              onClick={() => { void openFile(a.path); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, path: a.path }); }}
              title={a.path}
            >
              <span className="artifact-item__icon" style={hue ? { color: hue } : undefined}>
                <Icon size={13} strokeWidth={1.75} />
              </span>
              <span className="artifact-item__name">{a.path.split('/').pop()}</span>
              <span className="artifact-item__action">{a.kind}</span>
            </motion.button>
          );
        })}
      </AnimatePresence>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildItems(menu.path)} onDismiss={() => setMenu(null)} />
      )}
    </div>
  );
}
