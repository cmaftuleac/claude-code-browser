import { useState } from 'react';
import { motion } from 'framer-motion';
import { Folder, X, FolderInput, Copy, ExternalLink, Trash2 } from 'lucide-react';
import type { RecentProject } from '../stores/recents-store';
import { ContextMenu, type CtxItem } from './ContextMenu';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function shortPath(p: string): string {
  // Truncate the middle of long paths visually — keep first segment + last 2.
  const parts = p.split('/');
  if (parts.length <= 4) return p;
  return `${parts.slice(0, 2).join('/')}/…/${parts.slice(-2).join('/')}`;
}

export function RecentProjectRow({
  item,
  index,
  onOpen,
  onRemove,
}: {
  item: RecentProject;
  index: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const isElectron = window.ccb.isElectron;

  const copyPath = (): void => {
    void navigator.clipboard.writeText(item.path).catch(() => { /* clipboard may be blocked */ });
  };

  const items: CtxItem[] = [
    { kind: 'item', label: 'Open', icon: <ExternalLink size={13} strokeWidth={1.75} />, onActivate: onOpen },
    { kind: 'divider' },
    ...(isElectron
      ? [{ kind: 'item' as const, label: 'Reveal in Finder', icon: <FolderInput size={13} strokeWidth={1.75} />, onActivate: () => { void window.ccb.fs.revealInFinder(item.path); } }]
      : []),
    { kind: 'item', label: 'Copy Path', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: copyPath },
    { kind: 'divider' },
    { kind: 'item', label: 'Remove from Recents', icon: <Trash2 size={13} strokeWidth={1.75} />, danger: true, onActivate: onRemove },
  ];

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4, height: 0 }}
        transition={{ ...ANIM, delay: Math.min(index * 0.04, 0.24) }}
        className="recent-row"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuAt({ x: e.clientX, y: e.clientY }); }}
        title={item.path}
      >
        <span className="recent-row__icon">
          <Folder size={15} strokeWidth={1.75} />
        </span>
        <span className="recent-row__main">
          <span className="recent-row__name">{item.name}</span>
          <span className="recent-row__path">{shortPath(item.path)}</span>
        </span>
        <span className="recent-row__time">Opened {relTime(item.lastOpenedAt)}</span>
        <button
          className="recent-row__remove"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove from recents"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </motion.div>

      {menuAt && (
        <ContextMenu x={menuAt.x} y={menuAt.y} items={items} onDismiss={() => setMenuAt(null)} />
      )}
    </>
  );
}
