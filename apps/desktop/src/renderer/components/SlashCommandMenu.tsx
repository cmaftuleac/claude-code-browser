import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { SlashCommand } from '../stores/connection-store';

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface Props {
  commands: SlashCommand[];
  /** The composer text (e.g. "/he"); filtered against command names. */
  filter: string;
  /** Called with the command name (+ trailing space when it takes an argument). */
  onSelect: (command: string) => void;
  onClose: () => void;
}

/** Keyboard-navigable slash-command menu (↑/↓ to move, Enter/Tab to insert,
 *  Esc to close, hover to highlight, outside-click to dismiss). Ported from the
 *  extension; sourced from connection-store.commands. */
export function SlashCommandMenu({ commands, filter, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  const q = filter.replace(/^\//, '').toLowerCase();
  const filtered = commands.filter((c) => c.name.slice(1).toLowerCase().includes(q));

  useEffect(() => { setIndex(0); }, [filter]);

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filtered[index];
        if (cmd) onSelect(cmd.name + (cmd.hint ? ' ' : ''));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [filtered, index, onSelect, onClose]);

  if (filtered.length === 0) return null;

  return (
    <motion.div
      ref={ref}
      className="composer__commands"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={ANIM}
    >
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`cmd${i === index ? ' cmd--active' : ''}`}
          onMouseEnter={() => setIndex(i)}
          onClick={() => onSelect(cmd.name + (cmd.hint ? ' ' : ''))}
        >
          <span className="cmd__name">{cmd.name}</span>
          {cmd.hint && <span className="cmd__hint">{cmd.hint}</span>}
          <span className="cmd__desc">{cmd.description}</span>
        </button>
      ))}
    </motion.div>
  );
}
