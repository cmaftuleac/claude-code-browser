/**
 * Lazy metadata extractors. Each function dynamic-imports its library so the
 * dependency doesn't bloat the bundle until the Info pane actually needs it.
 *
 * All readers stream their input via `fs:readChunk` so we never buffer a
 * multi-GB media file into RAM.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Read first `maxBytes` of a file. Used by metadata libs that only need
 *  headers (EXIF is in the first ~64 KB; ID3v2 sits at the start; MP4 atoms
 *  are early; FLAC headers too). */
async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array> {
  const CAP = 1024 * 1024;
  let offset = 0;
  const out: Uint8Array[] = [];
  while (offset < maxBytes) {
    const len = Math.min(CAP, maxBytes - offset);
    const res = await window.ccb.fs.readChunk(path, offset, len);
    if (res.error || res.base64 == null) throw new Error(res.error ?? 'read failed');
    const b = base64ToBytes(res.base64);
    if (b.length === 0) break;
    out.push(b);
    offset += b.length;
    if (b.length < len) break;
  }
  const total = out.reduce((s, c) => s + c.length, 0);
  const combined = new Uint8Array(total);
  let p = 0;
  for (const c of out) { combined.set(c, p); p += c.length; }
  return combined;
}

export interface ImageMeta {
  width?: number;
  height?: number;
  orientation?: string;
  camera?: string;
  lens?: string;
  iso?: string;
  exposure?: string;
  aperture?: string;
  focalLength?: string;
  takenAt?: string;
  gps?: string;
  colorSpace?: string;
  other?: Array<{ label: string; value: string }>;
}

export async function fetchImageMeta(path: string): Promise<ImageMeta> {
  // EXIF + IPTC + XMP all sit in the first ~256 KB of the file at most.
  const bytes = await readPrefix(path, 256 * 1024);
  const ExifReader = await import('exifreader').then((m) => m.default ?? m);
  // exifreader accepts an ArrayBuffer (or string for files). Use .load().
  // Some types: load(file: ArrayBuffer | Buffer, options?) → tags object.
  let tags: Record<string, { description?: unknown; value?: unknown } | unknown>;
  try {
    // Copy into a tight ArrayBuffer so we don't pass a SharedArrayBuffer-typed slice.
    const tight = new ArrayBuffer(bytes.length);
    new Uint8Array(tight).set(bytes);
    tags = (ExifReader as { load(buf: ArrayBuffer): Record<string, unknown> }).load(tight);
  } catch {
    return {};
  }
  const get = (k: string): string | undefined => {
    const t = (tags as Record<string, { description?: unknown }>)[k];
    if (!t || typeof t !== 'object') return undefined;
    const d = t.description;
    return d == null ? undefined : String(d);
  };
  const result: ImageMeta = {
    width: parseFloat(get('Image Width') ?? get('PixelXDimension') ?? '') || undefined,
    height: parseFloat(get('Image Height') ?? get('PixelYDimension') ?? '') || undefined,
    orientation: get('Orientation'),
    camera: [get('Make'), get('Model')].filter(Boolean).join(' ') || undefined,
    lens: get('LensModel') ?? get('Lens'),
    iso: get('ISOSpeedRatings'),
    exposure: get('ExposureTime'),
    aperture: get('FNumber'),
    focalLength: get('FocalLength'),
    takenAt: get('DateTimeOriginal') ?? get('DateTime'),
    gps: get('GPSLatitude') && get('GPSLongitude') ? `${get('GPSLatitude')}, ${get('GPSLongitude')}` : undefined,
    colorSpace: get('ColorSpace'),
  };
  return result;
}

export interface AudioMeta {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  duration?: string;
  bitrate?: string;
  sampleRate?: string;
  channels?: string;
  codec?: string;
  format?: string;
}

function formatDuration(seconds?: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds == null) return undefined;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export async function fetchAudioMeta(path: string): Promise<AudioMeta> {
  const bytes = await readPrefix(path, 2 * 1024 * 1024); // up to 2 MB — covers ID3v2 + most container headers
  const mod = await import('music-metadata-browser');
  // parseBuffer takes a Uint8Array. Use loose typing — music-metadata's TS types vary by version.
  const parsed = await (mod as unknown as {
    parseBuffer: (b: Uint8Array, opts?: unknown) => Promise<{
      common: { title?: string; artist?: string; album?: string; year?: number; genre?: string[] };
      format: { duration?: number; bitrate?: number; sampleRate?: number; numberOfChannels?: number; codec?: string; container?: string };
    }>;
  }).parseBuffer(bytes);
  const { common, format } = parsed;
  return {
    title: common.title,
    artist: common.artist,
    album: common.album,
    year: common.year != null ? String(common.year) : undefined,
    genre: common.genre?.join(', '),
    duration: formatDuration(format.duration),
    bitrate: format.bitrate != null ? `${Math.round(format.bitrate / 1000)} kbps` : undefined,
    sampleRate: format.sampleRate != null ? `${(format.sampleRate / 1000).toFixed(1)} kHz` : undefined,
    channels: format.numberOfChannels != null ? `${format.numberOfChannels} ch` : undefined,
    codec: format.codec,
    format: format.container,
  };
}
