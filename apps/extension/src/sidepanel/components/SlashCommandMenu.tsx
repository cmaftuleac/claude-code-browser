import React, { useRef, useEffect, useState } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

interface Props {
  commands: SlashCommand[];
  filter: string;
  onSelect: (command: string) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ commands, filter, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filter.toLowerCase()),
  );

  useEffect(() => { setSelectedIndex(0); }, [filter]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          onSelect(filtered[selectedIndex].name + (filtered[selectedIndex].hint ? ' ' : ''));
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [filtered, selectedIndex, onSelect, onClose]);

  if (filtered.length === 0) return null;

  return (
    <div className="slash-menu" ref={ref}>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`slash-menu__item${i === selectedIndex ? ' slash-menu__item--active' : ''}`}
          onClick={() => onSelect(cmd.name + (cmd.hint ? ' ' : ''))}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <span className="slash-menu__name">{cmd.name}</span>
          {cmd.hint && <span className="slash-menu__hint">{cmd.hint}</span>}
          <span className="slash-menu__desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
