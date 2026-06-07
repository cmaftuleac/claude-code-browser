import { useId } from 'react';
import { motion } from 'framer-motion';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Segmented radio control with an animated sliding thumb. Shared by Settings,
 * the plans page, and the onboarding flow. Styling lives in styles.css (.set-seg*).
 */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  // Unique per instance — otherwise the shared layoutId would make the thumb
  // fly between different segmented controls mounted at the same time.
  const thumbId = useId();
  return (
    <div className="set-seg" role="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={`set-seg__opt ${on ? 'is-on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {on && <motion.span layoutId={thumbId} className="set-seg__thumb" transition={ANIM} />}
            <span className="set-seg__lbl">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
