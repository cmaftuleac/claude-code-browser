import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTabDragStore, type DropTarget } from '../stores/tab-drag-store';
import { useUiStore } from '../stores/ui-store';
import type { TabKey } from './tab-key';

/** Pixels the pointer must travel before a press becomes a drag (lets clicks through). */
const THRESHOLD = 5;

/** Resolve what's under the cursor into a drop target: a tab strip (with an
 *  insertion index) or a pane body (index null). Returns null over neither. */
function resolveTarget(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const strip = el.closest<HTMLElement>('[data-strip-group]');
  if (strip) {
    const groupId = strip.getAttribute('data-strip-group')!;
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-key]'));
    let index = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) { index = i; break; }
    }
    return { groupId, index };
  }
  const pane = el.closest<HTMLElement>('[data-pane-group]');
  if (pane) return { groupId: pane.getAttribute('data-pane-group')!, index: null };
  return null;
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.groupId === b.groupId && a.index === b.index;
}

/**
 * Begin a pointer-based tab drag from a tab's `onPointerDown`. Does nothing
 * until the pointer moves past THRESHOLD (so a plain click still focuses the
 * tab). While dragging, a body `is-dragging-tab` class makes the webview overlay
 * click-through so drops can land on the pane behind the Preview. On release,
 * moves the tab into the resolved group/slot.
 */
export function startTabDrag(e: ReactPointerEvent, key: TabKey): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let active = false;
  let lastTarget: DropTarget | null = null;

  const onMove = (ev: PointerEvent): void => {
    if (!active) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < THRESHOLD) return;
      active = true;
      useTabDragStore.getState().begin(key, ev.clientX, ev.clientY);
      document.body.classList.add('is-dragging-tab');
    }
    useTabDragStore.getState().setPos(ev.clientX, ev.clientY);
    const target = resolveTarget(ev.clientX, ev.clientY);
    if (!sameTarget(target, lastTarget)) {
      lastTarget = target;
      useTabDragStore.getState().setTarget(target);
    }
  };

  const finish = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    if (!active) return;
    const target = resolveTarget(ev.clientX, ev.clientY);
    useTabDragStore.getState().end();
    document.body.classList.remove('is-dragging-tab');
    if (target) useUiStore.getState().moveTab(key, target.groupId, target.index ?? undefined);
  };
  const cancel = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    if (active) {
      useTabDragStore.getState().end();
      document.body.classList.remove('is-dragging-tab');
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}
