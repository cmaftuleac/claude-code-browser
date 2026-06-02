import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Loader2 } from 'lucide-react';
import { fileKind, kindLabel } from '../lib/file-kind';
import { fetchImageMeta, fetchAudioMeta, type ImageMeta, type AudioMeta } from '../lib/metadata';
import { mediaUrl } from '../lib/media-url';

function formatBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ms?: number): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString();
}

interface VideoMeta { width?: number; height?: number; duration?: number; }

export function InfoView({ path }: { path: string }) {
  const kind = fileKind(path);
  const filename = path.split('/').pop() ?? path;
  const dir = path.slice(0, path.length - filename.length).replace(/\/$/, '');

  const [stat, setStat] = useState<{ size?: number; mtimeMs?: number; isBinary?: boolean }>({});
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [audioMeta, setAudioMeta] = useState<AudioMeta | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImageMeta(null); setAudioMeta(null); setVideoMeta(null);
    setLoading(true); setErr(null);
    (async () => {
      const s = await window.ccb.fs.statFile(path);
      if (cancelled) return;
      setStat({ size: s.size, mtimeMs: s.mtimeMs, isBinary: s.isBinary });

      try {
        if (kind === 'image') {
          const m = await fetchImageMeta(path);
          if (!cancelled) setImageMeta(m);
        } else if (kind === 'audio') {
          const m = await fetchAudioMeta(path);
          if (!cancelled) setAudioMeta(m);
        } else if (kind === 'video') {
          // Probe via off-DOM video element — gives us width/height/duration.
          await new Promise<void>((resolve) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            v.src = mediaUrl(path);
            v.onloadedmetadata = () => {
              if (!cancelled) setVideoMeta({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
              resolve();
            };
            v.onerror = () => resolve();
            // Safety timeout.
            setTimeout(() => resolve(), 4000);
          });
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error)?.message ?? e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, kind]);

  return (
    <div className="info-view">
      <div className="info-view__inner">

        <header className="info-view__head">
          <div className="info-view__kind">{kindLabel(kind)}{stat.isBinary ? ' · binary' : ''}</div>
          <h1 className="info-view__name">{filename}</h1>
          <div className="info-view__path">{dir}</div>
          <div className="info-view__actions">
            <button onClick={() => void window.ccb.fs.openExternal(path)}><ExternalLink size={12} strokeWidth={1.75} /> Open externally</button>
            <button onClick={() => void window.ccb.fs.revealInFinder(path)}><FolderOpen size={12} strokeWidth={1.75} /> Reveal in Finder</button>
          </div>
        </header>

        <Section title="Basic">
          <Row label="Size" value={formatBytes(stat.size)} />
          <Row label="Modified" value={formatTime(stat.mtimeMs)} />
          <Row label="Type" value={kindLabel(kind)} />
        </Section>

        {kind === 'image' && (
          <Section title="Image">
            {loading && <LoadingRow />}
            {!loading && imageMeta && (
              <>
                {(imageMeta.width || imageMeta.height) && <Row label="Dimensions" value={`${imageMeta.width ?? '?'} × ${imageMeta.height ?? '?'}`} />}
                <Row label="Orientation" value={imageMeta.orientation} />
                <Row label="Color space" value={imageMeta.colorSpace} />
                <Row label="Camera" value={imageMeta.camera} />
                <Row label="Lens" value={imageMeta.lens} />
                <Row label="Focal length" value={imageMeta.focalLength} />
                <Row label="Aperture" value={imageMeta.aperture} />
                <Row label="Exposure" value={imageMeta.exposure} />
                <Row label="ISO" value={imageMeta.iso} />
                <Row label="Taken at" value={imageMeta.takenAt} />
                <Row label="GPS" value={imageMeta.gps} />
              </>
            )}
          </Section>
        )}

        {kind === 'audio' && (
          <Section title="Audio">
            {loading && <LoadingRow />}
            {!loading && audioMeta && (
              <>
                <Row label="Title" value={audioMeta.title} />
                <Row label="Artist" value={audioMeta.artist} />
                <Row label="Album" value={audioMeta.album} />
                <Row label="Year" value={audioMeta.year} />
                <Row label="Genre" value={audioMeta.genre} />
                <Row label="Duration" value={audioMeta.duration} />
                <Row label="Format" value={audioMeta.format} />
                <Row label="Codec" value={audioMeta.codec} />
                <Row label="Bitrate" value={audioMeta.bitrate} />
                <Row label="Sample rate" value={audioMeta.sampleRate} />
                <Row label="Channels" value={audioMeta.channels} />
              </>
            )}
          </Section>
        )}

        {kind === 'video' && (
          <Section title="Video">
            {loading && <LoadingRow />}
            {!loading && videoMeta && (
              <>
                {(videoMeta.width || videoMeta.height) && <Row label="Dimensions" value={`${videoMeta.width ?? '?'} × ${videoMeta.height ?? '?'}`} />}
                <Row label="Duration" value={videoMeta.duration != null && Number.isFinite(videoMeta.duration) ? formatDurationSeconds(videoMeta.duration) : undefined} />
              </>
            )}
          </Section>
        )}

        {err && <div className="info-view__error">Couldn't extract metadata: {err}</div>}
      </div>
    </div>
  );
}

function formatDurationSeconds(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="info-view__section">
      <div className="info-view__section-title">{title}</div>
      <div className="info-view__section-body">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value?: string | number }) {
  if (value == null || value === '') return null;
  return (
    <div className="info-view__row">
      <span className="info-view__row-label">{label}</span>
      <span className="info-view__row-value">{value}</span>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="info-view__row info-view__row--loading">
      <Loader2 size={13} strokeWidth={2} className="spin" /> Reading metadata…
    </div>
  );
}
