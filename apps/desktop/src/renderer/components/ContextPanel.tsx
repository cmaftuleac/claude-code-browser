import { motion, AnimatePresence } from 'framer-motion';
import { FolderOpen, Globe, Folder } from 'lucide-react';
import { useWorkspaceStore, type DirEntry } from '../stores/workspace-store';
// Workspace-level open files (project-wide). Files used to be per-task; now
// they live in workspace-store so they persist across conversation switches.
import { FileTreeNode } from './FileTreeNode';
import { FileTreeCreateRow } from './FileTreeCreateRow';

const EMPTY: DirEntry[] = [];
const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

export function ContextPanel() {
  const root = useWorkspaceStore((s) => s.root);
  const name = useWorkspaceStore((s) => s.name);
  const rootChildren = useWorkspaceStore((s) => (s.root ? s.children[s.root] ?? EMPTY : EMPTY));
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const workingFiles = useWorkspaceStore((s) => s.workingFiles);
  // Inline create row for the project root (File → New File targets the root).
  const rootCreating = useWorkspaceStore((s) => (root && s.pendingCreate?.dir === root ? s.pendingCreate.kind : null));

  const submitRootCreate = async (createName: string): Promise<{ ok: boolean; error?: string }> => {
    if (!root) return { ok: false, error: 'No project open.' };
    const fn = rootCreating === 'folder' ? window.ccb.fs.createFolder : window.ccb.fs.createFile;
    const res = await fn(root, createName);
    if (res.ok) {
      useWorkspaceStore.getState().clearPendingCreate();
      void useWorkspaceStore.getState().refreshDir(root);
      if (rootCreating === 'file' && res.path) void useWorkspaceStore.getState().openFile(res.path);
    }
    return res;
  };

  return (
    <div>
      <div className="ctx-group">
        <div className="ctx-group__label">Folder</div>
        <AnimatePresence mode="wait" initial={false}>
          {!root ? (
            <motion.button
              key="open"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={ANIM}
              className="ctx-action"
              onClick={() => void openFolder()}
            >
              <FolderOpen size={12} strokeWidth={1.75} /> Open folder…
            </motion.button>
          ) : (
            <motion.div
              key="tree"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={ANIM}
            >
              <button className="ctx-item" title={root} onClick={() => void openFolder()}>
                <Folder size={12} strokeWidth={1.75} />
                {name}
              </button>
              <div className="tree">
                <AnimatePresence initial={false}>
                  {rootCreating && (
                    <motion.div
                      key="root-create"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={ANIM}
                      style={{ overflow: 'hidden' }}
                    >
                      <FileTreeCreateRow
                        kind={rootCreating}
                        depth={0}
                        onSubmit={submitRootCreate}
                        onCancel={() => useWorkspaceStore.getState().clearPendingCreate()}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
                {rootChildren.map((child) => (
                  <FileTreeNode key={child.path} entry={child} depth={0} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="ctx-group">
        <div className="ctx-group__label">Connectors</div>
        <div className="ctx-list">
          <span className="ctx-item">
            <Globe size={12} strokeWidth={1.75} />
            Web search
          </span>
          <span className="ctx-item">
            <Folder size={12} strokeWidth={1.75} />
            Filesystem
          </span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {workingFiles.length > 0 && (
          <motion.div
            key="working"
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={ANIM}
            className="ctx-group"
            style={{ overflow: 'hidden' }}
          >
            <div className="ctx-group__label">Working files</div>
            <div className="ctx-list">
              <AnimatePresence initial={false}>
                {workingFiles.map((p) => (
                  <motion.span
                    key={p}
                    layout
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={ANIM}
                    className="ctx-item"
                    title={p}
                  >
                    <Folder size={12} strokeWidth={1.75} />
                    {p.split('/').pop()}
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
