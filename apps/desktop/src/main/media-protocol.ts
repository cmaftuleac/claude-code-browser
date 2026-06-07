/**
 * Custom `media-file://` protocol so the renderer can stream local media
 * (images, audio, video, PDF) without buffering the whole file into RAM.
 *
 * URL shape: `media-file:///<absolute-path>` — three slashes, empty host. With
 * `standard: true`, Electron's URL parser treats the third-slash-onwards as
 * the path, exactly what we want.
 *
 * The handler reads from disk via `fs.createReadStream` and honors the
 * `Range` header, so `<video>` scrubs instantly and pdf.js's chunked fetch
 * works. We don't use `net.fetch(file://…)` because Chromium's file fetcher
 * isn't reliable from custom-scheme handlers.
 */
import { app, protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { resolveRange } from './media-range.js';

export const MEDIA_PROTOCOL = 'media-file';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.pdf': 'application/pdf',
};

function mimeFor(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

export function registerMediaProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Per-launch capability token. The handler streams arbitrary local files, and
 * `<webview>` guests share the default session (so the scheme handler is
 * reachable from any remote page the agent navigates to). To stop a hostile
 * guest page from reading local files via `fetch('media-file://…')`, every
 * legit request must carry `?t=<token>`. The token is handed ONLY to the
 * trusted app renderer (via the preload bridge → `mediaUrl()` query param);
 * guest pages never receive it (it lives only in the app renderer's process /
 * DOM, which a cross-origin guest can't read). Set once at startup.
 */
let mediaToken = '';
export function setMediaToken(token: string): void { mediaToken = token; }

export function registerMediaProtocolHandler(): void {
  protocol.handle(MEDIA_PROTOCOL, async (req) => {
    try {
      const url = new URL(req.url);
      // Capability check: reject any request without the app-renderer token
      // (e.g. a fetch from a guest <webview>'s remote page).
      if (!mediaToken || url.searchParams.get('t') !== mediaToken) {
        return new Response('Forbidden', { status: 403 });
      }
      // URL shape: `media-file://local/<percent-encoded-absolute-path>`.
      // We strip the leading "/" off url.pathname and percent-decode the
      // remainder — that gives us the original absolute path back, dodging
      // Chromium's authority-canonicalization (which would lowercase a host).
      const encoded = url.pathname.replace(/^\//, '');
      let p = decodeURIComponent(encoded);
      // Windows-only: a path like `C:/foo` may come back without a leading
      // slash and is already valid for fs; nothing to strip.

      const s = await stat(p);
      if (!s.isFile()) return new Response('Not a file', { status: 400 });

      const type = mimeFor(p);
      const range = resolveRange(req.headers.get('range'), s.size);
      if (range.kind === 'unsatisfiable') {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${s.size}` },
        });
      }
      if (range.kind === 'partial') {
        const { start, end } = range;
        const chunk = createReadStream(p, { start, end });
        const body = Readable.toWeb(chunk) as unknown as ReadableStream;
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          },
        });
      }
      const full = createReadStream(p);
      const body = Readable.toWeb(full) as unknown as ReadableStream;
      return new Response(body, {
        headers: {
          'Content-Type': type,
          'Content-Length': String(s.size),
          'Accept-Ranges': 'bytes',
        },
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return new Response(msg, { status: msg.includes('ENOENT') ? 404 : 500 });
    }
  });
}

export function setupMediaProtocol(): void {
  registerMediaProtocolPrivileges();
  void app.whenReady().then(registerMediaProtocolHandler);
}
