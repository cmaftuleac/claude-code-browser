import { Music } from 'lucide-react';
import { mediaUrl } from '../lib/media-url';

/** Minimal audio player — centered card with the filename and native controls.
 *  Stream URL is server-Range-aware, so seeking works for large files. */
export function AudioView({ path }: { path: string }) {
  const url = mediaUrl(path);
  const filename = path.split('/').pop() ?? path;
  return (
    <div className="audio-view">
      <div className="audio-view__card">
        <div className="audio-view__icon"><Music size={36} strokeWidth={1.5} /></div>
        <div className="audio-view__name" title={filename}>{filename}</div>
        <audio className="audio-view__player" src={url} controls preload="metadata" />
      </div>
    </div>
  );
}
