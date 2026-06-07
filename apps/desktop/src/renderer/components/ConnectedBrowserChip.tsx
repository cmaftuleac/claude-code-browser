import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, ChevronDown, Check } from 'lucide-react';
import { useBrowserStore, type BrowserInstance } from '../stores/browser-store';
import { useTasksStore } from '../stores/tasks-store';

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

function labelFor(inst: BrowserInstance | undefined): string {
  if (!inst) return 'New Tab';
  if (inst.title.trim()) return inst.title.trim();
  try { if (inst.currentUrl) return new URL(inst.currentUrl).host; } catch { /* not a url yet */ }
  return 'New Tab';
}

/**
 * Lets a conversation connect to a specific browser instance (any chat ↔ any
 * browser). Unbound → the agent drives the focused browser. Hidden when no
 * browser is open. Custom animated popover (no native <select>).
 */
export function ConnectedBrowserChip({ taskId }: { taskId: string }) {
  const order = useBrowserStore((s) => s.order);
  const instances = useBrowserStore((s) => s.instances);
  const activeId = useBrowserStore((s) => s.activeId);
  const boundId = useTasksStore((s) => s.tasks.find((t) => t.id === taskId)?.browserId);
  const bindBrowser = useTasksStore((s) => s.bindBrowser);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (order.length === 0) return null;

  // Bound instance may have been closed since — fall back to "focused" display.
  const boundInst = boundId ? instances[boundId] : undefined;
  const display = boundInst ? labelFor(boundInst) : 'Focused browser';
  const focusedLabel = activeId && instances[activeId] ? labelFor(instances[activeId]) : null;

  const choose = (id: string | null): void => { bindBrowser(taskId, id); setOpen(false); };

  return (
    <div className="composer__connect" ref={ref}>
      <button
        className={`composer__connect-btn ${boundInst ? 'is-bound' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Which browser this chat controls"
      >
        <Globe size={12} strokeWidth={1.75} />
        <span className="composer__connect-label">{display}</span>
        <ChevronDown size={11} strokeWidth={2} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="composer__connect-menu"
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={ANIM}
          >
            <button className="composer__connect-item" onClick={() => choose(null)}>
              <span>Focused browser{focusedLabel && !boundInst ? ` · ${focusedLabel}` : ''}</span>
              {!boundInst && <Check size={12} strokeWidth={2} />}
            </button>
            {order.map((id) => (
              <button key={id} className="composer__connect-item" onClick={() => choose(id)}>
                <span>{labelFor(instances[id])}</span>
                {boundId === id && <Check size={12} strokeWidth={2} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
