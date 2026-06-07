import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpCircle, X } from 'lucide-react';
import { useUpdateStore } from '../stores/update-store';

/**
 * A subtle, dismissible "Update ready" pill, bottom-right above the footer.
 * Appears only once the update is fully downloaded and staged — the update
 * applies on next quit regardless, so this is purely an affordance for users
 * who'd rather relaunch now. Never a modal, never steals focus. (UI rule:
 * mount/unmount is animated via AnimatePresence.)
 */
export function UpdatePill() {
  const phase = useUpdateStore((s) => s.phase);
  const readyVersion = useUpdateStore((s) => s.readyVersion);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const installNow = useUpdateStore((s) => s.installNow);

  const visible = phase === 'ready' && !dismissed;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="update-pill"
          className="update-pill"
          initial={{ opacity: 0, y: 12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <ArrowUpCircle size={15} strokeWidth={2} className="update-pill__icon" />
          <span className="update-pill__text">
            Update ready{readyVersion ? <span className="update-pill__ver"> · v{readyVersion}</span> : null}
          </span>
          <button className="update-pill__action" onClick={() => installNow()}>Relaunch</button>
          <button className="update-pill__close" onClick={() => dismiss()} aria-label="Dismiss">
            <X size={13} strokeWidth={2} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
