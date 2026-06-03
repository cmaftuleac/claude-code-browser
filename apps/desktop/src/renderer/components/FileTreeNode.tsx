import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight, Folder, FolderOpen,
  ExternalLink, FolderInput, FilePlus, FolderPlus, Copy, Scissors, ClipboardPaste, Pencil, Trash2,
} from 'lucide-react';
import { useWorkspaceStore, type DirEntry } from '../stores/workspace-store';
import { useTasksStore, selectActiveTask } from '../stores/tasks-store';
import { useFileClipboardStore } from '../stores/file-clipboard-store';
import { iconFor } from '../lib/file-icon';
import { ContextMenu, type CtxItem } from './ContextMenu';
import { ConfirmCard } from './ConfirmCard';
import { FileTreeCreateRow } from './FileTreeCreateRow';
import { TREE_DRAG_MIME, extractDroppedPaths } from '../lib/drop-paths';

const EMPTY: DirEntry[] = [];
const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

export function FileTreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const expanded = useWorkspaceStore((s) => !!s.expanded[entry.path]);
  const children = useWorkspaceStore((s) => (entry.isDir ? s.children[entry.path] ?? EMPTY : EMPTY));
  const root = useWorkspaceStore((s) => s.root);
  const toggleDir = useWorkspaceStore((s) => s.toggleDir);
  const refreshDir = useWorkspaceStore((s) => s.refreshDir);
  const loadDir = useWorkspaceStore((s) => s.loadDir);
  const activeFile = useWorkspaceStore((s) => s.activeFile);
  const openFile = useWorkspaceStore((s) => s.openFile);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** Pending "click an already-selected file → enter rename" timer. Cleared
   *  by a double-click (which then runs reveal-in-Finder instead). 500ms is
   *  slightly longer than Chromium's double-click detection window, so any
   *  real double-click intent always reaches us before this fires. */
  const renameDelayRef = useRef<number | null>(null);
  const cancelPendingRename = (): void => {
    if (renameDelayRef.current != null) {
      window.clearTimeout(renameDelayRef.current);
      renameDelayRef.current = null;
    }
  };
  useEffect(() => () => cancelPendingRename(), []);

  // Right-click menu + transient creation state for directory nodes.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Drag-over highlight when this row is the prospective drop target.
  const [dropHover, setDropHover] = useState(false);
  // Sticky reference so the rev-bump in useFileClipboardStore re-renders us.
  const clipboardRev = useFileClipboardStore((s) => s.rev);
  const isCut = useFileClipboardStore((s) => s.mode === 'cut' && s.paths.includes(entry.path));
  void clipboardRev;

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      // Select base name only (before the last extension dot) for quick edit.
      const v = renameInputRef.current.value;
      const dot = v.lastIndexOf('.');
      renameInputRef.current.setSelectionRange(0, dot > 0 ? dot : v.length);
    }
  }, [renaming]);

  const isActive = !entry.isDir && activeFile === entry.path;
  const { Icon: FileIcon, hue: fileHue } = entry.isDir ? { Icon: null, hue: undefined } : iconFor(entry.name);

  const onClick = () => {
    if (renaming) return;
    if (entry.isDir) { void toggleDir(entry.path); return; }
    if (!isActive) {
      // First click on an unselected file → select + open it. Auto-create a
      // task if none exists, so the empty workspace is never a dead end.
      void openFile(entry.path);
      return;
    }
    // Second click on the already-selected file → schedule inline rename,
    // unless a double-click intervenes (which fires reveal-in-Finder).
    cancelPendingRename();
    renameDelayRef.current = window.setTimeout(() => {
      renameDelayRef.current = null;
      startRename();
    }, 500);
  };

  /** Double-click on a file → reveal in Finder. Cancels any pending rename
   *  from the preceding click. */
  const onDoubleClick = (e: React.MouseEvent) => {
    cancelPendingRename();
    if (entry.isDir || renaming) return;
    e.preventDefault();
    void window.ccb.fs.revealInFinder(entry.path);
  };

  /** Enter on a focused row → enter inline rename. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      startRename();
    }
  };

  const startRename = (): void => {
    setRenameValue(entry.name);
    setRenameError(null);
    setRenaming(true);
  };

  const cancelRename = () => {
    setRenaming(false);
    setRenameError(null);
    setRenameValue(entry.name);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (!next || next === entry.name) { cancelRename(); return; }
    const res = await window.ccb.fs.renameFile(entry.path, next);
    if (!res.ok) {
      setRenameError(res.error ?? 'Rename failed.');
      return;
    }
    // Close the old path if it's open — the path no longer exists.
    if (useWorkspaceStore.getState().fileBuffers[entry.path]) {
      useWorkspaceStore.getState().closeFile(entry.path);
    }
    // Refresh the parent dir so the tree reflects the new name.
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
    if (parent) void refreshDir(parent);
    setRenaming(false);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    cancelPendingRename();
    // VS-Code parity: right-clicking an unselected file should also select it
    // so visual feedback matches the menu's target. (For dirs, just open menu.)
    if (!entry.isDir && !isActive) {
      void openFile(entry.path);
    }
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  const beginCreate = async (kind: 'file' | 'folder'): Promise<void> => {
    if (!entry.isDir) return;
    // Toggle expands+loads, but only if it isn't already open.
    if (!expanded) {
      await toggleDir(entry.path);
    } else if (!useWorkspaceStore.getState().children[entry.path]) {
      await loadDir(entry.path);
    }
    setCreating(kind);
  };

  const submitCreate = async (name: string): Promise<{ ok: boolean; error?: string }> => {
    const fn = creating === 'folder' ? window.ccb.fs.createFolder : window.ccb.fs.createFile;
    const res = await fn(entry.path, name);
    if (res.ok) {
      setCreating(null);
      void refreshDir(entry.path);
      if (creating === 'file' && res.path) void openFile(res.path);
    }
    return res;
  };

  // Drive the inline create row from an external request (File → New File menu
  // targeting this folder). ContextPanel handles the project root.
  const pendingCreate = useWorkspaceStore((s) => s.pendingCreate);
  useEffect(() => {
    if (entry.isDir && pendingCreate && pendingCreate.dir === entry.path) {
      useWorkspaceStore.getState().clearPendingCreate();
      void beginCreate(pendingCreate.kind);
    }
    // beginCreate is stable enough for this transient signal; intentionally
    // keyed only on the pending request + this node's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreate, entry.isDir, entry.path]);

  const copyPath = (relative: boolean): void => {
    const p = relative && root
      ? entry.path.startsWith(root) ? entry.path.slice(root.length).replace(/^\//, '') : entry.path
      : entry.path;
    void navigator.clipboard.writeText(p).catch(() => { /* clipboard may be blocked */ });
  };

  /** Paste whatever's in the in-app clipboard into this folder.
   *  Files: pasted as siblings (target = parent dir).
   *  Dirs: pasted inside the directory. */
  const pasteHere = async (): Promise<void> => {
    const cb = useFileClipboardStore.getState();
    if (!cb.mode || cb.paths.length === 0) return;
    const destDir = entry.isDir ? entry.path : (entry.path.slice(0, entry.path.lastIndexOf('/')) || root || '');
    if (!destDir) return;
    if (cb.mode === 'copy') {
      await window.ccb.fs.copyPaths(cb.paths, destDir);
    } else {
      // Move: close any open buffers for the moved sources first.
      const wsBuffers = useWorkspaceStore.getState().fileBuffers;
      for (const src of cb.paths) {
        if (wsBuffers[src]) useWorkspaceStore.getState().closeFile(src);
      }
      await window.ccb.fs.movePaths(cb.paths, destDir);
      cb.clear();
    }
    void refreshDir(destDir);
    // Watcher will also refresh, but for cross-dir moves the source's old
    // parent needs a kick too.
    for (const src of cb.paths) {
      const parent = src.slice(0, src.lastIndexOf('/'));
      if (parent) void refreshDir(parent);
    }
  };

  // ── Drag-and-drop wiring ──────────────────────────────────────────
  const onDragStart = (e: React.DragEvent): void => {
    if (renaming || creating) { e.preventDefault(); return; }
    e.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify([entry.path]));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  /** Resolve where a drop on THIS row would land: folder rows accept into
   *  themselves; file rows redirect to their parent directory (Finder rule). */
  const dropTarget = (): string => entry.isDir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/'));

  /** Cmd/Ctrl modifier on drop → copy semantics; otherwise move within
   *  the tree (internal source) or copy from outside the tree (Finder). */
  const onDragOver = (e: React.DragEvent): void => {
    if (renaming) return;
    const types = Array.from(e.dataTransfer.types ?? []);
    const isInternal = types.includes(TREE_DRAG_MIME);
    const hasExternal = types.includes('Files');
    if (!isInternal && !hasExternal) return;
    e.preventDefault();
    e.stopPropagation();
    const copy = isInternal ? (e.metaKey || e.ctrlKey || e.altKey) : true;
    e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    if (!dropHover) setDropHover(true);
  };
  const onDragLeave = (): void => { if (dropHover) setDropHover(false); };
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const target = dropTarget();
    if (!target) return;
    const { paths, internal } = extractDroppedPaths(e.dataTransfer);
    if (paths.length === 0) return;
    // Refuse a folder drop onto itself or a descendant.
    if (internal && paths.some((p) => p === target || target.startsWith(p + '/'))) return;
    const wantsCopy = internal ? (e.metaKey || e.ctrlKey || e.altKey) : true;
    if (wantsCopy) {
      await window.ccb.fs.copyPaths(paths, target);
    } else {
      const wsBuffers = useWorkspaceStore.getState().fileBuffers;
      for (const src of paths) {
        if (wsBuffers[src]) useWorkspaceStore.getState().closeFile(src);
      }
      await window.ccb.fs.movePaths(paths, target);
    }
    // Auto-expand only when the row was a folder — dropping on a file row
    // doesn't need to open anything (target was the parent, already visible).
    if (entry.isDir && !expanded) await toggleDir(entry.path);
    void refreshDir(target);
    for (const src of paths) {
      const parent = src.slice(0, src.lastIndexOf('/'));
      if (parent && parent !== target) void refreshDir(parent);
    }
  };

  const doDelete = async (): Promise<void> => {
    setConfirmDelete(false);
    // Close any open buffers for this path (or any path beneath, for dirs).
    const prefix = entry.isDir ? entry.path + '/' : null;
    const wsBuffers = useWorkspaceStore.getState().fileBuffers;
    for (const bufPath of Object.keys(wsBuffers)) {
      if (bufPath === entry.path || (prefix && bufPath.startsWith(prefix))) {
        useWorkspaceStore.getState().closeFile(bufPath);
      }
    }
    await window.ccb.fs.deletePath(entry.path);
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/'));
    if (parent) void refreshDir(parent);
  };

  const isElectron = window.ccb.isElectron;
  const isMac = isElectron && navigator.platform.toLowerCase().includes('mac');
  const modKey = isMac ? '⌘' : 'Ctrl';
  const cbHasContents = useFileClipboardStore((s) => s.paths.length > 0);
  const setClipboard = useFileClipboardStore((s) => s.set);

  const cutCopyPasteItems = (): CtxItem[] => [
    { kind: 'item', label: 'Cut', icon: <Scissors size={13} strokeWidth={1.75} />, shortcut: `${modKey}X`, onActivate: () => setClipboard('cut', [entry.path]) },
    { kind: 'item', label: 'Copy', icon: <Copy size={13} strokeWidth={1.75} />, shortcut: `${modKey}C`, onActivate: () => setClipboard('copy', [entry.path]) },
    { kind: 'item', label: 'Paste', icon: <ClipboardPaste size={13} strokeWidth={1.75} />, shortcut: `${modKey}V`, disabled: !cbHasContents, onActivate: () => void pasteHere() },
  ];

  const menuItems: CtxItem[] = entry.isDir
    ? [
        { kind: 'item', label: 'New File', icon: <FilePlus size={13} strokeWidth={1.75} />, onActivate: () => void beginCreate('file') },
        { kind: 'item', label: 'New Folder', icon: <FolderPlus size={13} strokeWidth={1.75} />, onActivate: () => void beginCreate('folder') },
        ...(isElectron
          ? [{ kind: 'divider' as const }, { kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(entry.path); } }]
          : []),
        { kind: 'divider' },
        ...cutCopyPasteItems(),
        { kind: 'divider' },
        { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(false) },
        { kind: 'item', label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(true) },
        { kind: 'divider' },
        { kind: 'item', label: 'Rename', icon: <Pencil size={13} strokeWidth={1.75} />, shortcut: '↵', onActivate: () => startRename() },
        { kind: 'item', label: isElectron ? 'Move to Trash' : 'Delete', icon: <Trash2 size={13} strokeWidth={1.75} />, shortcut: `${modKey}⌫`, danger: true, onActivate: () => setConfirmDelete(true) },
      ]
    : [
        ...(isElectron
          ? [
              { kind: 'item' as const, label: 'Open With…', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.openWith(entry.path); } },
              { kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(entry.path); } },
              { kind: 'divider' as const },
            ]
          : []),
        ...cutCopyPasteItems(),
        { kind: 'divider' },
        { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(false) },
        { kind: 'item', label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyPath(true) },
        { kind: 'divider' },
        { kind: 'item', label: 'Rename', icon: <Pencil size={13} strokeWidth={1.75} />, shortcut: '↵', onActivate: () => startRename() },
        { kind: 'item', label: isElectron ? 'Move to Trash' : 'Delete', icon: <Trash2 size={13} strokeWidth={1.75} />, shortcut: `${modKey}⌫`, danger: true, onActivate: () => setConfirmDelete(true) },
      ];

  return (
    <div>
      <div
        className={`tree__row ${isActive ? 'is-active' : ''} ${renaming ? 'is-renaming' : ''} ${isCut ? 'is-cut' : ''} ${dropHover ? 'is-drop-target' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        tabIndex={renaming ? -1 : 0}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        draggable={!renaming && !creating}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => void onDrop(e)}
        title={entry.path}
      >
        <span className="tree__twisty">
          {entry.isDir ? (
            <motion.span
              animate={{ rotate: expanded ? 90 : 0 }}
              transition={ANIM}
              style={{ display: 'flex' }}
            >
              <ChevronRight size={11} strokeWidth={2} />
            </motion.span>
          ) : null}
        </span>
        <span className="tree__icon" style={!entry.isDir && fileHue ? { color: fileHue } : undefined}>
          {entry.isDir
            ? (expanded ? <FolderOpen size={13} strokeWidth={1.75} /> : <Folder size={13} strokeWidth={1.75} />)
            : FileIcon ? <FileIcon size={13} strokeWidth={1.75} /> : null}
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className="tree__rename"
            value={renameValue}
            onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void submitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
              else { e.stopPropagation(); }
            }}
            onBlur={() => { if (renaming) void submitRename(); }}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
          />
        ) : (
          <span className="tree__name">{entry.name}</span>
        )}
      </div>
      {renameError && (
        <div className="tree__rename-error" style={{ paddingLeft: 8 + depth * 12 + 32 }}>{renameError}</div>
      )}
      {entry.isDir && (
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={ANIM}
              style={{ overflow: 'hidden' }}
            >
              {creating && (
                <FileTreeCreateRow
                  kind={creating}
                  depth={depth + 1}
                  onSubmit={submitCreate}
                  onCancel={() => setCreating(null)}
                />
              )}
              {children.map((child) => (
                <FileTreeNode key={child.path} entry={child} depth={depth + 1} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={menuItems}
          onDismiss={() => setMenuAt(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmCard
          danger
          title={`${isElectron ? 'Move to Trash' : 'Delete'}`}
          message={
            entry.isDir
              ? `${entry.name} and all its contents will be ${isElectron ? 'moved to the Trash' : 'permanently deleted'}.`
              : `${entry.name} will be ${isElectron ? 'moved to the Trash' : 'permanently deleted'}.${isElectron ? ' You can restore it from Finder.' : ''}`
          }
          confirmLabel={isElectron ? 'Move to Trash' : 'Delete'}
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
