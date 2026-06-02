import { useEffect, useState } from 'react';
import { Scissors, Copy, ClipboardPaste, MousePointerSquareDashed } from 'lucide-react';
import { ContextMenu, type CtxItem } from '../components/ContextMenu';

interface MenuState {
  x: number;
  y: number;
  /** The focused/clicked editable element, if any. */
  editable: HTMLInputElement | HTMLTextAreaElement | null;
  /** True if the target is contentEditable (e.g. Monaco isn't, but a div with contenteditable is). */
  isContentEditable: boolean;
  /** Current text selection at the time of right-click. */
  selection: string;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA']);

/** True when the right-click landed inside an explicit "leave me alone" surface
 *  — Monaco's editor (its built-in menu has Find/Replace/Go-to-Def we can't
 *  replicate) and the visual editor webview (its own in-page menu). */
function isInOptOutSurface(el: Element | null): boolean {
  if (!el) return false;
  return !!(
    el.closest('.monaco-editor') ||
    el.closest('webview') ||
    // Surfaces that already opened their own ContextMenu — they call
    // stopPropagation, so the global handler wouldn't fire anyway. This is a
    // belt-and-braces filter for cases where stopPropagation wasn't set.
    el.closest('[data-ctx-handled="true"]')
  );
}

/**
 * Global fallback right-click handler. Builds a small Cut/Copy/Paste/Select-All
 * menu so right-clicking anywhere "uncovered" by a more specific menu doesn't
 * fall back to Chromium's native context menu (which violates the no-native-ui
 * rule). Skipped inside Monaco and Composer textarea, where the host control's
 * own menu (Monaco's HTML menu, OS spellcheck) is preferable.
 */
export function useGlobalContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      // Prior `onContextMenu` handlers on specific surfaces stop propagation,
      // so this window-level listener only fires for "the rest". If we DO
      // fire here, check whether we're in an opt-out surface and bail.
      const target = e.target as Element | null;
      if (isInOptOutSurface(target)) return;

      const editable = (target?.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null) ?? null;
      const isContentEditable = !!(target instanceof HTMLElement && target.isContentEditable);
      const selection = window.getSelection()?.toString() ?? '';
      const actionable = !!editable || isContentEditable || selection.length > 0;
      if (!actionable) {
        // Nothing useful to offer — just suppress the native menu silently
        // (no-native-ui rule). Showing a menu of all-disabled items would be
        // worse than showing nothing.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, editable, isContentEditable, selection });
    };
    window.addEventListener('contextmenu', handler);
    return () => window.removeEventListener('contextmenu', handler);
  }, []);

  if (!menu) return null;

  const isEditable = !!menu.editable || menu.isContentEditable;
  const hasSelection = menu.selection.length > 0;

  const items: CtxItem[] = [
    {
      kind: 'item',
      label: 'Cut',
      icon: <Scissors size={13} strokeWidth={1.75} />,
      disabled: !isEditable || !hasSelection,
      onActivate: () => { document.execCommand('cut'); },
    },
    {
      kind: 'item',
      label: 'Copy',
      icon: <Copy size={13} strokeWidth={1.75} />,
      disabled: !hasSelection,
      onActivate: () => { void navigator.clipboard.writeText(menu.selection).catch(() => { /* ignore */ }); },
    },
    {
      kind: 'item',
      label: 'Paste',
      icon: <ClipboardPaste size={13} strokeWidth={1.75} />,
      disabled: !isEditable,
      onActivate: async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;
          // For native form controls, splice into the value at selection range.
          const el = menu.editable;
          if (el) {
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? el.value.length;
            const next = el.value.slice(0, start) + text + el.value.slice(end);
            // Use the input setter so React's onChange handler fires.
            const setter = Object.getOwnPropertyDescriptor(
              el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
              'value',
            )?.set;
            setter?.call(el, next);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.selectionStart = el.selectionEnd = start + text.length;
            el.focus();
          } else {
            // contentEditable — use execCommand which inserts at the caret.
            document.execCommand('insertText', false, text);
          }
        } catch { /* clipboard read may be denied */ }
      },
    },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Select All',
      icon: <MousePointerSquareDashed size={13} strokeWidth={1.75} />,
      onActivate: () => {
        const el = menu.editable;
        if (el) { el.select(); el.focus(); }
        else { document.execCommand('selectAll'); }
      },
    },
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} items={items} onDismiss={() => setMenu(null)} />
  );
}
