import { useRef } from 'react';
import { Music, Clock } from 'lucide-react';
import { mediaUrl } from '../lib/media-url';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useFileContextMenu, copyText } from '../hooks/useFileContextMenu';
import type { CtxItem } from './ContextMenu';

/** mm:ss (or h:mm:ss past an hour) for a media playback position. */
function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Minimal audio player — centered card with the filename and native controls.
 *  Stream URL is server-Range-aware, so seeking works for large files. */
export function AudioView({ path }: { path: string }) {
  const rev = useWorkspaceStore((s) => s.fileRevs[path] ?? 0);
  const url = mediaUrl(path, rev);
  const filename = path.split('/').pop() ?? path;
  const ref = useRef<HTMLAudioElement | null>(null);
  const { open, menu } = useFileContextMenu(path);

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const extras: CtxItem[] = [];
    const el = ref.current;
    if (el) {
      const t = fmtTime(el.currentTime);
      extras.push({ kind: 'item', label: `Copy Current Time (${t})`, icon: <Clock size={13} strokeWidth={1.75} />, onActivate: () => copyText(t) });
    }
    open(e, extras);
  };

  return (
    <div className="audio-view" onContextMenu={onContextMenu}>
      <div className="audio-view__card">
        <div className="audio-view__icon"><Music size={36} strokeWidth={1.5} /></div>
        <div className="audio-view__name" title={filename}>{filename}</div>
        <audio ref={ref} className="audio-view__player" src={url} controls preload="metadata" />
      </div>
      {menu}
    </div>
  );
}
