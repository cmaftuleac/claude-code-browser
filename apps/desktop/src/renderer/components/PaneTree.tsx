import { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LayoutNode } from '../lib/pane-layout';
import { useUiStore } from '../stores/ui-store';
import { Pane } from './Pane';
import { PaneDivider } from './PaneDivider';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Recursively renders the split layout. A `group` is a leaf {@link Pane}; a
 * `split` lays its children out in a flex row/column with a {@link PaneDivider}
 * between adjacent slots.
 *
 * `flexGrow` is an *animated* value (from each child's size fraction) so a slot
 * smoothly grows/shrinks when a sibling is added or removed — and crucially
 * collapses to ~0 on exit, so closing a pane never leaves a frozen gap. During
 * a divider drag we make the flexGrow transition instant (`paneResizing`) so the
 * drag tracks the cursor 1:1 instead of springing.
 */
export function PaneTree({ node }: { node: LayoutNode }) {
  const paneResizing = useUiStore((s) => s.paneResizing);
  if (node.type === 'group') return <Pane group={node} />;

  const sizeTween = paneResizing ? { duration: 0 } : ANIM;
  const items: ReactNode[] = [];
  node.children.forEach((child, i) => {
    items.push(
      <motion.div
        key={child.id}
        className="pane-slot"
        style={{ flexBasis: 0, minWidth: 0, minHeight: 0 }}
        initial={{ opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1, flexGrow: node.sizes[i] }}
        exit={{ opacity: 0, flexGrow: 0.0001 }}
        transition={{ ...ANIM, flexGrow: sizeTween }}
      >
        <PaneTree node={child} />
      </motion.div>,
    );
    if (i < node.children.length - 1) {
      // Key dividers by the two neighbours they sit between (not by index) so
      // they don't reshuffle when a middle child is removed.
      items.push(
        <PaneDivider
          key={`divider:${child.id}:${node.children[i + 1].id}`}
          splitId={node.id}
          index={i}
          direction={node.direction}
        />,
      );
    }
  });

  return (
    <div className={`pane-split pane-split--${node.direction}`}>
      <AnimatePresence initial={false}>{items}</AnimatePresence>
    </div>
  );
}
