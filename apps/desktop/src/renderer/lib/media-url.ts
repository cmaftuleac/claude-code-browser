/**
 * URL for streaming a local file into an `<img>` / `<audio>` / `<video>` /
 * `<embed>` / pdf.js. Electron resolves via the `media-file://` custom
 * protocol (Chromium streams with Range internally — no buffering); web mode
 * hits the `/fs/stream` endpoint with HTTP Range.
 */
export function mediaUrl(path: string): string {
  if (typeof window !== 'undefined' && window.ccb?.isElectron) {
    // URL-encode the entire absolute path as a single path segment under a
    // dummy host. Why: with `standard: true`, Chromium's URL canonicalizer
    // would otherwise treat the first path segment as the host (and
    // lowercase it), producing `media-file://users/...` for `/Users/...`
    // and 404-ing the file. Keeping the path percent-encoded sidesteps the
    // entire host-vs-path ambiguity.
    return `media-file://local/${encodeURIComponent(path)}`;
  }
  return `/fs/stream?path=${encodeURIComponent(path)}`;
}
