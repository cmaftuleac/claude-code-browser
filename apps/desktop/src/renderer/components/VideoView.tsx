import { useEffect, useRef } from 'react';
import { mediaUrl } from '../lib/media-url';

/** Native <video controls> filling the body. Pauses on unmount/hide so a
 *  tab-switch doesn't leave audio running. */
export function VideoView({ path }: { path: string }) {
  const url = mediaUrl(path);
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    return () => {
      const el = ref.current;
      if (el && !el.paused) el.pause();
    };
  }, [path]);
  return (
    <div className="video-view">
      <video ref={ref} className="video-view__player" src={url} controls preload="metadata" />
    </div>
  );
}
