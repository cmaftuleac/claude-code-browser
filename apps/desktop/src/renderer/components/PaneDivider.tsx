import { useUiStore } from '../stores/ui-store';
import { findNode, type SplitDirection } from '../lib/pane-layout';

/** Smallest a pane may be dragged to, in px (converted to a fraction per split). */
const MIN_PX = 140;

/**
 * Draggable divider between `children[index]` and `children[index+1]` of a split.
 * Dragging redistributes the fraction between those two neighbors only (the rest
 * keep their sizes), writing straight to the store every move so it tracks the
 * cursor 1:1 — no spring. A body-level `is-resizing-pane` class drops pointer
 * events on the rest of the workspace so the drag isn't swallowed by an editor
 * or webview, and `paneResizing` makes PaneTree's flex animation instant.
 */
export function PaneDivider({ splitId, index, direction }: { splitId: string; index: number; direction: SplitDirection }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const splitEl = e.currentTarget.parentElement;
    if (!splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    const total = direction === 'row' ? rect.width : rect.height;
    if (total <= 0) return;

    const layout = useUiStore.getState().layout;
    const node = layout ? findNode(layout, splitId) : null;
    if (!node || node.type !== 'split') return;
    // Guard against a stale divider (grabbed during a collapse exit window):
    // its index may no longer point at a valid neighbour pair.
    if (index + 1 >= node.children.length) return;
    const startSizes = [...node.sizes];
    const childCount = node.children.length;
    const a0 = startSizes[index];
    const b0 = startSizes[index + 1];
    const startPos = direction === 'row' ? e.clientX : e.clientY;
    // Always leave a usable drag band even on narrow splits (never let the min
    // exceed a third of the pair, so the divider can't get stuck at the midpoint).
    const minFrac = Math.min(MIN_PX / total, 0.35, (a0 + b0) / 2);

    const onMove = (ev: PointerEvent): void => {
      // Bail if the split changed shape mid-drag (e.g. a pane elsewhere closed
      // and collapsed this split) — writing stale-length sizes would corrupt it.
      const live = useUiStore.getState().layout;
      const n = live ? findNode(live, splitId) : null;
      if (!n || n.type !== 'split' || n.children.length !== childCount) { onUp(); return; }

      const cur = direction === 'row' ? ev.clientX : ev.clientY;
      let delta = (cur - startPos) / total;
      delta = Math.max(delta, minFrac - a0); // a ≥ minFrac
      delta = Math.min(delta, b0 - minFrac); // b ≥ minFrac
      const next = [...startSizes];
      next[index] = a0 + delta;
      next[index + 1] = b0 - delta;
      useUiStore.getState().resizeSplit(splitId, next);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-resizing-pane', `is-resizing-${direction}`);
      useUiStore.getState().setPaneResizing(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('is-resizing-pane', `is-resizing-${direction}`);
    useUiStore.getState().setPaneResizing(true);
  };

  return (
    <div
      className={`pane-divider pane-divider--${direction}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
    >
      <span className="pane-divider__grip" aria-hidden />
    </div>
  );
}
