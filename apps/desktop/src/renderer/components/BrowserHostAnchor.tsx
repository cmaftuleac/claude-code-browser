import { useLayoutEffect, useRef } from 'react';
import { useBrowserHostStore } from '../stores/browser-host-store';

/**
 * Empty placeholder rendered in the pane that holds a browser tab. It reserves
 * the layout space; the matching {@link BrowserOverlay} (one per instance,
 * portaled to <body>) tracks this element's rect and positions the actual
 * <webview> over it. Decouples the webview's lifetime from its React-tree
 * position, so moving the tab between split groups doesn't reload the page.
 *
 * Register/clear runs in a useLayoutEffect (synchronous, in the commit) so a tab
 * move never leaves a one-frame stale anchor for the overlay's rAF loop to track.
 */
export function BrowserHostAnchor({ browserId }: { browserId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) useBrowserHostStore.getState().setAnchor(browserId, el);
    return () => { if (el) useBrowserHostStore.getState().clearAnchor(browserId, el); };
  }, [browserId]);
  return <div className="browser-host-anchor" ref={ref} aria-hidden />;
}
