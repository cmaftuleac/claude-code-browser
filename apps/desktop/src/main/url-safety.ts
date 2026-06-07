/**
 * External-open URL allow-list (pure; unit-testable). A guest page's
 * window.open()/target=_blank reaches setWindowOpenHandler with an arbitrary
 * URL, and shell.openExternal('file:///…') (or a custom scheme) would hand it to
 * the OS handler — a launch primitive. Only web/mail schemes are allowed out.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false; // unparseable → not safe
  }
}
