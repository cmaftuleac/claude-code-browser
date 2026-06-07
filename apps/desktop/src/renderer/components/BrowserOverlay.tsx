import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BrowserSurface } from './BrowserSurface';
import { useBrowserHostStore } from '../stores/browser-host-store';
import { useBrowserStore } from '../stores/browser-store';

/**
 * One <BrowserSurface> (and its <webview>) per browser instance, mounted once
 * for the instance's lifetime and portaled to <body> so no transformed ancestor
 * (framer's pane-slot scale) captures its `position: fixed`. A rAF loop tracks
 * THIS instance's host anchor rect and repositions the overlay to match —
 * write-on-change so it only touches the DOM when the rect actually moves. When
 * this instance's anchor is hidden (its tab isn't the active tab of its group →
 * rect ~0) or a modal is up, the overlay hides via the `is-visible` class
 * (keeping the guest webContents warm, so no reload). Because the webview never
 * reparents, moving the tab between split groups doesn't reload it.
 *
 * TaskWorkspace renders ONE of these per open instance, keyed by the stable
 * browser uuid — never by index — so closing a middle instance never reparents a
 * sibling's webview into a reused slot (which would reload it).
 */
export function BrowserOverlay({ browserId }: { browserId: string }) {
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = '';
    let reportedVisible: boolean | null = null;
    const tick = (): void => {
      const el = overlayRef.current;
      if (el) {
        const host = useBrowserHostStore.getState().anchors[browserId];
        const r = host ? host.getBoundingClientRect() : null;
        // The anchor's rect collapses to 0×0 when its tab isn't the active one
        // (hidden pane), so a non-trivial rect already means "this tab is shown".
        const visible = !!r && r.width >= 2 && r.height >= 2;
        // Report on-screen visibility to the store (write-on-change) so the idle
        // sweep / memory governor only ever suspends hidden tabs.
        if (visible !== reportedVisible) {
          reportedVisible = visible;
          useBrowserStore.getState().setVisible(browserId, visible);
        }
        if (!visible) {
          if (last !== 'hidden') { el.classList.remove('is-visible'); last = 'hidden'; }
        } else {
          const key = `${r!.left},${r!.top},${r!.width},${r!.height}`;
          if (key !== last) {
            el.style.left = `${r!.left}px`;
            el.style.top = `${r!.top}px`;
            el.style.width = `${r!.width}px`;
            el.style.height = `${r!.height}px`;
            el.classList.add('is-visible');
            last = key;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [browserId]);

  return createPortal(
    <div ref={overlayRef} className="browser-overlay">
      <BrowserSurface browserId={browserId} />
    </div>,
    document.body,
  );
}
