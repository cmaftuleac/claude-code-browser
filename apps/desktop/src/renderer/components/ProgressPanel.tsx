import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';
import { useTasksStore, selectActiveTask, EMPTY_PROGRESS } from '../stores/tasks-store';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

export function ProgressPanel() {
  const progress = useTasksStore((s) => {
    const t = selectActiveTask(s);
    return t?.progress ?? EMPTY_PROGRESS;
  });

  if (progress.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={ANIM}
        className="state-section__empty"
      >
        Steps will show as the task unfolds.
      </motion.div>
    );
  }

  const shown = progress.slice(-8);

  return (
    <div className="progress-list">
      <AnimatePresence initial={false}>
        {shown.map((step) => (
          <motion.div
            key={step.id}
            layout
            initial={{ opacity: 0, x: -6, height: 0 }}
            animate={{ opacity: 1, x: 0, height: 'auto' }}
            exit={{ opacity: 0, x: -6, height: 0 }}
            transition={ANIM}
            className={`progress-step ${step.state === 'done' ? 'is-done' : 'is-active'}`}
          >
            <span className="progress-step__dot">
              <AnimatePresence>
                {step.state === 'done' && (
                  <motion.span
                    initial={{ scale: 0.3, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.3, opacity: 0 }}
                    transition={ANIM}
                    style={{ display: 'flex' }}
                  >
                    <Check size={9} strokeWidth={3} />
                  </motion.span>
                )}
              </AnimatePresence>
            </span>
            <span className="progress-step__label">{step.label}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
