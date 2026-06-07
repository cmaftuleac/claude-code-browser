import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AtSign, Upload, Crosshair, Globe } from 'lucide-react';

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface Props {
  /** Upload a file from disk (opens the native file picker). */
  onUpload: () => void;
  /** Pick an element from the connected browser as page context. */
  onAddContext: () => void;
  /** Open a browser to browse the web. */
  onBrowse: () => void;
}

interface Item { label: string; desc: string; icon: React.ReactNode; run: (p: Props) => void }

const ITEMS: Item[] = [
  { label: 'Upload from computer', desc: 'Attach files or images', icon: <Upload size={15} strokeWidth={1.75} />, run: (p) => p.onUpload() },
  { label: 'Add context', desc: 'Pick an element from the page', icon: <Crosshair size={15} strokeWidth={1.75} />, run: (p) => p.onAddContext() },
  { label: 'Browse the web', desc: 'Open a browser tab', icon: <Globe size={15} strokeWidth={1.75} />, run: (p) => p.onBrowse() },
];

/** The Composer's "+" attach menu: a small popover offering the ways to add
 *  content to a message (upload, page context, browse). Mirrors the official
 *  Claude Code composer. Popover pattern matches RunModeMenu (backdrop + motion). */
export function AttachMenu(props: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="attachmenu">
      <button
        className={`composer__tool ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Add to message"
        aria-label="Add to message"
        aria-expanded={open}
      >
        <AtSign size={16} strokeWidth={2} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="attachmenu__backdrop" onClick={() => setOpen(false)} />
            <motion.div
              className="attachmenu__pop"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={ANIM}
            >
              {ITEMS.map((it) => (
                <button
                  key={it.label}
                  className="attachmenu__item"
                  onClick={() => { setOpen(false); it.run(props); }}
                >
                  <span className="attachmenu__item-icon">{it.icon}</span>
                  <span className="attachmenu__item-text">
                    <span className="attachmenu__item-label">{it.label}</span>
                    <span className="attachmenu__item-desc">{it.desc}</span>
                  </span>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
