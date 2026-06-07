/**
 * URL for streaming a local file into an `<img>` / `<audio>` / `<video>` /
 * `<embed>` / pdf.js. Electron resolves via the `media-file://` custom
 * protocol (Chromium streams with Range internally — no buffering); web mode
 * hits the `/fs/stream` endpoint with HTTP Range.
 *
 * `rev` is a cache-busting revision (bumped by the workspace store when the
 * file changes on disk). Appending it as a query param forces Chromium to
 * re-fetch — the `media-file://` handler reads only `url.pathname` and the
 * web `/fs/stream` endpoint reads `path`, so the extra param is harmless.
 */
export function mediaUrl(path: string, rev = 0): string {
  if (typeof window !== 'undefined' && window.ccb?.isElectron) {
    // URL-encode the entire absolute path as a single path segment under a
    // dummy host. Why: with `standard: true`, Chromium's URL canonicalizer
    // would otherwise treat the first path segment as the host (and
    // lowercase it), producing `media-file://users/...` for `/Users/...`
    // and 404-ing the file. Keeping the path percent-encoded sidesteps the
    // entire host-vs-path ambiguity.
    const params = new URLSearchParams();
    if (rev) params.set('v', String(rev));
    // Capability token — the main-process handler 403s requests without it, so
    // a guest <webview> page (which never receives the token) can't read files.
    if (window.ccb.mediaToken) params.set('t', window.ccb.mediaToken);
    const q = params.toString();
    return `media-file://local/${encodeURIComponent(path)}${q ? `?${q}` : ''}`;
  }
  // `/fs/stream` is JWT-gated when auth is on; <img>/<video> can't send a Bearer
  // header, so carry the token as a query param (the server reads ?token=).
  const tok = (typeof window !== 'undefined' && window.ccb?.mediaToken) ? `&token=${encodeURIComponent(window.ccb.mediaToken)}` : '';
  return `/fs/stream?path=${encodeURIComponent(path)}${rev ? `&v=${rev}` : ''}${tok}`;
}
