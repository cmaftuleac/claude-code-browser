import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type CtxItem =
  | {
      kind: 'item';
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onActivate: () => void;
    }
  | { kind: 'divider' };

interface Props {
  /** Cursor coordinates in viewport space; the menu anchors here, flipping
   *  around the anchor if it would otherwise clip the viewport edge. */
  x: number;
  y: number;
  items: CtxItem[];
  onDismiss: () => void;
}

const ANIM = { duration: 0.12, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
const MARGIN = 8;

/**
 * Custom right-click menu. Anchored at (x, y); auto-flips against viewport
 * edges. Keyboard nav (Arrow Up/Down + Enter), Esc dismisses, click outside
 * dismisses. Activating an item calls `onActivate` *then* `onDismiss` — so
 * an item handler can flip downstream state (e.g. start renaming) before
 * the menu unmounts.
 */
export function ContextMenu({ x, y, items, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y, ready: false });
  // Hover/keyboard focus index — skips dividers.
  const activeIdx = useRef<number>(firstSelectableIndex(items));
  const [hover, setHover] = useState<number>(activeIdx.current);

  // Flip against viewport edges after first paint.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = x + w + MARGIN > vw ? Math.max(MARGIN, x - w) : x;
    const ny = y + h + MARGIN > vh ? Math.max(MARGIN, y - h) : y;
    setPos({ x: nx, y: ny, ready: true });
  }, [x, y]);

  // Click outside + Escape dismiss + Arrow keys / Enter.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onDismiss(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = stepSelectable(items, hover, dir);
        if (next != null) setHover(next);
      } else if (e.key === 'Enter') {
        const target = items[hover];
        if (target && target.kind === 'item' && !target.disabled) {
          e.preventDefault();
          target.onActivate();
          onDismiss();
        }
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [items, hover, onDismiss]);

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        role="menu"
        className="ctx-menu"
        style={{ left: pos.x, top: pos.y, opacity: pos.ready ? undefined : 0 }}
        initial={{ opacity: 0, scale: 0.96, y: -2 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -2 }}
        transition={ANIM}
      >
        {items.map((it, i) => {
          if (it.kind === 'divider') return <div key={`d${i}`} className="ctx-menu__divider" aria-hidden />;
          const isHover = i === hover && !it.disabled;
          return (
            <button
              key={`i${i}`}
              role="menuitem"
              type="button"
              className={`ctx-menu__item ${it.danger ? 'ctx-menu__item--danger' : ''} ${isHover ? 'is-hover' : ''} ${it.disabled ? 'is-disabled' : ''}`}
              onMouseEnter={() => !it.disabled && setHover(i)}
              onClick={(e) => {
                e.stopPropagation();
                if (it.disabled) return;
                it.onActivate();
                onDismiss();
              }}
              disabled={it.disabled}
            >
              <span className="ctx-menu__item-icon">{it.icon}</span>
              <span className="ctx-menu__item-label">{it.label}</span>
              {it.shortcut && <span className="ctx-menu__shortcut">{it.shortcut}</span>}
            </button>
          );
        })}
      </motion.div>
    </AnimatePresence>
  );
}

function firstSelectableIndex(items: CtxItem[]): number {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'item' && !it.disabled) return i;
  }
  return -1;
}
function stepSelectable(items: CtxItem[], start: number, dir: 1 | -1): number | null {
  const n = items.length;
  if (n === 0) return null;
  let i = start;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    const it = items[i];
    if (it.kind === 'item' && !it.disabled) return i;
  }
  return null;
}
