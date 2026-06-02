import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Activity, FileBox, Globe } from 'lucide-react';
import { ProgressPanel } from './ProgressPanel';
import { ArtifactsPanel } from './ArtifactsPanel';
import { ContextPanel } from './ContextPanel';

const ANIM = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function StateSection({ title, icon, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="state-section">
      <button className="state-section__head" onClick={() => setOpen((v) => !v)}>
        <span className="state-section__title">
          {icon}
          {title}
        </span>
        <motion.span
          animate={{ rotate: open ? 0 : -90 }}
          transition={ANIM}
          style={{ display: 'flex', color: 'inherit' }}
        >
          <ChevronDown size={13} strokeWidth={2} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ANIM}
            style={{ overflow: 'hidden' }}
          >
            <div className="state-section__body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StateRail() {
  return (
    <aside className="state-rail">
      <StateSection title="Progress" icon={<Activity size={12} strokeWidth={1.75} />}>
        <ProgressPanel />
      </StateSection>
      <StateSection title="Artifacts" icon={<FileBox size={12} strokeWidth={1.75} />}>
        <ArtifactsPanel />
      </StateSection>
      <StateSection title="Context" icon={<Globe size={12} strokeWidth={1.75} />}>
        <ContextPanel />
      </StateSection>
    </aside>
  );
}
