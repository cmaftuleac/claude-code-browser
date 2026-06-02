import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface Props {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Tiny custom confirmation card — used for destructive actions like
 * "Move to Trash". Trivial yes/no UX per the project's no-popups rule
 * (this is the exception the rule explicitly allows).
 */
export function ConfirmCard({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  return (
    <AnimatePresence>
      <motion.div
        className="confirm-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      >
        <motion.div
          className="confirm-card"
          role="alertdialog"
          aria-modal="true"
          initial={{ opacity: 0, scale: 0.94, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={ANIM}
        >
          <h2 className="confirm-card__title">{title}</h2>
          {message && <p className="confirm-card__message">{message}</p>}
          <div className="confirm-card__actions">
            <button className="confirm-card__btn" onClick={onCancel}>{cancelLabel}</button>
            <button
              className={`confirm-card__btn confirm-card__btn--primary ${danger ? 'is-danger' : ''}`}
              onClick={onConfirm}
              autoFocus
            >
              {confirmLabel}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
