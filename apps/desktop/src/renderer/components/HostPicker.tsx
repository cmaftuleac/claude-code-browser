/**
 * Footer host chip + switcher.
 *
 * Shows which host the session is driving (the cloud server, or one of the
 * user's online Electron machines) and lets the user switch. Renders only when
 * there's something to choose — i.e. on web with at least one host. On desktop
 * (a single local host) it stays hidden.
 *
 * Animated per the project's motion rules (framer-motion, no native <select>).
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Monitor, Server } from 'lucide-react';
import type { HostInfo } from '@fineguide-tesseract/shared';
import { useHostStore, isSelected } from '../stores/host-store';

const MENU_ANIM = {
  initial: { opacity: 0, y: 6, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98 },
  transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
};

function hostIcon(kind: HostInfo['kind'], size = 12): JSX.Element {
  return kind === 'server' ? <Server size={size} strokeWidth={1.75} /> : <Monitor size={size} strokeWidth={1.75} />;
}

export function HostPicker(): JSX.Element | null {
  const hosts = useHostStore((s) => s.hosts);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const select = useHostStore((s) => s.select);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  // Nothing to switch between → don't clutter the footer (e.g. desktop's lone host).
  if (hosts.length <= 1) return null;

  const active = hosts.find((h) => isSelected(h, selectedHostId)) ?? hosts[0];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ide__footer-item"
        style={{
          display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', padding: 0,
        }}
        title="Switch the machine this session runs on"
      >
        {hostIcon(active.kind)}
        <span>{active.name}</span>
        <ChevronDown size={11} strokeWidth={2} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 140ms cubic-bezier(0.4,0,0.2,1)' }} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            key="host-menu"
            {...MENU_ANIM}
            style={{
              position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, minWidth: 220, zIndex: 50,
              background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--r)',
              boxShadow: 'var(--card-shadow)', padding: 4, transformOrigin: 'bottom left',
            }}
          >
            {hosts.map((h) => {
              const sel = isSelected(h, selectedHostId);
              return (
                <button
                  key={h.hostId}
                  type="button"
                  onClick={() => { select(h.hostId); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '7px 9px', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
                    background: sel ? 'var(--accent-bg)' : 'transparent',
                    color: h.online ? 'var(--ink)' : 'var(--ink-3)', font: 'inherit', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { if (!sel) (e.currentTarget.style.background = 'var(--bg-inset)'); }}
                  onMouseLeave={(e) => { if (!sel) (e.currentTarget.style.background = 'transparent'); }}
                >
                  <span style={{ color: sel ? 'var(--accent)' : 'var(--ink-2)', display: 'flex' }}>{hostIcon(h.kind, 13)}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                  {!h.online && <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>offline</span>}
                  {sel && <Check size={13} strokeWidth={2.25} style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
