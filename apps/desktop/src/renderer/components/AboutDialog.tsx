import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useConnectionStore } from '../stores/connection-store';

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

const REPO_URL = 'https://github.com/cmaftuleac/claude-code-browser';
// Hardcoded Web Store ID so the link works in dev (unpacked) and prod alike.
const STORE_URL = 'https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf';

/**
 * Help → About. A small custom info card (no native dialog), matching the
 * ConfirmCard backdrop+card animation. Dismiss on Escape or backdrop click.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const version = useConnectionStore((s) => s.serverVersion);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const open = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    void window.ccb.fs.openExternal(url);
  };

  return (
    <motion.div
      className="about-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="about-card"
        role="dialog"
        aria-modal="true"
        aria-label="About Claude Code Browser"
        initial={{ opacity: 0, scale: 0.94, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 4 }}
        transition={ANIM}
      >
        <div className="about-card__glyph" aria-hidden>
          <Sparkles size={26} strokeWidth={1.5} />
        </div>
        <h2 className="about-card__title">Claude Code Browser</h2>
        <div className="about-card__version">{version ? `Version ${version}` : 'Connecting…'}</div>
        <p className="about-card__desc">
          An AI-native desktop workspace — an embedded browser and Photoshop-style
          HTML editor on top of Claude Code.
        </p>
        <div className="about-card__links">
          <a href={REPO_URL} className="about-card__link" onClick={open(REPO_URL)}>GitHub</a>
          <span className="about-card__dot" aria-hidden>·</span>
          <a href={STORE_URL} className="about-card__link" onClick={open(STORE_URL)}>Chrome Web Store</a>
        </div>
        <div className="about-card__footer">
          <span>© Fineguide.AI</span>
          <span className="about-card__dot" aria-hidden>·</span>
          <span>MIT License</span>
        </div>
        <button className="about-card__close" onClick={onClose} autoFocus>Close</button>
      </motion.div>
    </motion.div>
  );
}
