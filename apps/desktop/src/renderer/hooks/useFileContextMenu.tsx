import { useState } from 'react';
import { Copy, FolderInput, ExternalLink } from 'lucide-react';
import { ContextMenu, type CtxItem } from '../components/ContextMenu';
import { useWorkspaceStore } from '../stores/workspace-store';
import { isUntitledPath } from '../lib/untitled';

interface MenuState {
  x: number;
  y: number;
  /** Window text selection snapshotted at right-click time. */
  selection: string;
  /** Content-specific items contributed by the calling viewer. */
  extras: CtxItem[];
}

/** Shared clipboard helper — viewers reuse this for their content-specific
 *  copy actions so every "copy" behaves identically (and fails silently when
 *  the clipboard is blocked). */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => { /* clipboard blocked */ });
}

/**
 * Right-click menu for an open file viewer. Returns `{ open, menu }`:
 *
 *  - `open(e, extras?)` — call from a viewer's `onContextMenu`. Prevents the
 *    native menu, stops propagation (so the FileTabBody-level fallback doesn't
 *    also fire), snapshots the current text selection, and anchors the menu at
 *    the cursor. `extras` are format-specific items shown above the baseline.
 *  - `menu` — render this in your JSX (it's `null` until `open` is called).
 *
 * The baseline (always available for titled files): Copy Selection (when text
 * is selected), Copy Path / Copy Relative Path, and — under Electron — Reveal
 * in Finder / Open With…. Mirrors the file-tab menu in GroupTabBar.
 */
export function useFileContextMenu(path: string): {
  open: (e: React.MouseEvent, extras?: CtxItem[]) => void;
  menu: JSX.Element | null;
} {
  const root = useWorkspaceStore((s) => s.root);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = (e: React.MouseEvent, extras: CtxItem[] = []): void => {
    e.preventDefault();
    e.stopPropagation();
    const selection = window.getSelection()?.toString() ?? '';
    setMenu({ x: e.clientX, y: e.clientY, selection, extras });
  };

  if (!menu) return { open, menu: null };

  const isElectron = window.ccb.isElectron;
  const untitled = isUntitledPath(path);
  const relPath = root && path.startsWith(root) ? path.slice(root.length).replace(/^\//, '') : path;

  // Build the menu as sections, then interleave dividers — this drops empty
  // sections cleanly so the menu never shows a leading/trailing/doubled rule.
  const sections: CtxItem[][] = [];
  if (menu.extras.length > 0) sections.push(menu.extras);
  if (menu.selection.length > 0) {
    sections.push([
      { kind: 'item', label: 'Copy Selection', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyText(menu.selection) },
    ]);
  }
  if (!untitled) {
    sections.push([
      { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyText(path) },
      { kind: 'item', label: 'Copy Relative Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyText(relPath) },
    ]);
    if (isElectron) {
      sections.push([
        { kind: 'item', label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(path); } },
        { kind: 'item', label: 'Open With…', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.openWith(path); } },
      ]);
    }
  }

  const items: CtxItem[] = [];
  sections.forEach((sec, i) => {
    if (i > 0) items.push({ kind: 'divider' });
    items.push(...sec);
  });

  // Nothing actionable (e.g. an untitled scratch buffer with no selection and
  // no extras) — suppress silently rather than show an empty box.
  if (items.length === 0) return { open, menu: null };

  return {
    open,
    menu: <ContextMenu x={menu.x} y={menu.y} items={items} onDismiss={() => setMenu(null)} />,
  };
}
