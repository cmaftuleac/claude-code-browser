import React, { useEffect, useRef, useState } from 'react';
import { MODEL_OPTIONS, type PermissionModeSetting, type EffortSetting } from '@fineguide-tesseract/shared';
import { useChatStore } from '../stores/chat-store';

interface ModeDef { value: PermissionModeSetting; label: string; short: string; desc: string }

const MODES: ModeDef[] = [
  { value: 'default', label: 'Ask before edits', short: 'Ask', desc: 'Asks before each edit and command.' },
  { value: 'acceptEdits', label: 'Edit automatically', short: 'Auto-edit', desc: 'Applies edits without asking; still asks before commands.' },
  { value: 'plan', label: 'Plan mode', short: 'Plan', desc: 'Explores and presents a plan before editing.' },
  { value: 'auto', label: 'Auto mode', short: 'Auto', desc: 'Picks the best permission mode per task.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', desc: 'Never asks — runs freely.' },
];

const EFFORTS: { value: EffortSetting; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-Hi' },
  { value: 'max', label: 'Max' },
];

const MODELS: { id: string; label: string }[] = [{ id: '', label: 'Default' }, ...MODEL_OPTIONS];

/** Next permission mode in the cycle (wraps) — for the ⇧+Tab shortcut. */
export function nextPermissionMode(current: PermissionModeSetting): PermissionModeSetting {
  const i = MODES.findIndex((m) => m.value === current);
  return MODES[(i + 1) % MODES.length].value;
}

/** Side-panel run-mode picker: permission mode + effort + model. Mirrors the
 *  desktop RunModeMenu; uses the extension's dark palette. */
export function RunModePicker() {
  const [open, setOpen] = useState(false);
  const runMode = useChatStore((s) => s.runMode);
  const setRunMode = useChatStore((s) => s.setRunMode);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const short = MODES.find((m) => m.value === runMode.permissionMode)?.short ?? 'Ask';

  return (
    <div className="runmode" ref={ref}>
      <button className="runmode__trigger" onClick={() => setOpen((v) => !v)} title="Run mode, effort & model">
        {short} <span className="runmode__caret">▾</span>
      </button>
      {open && (
        <div className="runmode__pop">
          <div className="runmode__header">Modes</div>
          {MODES.map((m) => (
            <button
              key={m.value}
              className={`runmode__item ${m.value === runMode.permissionMode ? 'is-on' : ''}`}
              onClick={() => setRunMode({ permissionMode: m.value })}
            >
              <span className="runmode__item-label">{m.label}</span>
              <span className="runmode__item-desc">{m.desc}</span>
            </button>
          ))}
          <div className="runmode__row">
            <span className="runmode__row-label">Effort</span>
            <div className="runmode__seg">
              {EFFORTS.map((e) => (
                <button
                  key={e.value || 'default'}
                  className={`runmode__seg-btn ${e.value === runMode.effort ? 'is-on' : ''}`}
                  onClick={() => setRunMode({ effort: e.value })}
                >{e.label}</button>
              ))}
            </div>
          </div>
          <div className="runmode__row">
            <span className="runmode__row-label">Model</span>
            <div className="runmode__seg runmode__seg--wrap">
              {MODELS.map((m) => (
                <button
                  key={m.id || 'default'}
                  className={`runmode__seg-btn ${m.id === runMode.model ? 'is-on' : ''}`}
                  onClick={() => setRunMode({ model: m.id })}
                >{m.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
