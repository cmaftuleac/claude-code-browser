import React, { useEffect, useRef, useState } from 'react';
import { MODEL_OPTIONS, type PermissionModeSetting, type EffortSetting } from '@claude-code-browser/shared';
import { useChatStore, selectActiveRunMode } from '../stores/chat-store';

interface ModeDef { value: PermissionModeSetting; label: string; short: string; desc: string }

const MODES: ModeDef[] = [
  { value: 'default', label: 'Ask before edits', short: 'Ask', desc: 'Asks before each edit and command.' },
  { value: 'acceptEdits', label: 'Edit automatically', short: 'Auto-edit', desc: 'Applies edits without asking; still asks before commands.' },
  { value: 'plan', label: 'Plan mode', short: 'Plan', desc: 'Explores and presents a plan before editing.' },
  { value: 'auto', label: 'Auto mode', short: 'Auto', desc: 'Picks the best permission mode per task.' },
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', desc: 'Never asks — runs freely.' },
];

/** The effort ladder, with Ultracode as its top rung.
 *
 *  Ultracode is not a seventh effort *value* in the SDK — it is `xhigh` effort plus
 *  standing dynamic-workflow orchestration, carried in the flag-settings layer. It
 *  lives here because that is how it is reasoned about ("turn it all the way up"),
 *  and the hint names what it really is so the ladder stays honest about Ultracode
 *  sitting at xhigh rather than somewhere above max. */
interface EffortStep { effort: EffortSetting; ultracode: boolean; label: string; hint?: string }

const EFFORT_STEPS: EffortStep[] = [
  { effort: '', ultracode: false, label: 'Default' },
  { effort: 'low', ultracode: false, label: 'Low' },
  { effort: 'medium', ultracode: false, label: 'Medium' },
  { effort: 'high', ultracode: false, label: 'High' },
  { effort: 'xhigh', ultracode: false, label: 'Extra high' },
  { effort: 'max', ultracode: false, label: 'Max' },
  { effort: 'xhigh', ultracode: true, label: 'Ultracode', hint: 'xhigh + workflows' },
];

/** Index of the rung matching the current run mode. Ultracode wins over the plain
 *  xhigh rung, so the two xhigh entries stay distinguishable. */
function stepIndexFor(effort: EffortSetting, ultracode: boolean): number {
  if (ultracode) return EFFORT_STEPS.length - 1;
  const i = EFFORT_STEPS.findIndex((s) => !s.ultracode && s.effort === effort);
  return i >= 0 ? i : 0;
}

/** Fallback list, used until the host reports what the local CLI actually offers. */
const FALLBACK_MODELS: { id: string; label: string }[] = [{ id: '', label: 'Default' }, ...MODEL_OPTIONS];

/** Next permission mode in the cycle (wraps) — for the ⇧+Tab shortcut. */
export function nextPermissionMode(current: PermissionModeSetting): PermissionModeSetting {
  const i = MODES.findIndex((m) => m.value === current);
  return MODES[(i + 1) % MODES.length].value;
}

/** Model chooser. A custom dropdown, not a native <select> — and it expands in
 *  flow rather than floating, because the surrounding popover is a scroll
 *  container (`overflow-y: auto`), which would clip an absolutely-positioned
 *  menu. The list scrolls itself into view when opened near the bottom. */
function ModelDropdown(
  { models, value, onPick }: { models: { id: string; label: string }[]; value: string; onPick: (id: string) => void },
) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // A model the CLI no longer reports still governs the next chat:send, so show its
  // raw id rather than falling back to models[0] — labelling it "Default" would claim
  // a switch that never happened.
  const current = models.find((m) => m.id === value) ?? (value ? { id: value, label: value } : models[0]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.scrollIntoView({ block: 'nearest' });
    // Capture phase + stopImmediatePropagation so Escape collapses just this list;
    // the parent popover's own window-level Escape handler stays armed for the
    // next press. (Both listen on window, so plain stopPropagation wouldn't do it.)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="runmode__dd">
      <button
        className="runmode__dd-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="runmode__dd-value">{current?.label ?? 'Default'}</span>
        <span className="runmode__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="runmode__dd-menu" role="listbox" ref={menuRef}>
          {models.map((m) => (
            <button
              key={m.id || 'default'}
              role="option"
              aria-selected={m.id === value}
              className={`runmode__dd-opt ${m.id === value ? 'is-on' : ''}`}
              onClick={() => { onPick(m.id); setOpen(false); }}
            >{m.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Side-panel run-mode picker: permission mode + effort + model. Mirrors the
 *  desktop RunModeMenu; uses the extension's dark palette. */
export function RunModePicker() {
  const [open, setOpen] = useState(false);
  // The ACTIVE conversation's mode (or the default for new chats when none is
  // open) — the picker edits one conversation, never all of them.
  const runMode = useChatStore(selectActiveRunMode);
  const setRunMode = useChatStore((s) => s.setRunMode);
  const reported = useChatStore((s) => s.models);
  const ref = useRef<HTMLDivElement>(null);
  // Prefer what the local CLI says it supports; fall back to the bundled list.
  const models = reported.length > 0 ? [{ id: '', label: 'Default' }, ...reported] : FALLBACK_MODELS;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const short = MODES.find((m) => m.value === runMode.permissionMode)?.short ?? 'Ask';
  // canUseTool is never invoked in bypassPermissions — the SDK auto-approves before
  // the callback runs — so unattended genuinely has nothing to answer in that mode.
  const bypassing = runMode.permissionMode === 'bypassPermissions';

  const stepIdx = stepIndexFor(runMode.effort, runMode.ultracode);
  const step = EFFORT_STEPS[stepIdx];
  const setStep = (i: number) => {
    const s = EFFORT_STEPS[Math.max(0, Math.min(EFFORT_STEPS.length - 1, i))];
    // Both axes move together: stepping off the top rung must clear ultracode, or it
    // would stay silently on while the label reads "Max".
    setRunMode({ effort: s.effort, ultracode: s.ultracode });
  };

  return (
    <div className="runmode" ref={ref}>
      <button className="runmode__trigger" onClick={() => setOpen((v) => !v)} title="Run mode, effort & model">
        {short}{runMode.ultracode ? ' · Ultra' : ''} <span className="runmode__caret">▾</span>
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
          {/* Effort ladder. A range input rather than a hand-rolled track so arrow
              keys, Home/End and correct ARIA slider semantics come for free. */}
          <div className={`runmode__effort ${step.ultracode ? 'is-ultra' : ''}`}>
            <div className="runmode__effort-head">
              <span className="runmode__row-label">Effort</span>
              <span className="runmode__effort-value">
                {step.label}
                {step.hint && <span className="runmode__effort-hint"> · {step.hint}</span>}
              </span>
            </div>
            <input
              type="range"
              className="runmode__slider"
              min={0}
              max={EFFORT_STEPS.length - 1}
              step={1}
              value={stepIdx}
              onChange={(e) => setStep(Number(e.target.value))}
              aria-label="Effort"
              aria-valuetext={step.hint ? `${step.label}, ${step.hint}` : step.label}
              style={{ ['--pct' as string]: `${(stepIdx / (EFFORT_STEPS.length - 1)) * 100}%` }}
            />
          </div>
          <button
            className={`runmode__toggle ${runMode.unattended ? 'is-on' : ''}`}
            onClick={() => setRunMode({ unattended: !runMode.unattended })}
            role="switch"
            aria-checked={runMode.unattended}
          >
            <span className="runmode__toggle-text">
              <span className="runmode__item-label">Unattended</span>
              <span className="runmode__item-desc">
                {bypassing
                  ? 'No effect while Bypass permissions is on — nothing is asked.'
                  : 'Approves the agent\u2019s requests for you and lists what it decided.'}
              </span>
            </span>
            <span className="runmode__switch" aria-hidden="true"><span /></span>
          </button>
          <div className="runmode__row runmode__row--model">
            <span className="runmode__row-label">Model</span>
            <ModelDropdown
              models={models}
              value={runMode.model}
              onPick={(id) => setRunMode({ model: id })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
