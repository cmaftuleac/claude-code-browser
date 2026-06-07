import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check, Hand, FileEdit, ScrollText, Wand2, Zap, Dumbbell } from 'lucide-react';
import { MODEL_OPTIONS, DEFAULT_SETTINGS, type PermissionModeSetting, type EffortSetting } from '@fineguide-tesseract/shared';
import { useTasksStore } from '../stores/tasks-store';
import { useSettingsStore } from '../stores/settings-store';

const ANIM = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface ModeDef { value: PermissionModeSetting; label: string; short: string; desc: string; icon: React.ReactNode }

/** The five run modes, in the same order the official Claude Code cycles them. */
export const MODES: ModeDef[] = [
  { value: 'default', label: 'Ask before edits', short: 'Ask', desc: 'Claude asks for approval before each edit and command.', icon: <Hand size={15} strokeWidth={1.75} /> },
  { value: 'acceptEdits', label: 'Edit automatically', short: 'Auto-edit', desc: 'Apply file edits without asking; still ask before commands.', icon: <FileEdit size={15} strokeWidth={1.75} /> },
  { value: 'plan', label: 'Plan mode', short: 'Plan', desc: 'Explore the code and present a plan before editing.', icon: <ScrollText size={15} strokeWidth={1.75} /> },
  { value: 'auto', label: 'Auto mode', short: 'Auto', desc: 'Claude automatically picks the best permission mode per task.', icon: <Wand2 size={15} strokeWidth={1.75} /> },
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', desc: 'Never ask — edits and commands run freely.', icon: <Zap size={15} strokeWidth={1.75} /> },
];

/** Effort levels, ordered low→high as discrete stops on the slider. The top
 *  stop ("Ultracode") is the SDK's `max` effort, rendered with a distinct
 *  accent to mark it as the all-out mode. */
interface EffortStop { value: EffortSetting; label: string; ultra?: boolean }
const EFFORT_STOPS: EffortStop[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Ultracode', ultra: true },
];

/** Next permission mode in the cycle (wraps). Exported so the Composer's
 *  ⇧+Tab shortcut can advance the mode without opening the menu. */
export function nextPermissionMode(current: PermissionModeSetting): PermissionModeSetting {
  const i = MODES.findIndex((m) => m.value === current);
  return MODES[(i + 1) % MODES.length].value;
}

export function modeShortLabel(mode: PermissionModeSetting): string {
  return MODES.find((m) => m.value === mode)?.short ?? 'Ask';
}

/** "Claude Opus 4.8" → "Opus 4.8" for the compact trigger pill. */
function modelShort(label: string): string {
  return label.replace(/^Claude\s+/, '');
}

/** Composer run-mode control: a pill that opens a popover with the permission
 *  modes, a reasoning-effort slider, and a model dropdown. Per-conversation;
 *  switches a live session immediately via the store (agent:set_mode). */
export function RunModeMenu({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const task = useTasksStore((s) => s.tasks.find((t) => t.id === taskId));
  const setRunMode = useTasksStore((s) => s.setRunMode);
  const defaultModelId = useSettingsStore((s) => s.settings.agent.model) || DEFAULT_SETTINGS.agent.model;

  const permissionMode = task?.permissionMode ?? 'bypassPermissions';
  const effort = task?.effort ?? '';
  const model = task?.model ?? '';

  // Close the model dropdown whenever the whole menu closes.
  useEffect(() => { if (!open) setModelOpen(false); }, [open]);

  // Escape closes the model dropdown first, then the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modelOpen) setModelOpen(false);
      else setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, modelOpen]);

  // ── Model dropdown options ──────────────────────────────────────────────
  const defaultModelLabel = MODEL_OPTIONS.find((m) => m.id === defaultModelId)?.label ?? 'SDK default';
  const MODELS = [{ id: '', label: `Default (${defaultModelLabel})` }, ...MODEL_OPTIONS];
  const currentModelLabel = MODELS.find((m) => m.id === model)?.label ?? `Default (${defaultModelLabel})`;
  // Pill always shows a concrete model — the explicit one, or the resolved default.
  const pillModel = modelShort(MODEL_OPTIONS.find((m) => m.id === (model || defaultModelId))?.label ?? 'Default');

  // ── Effort slider geometry ──────────────────────────────────────────────
  const activeIndex = Math.max(0, EFFORT_STOPS.findIndex((s) => s.value === effort));
  const lastIndex = EFFORT_STOPS.length - 1;
  const pct = (activeIndex / lastIndex) * 100;
  const isUltra = !!EFFORT_STOPS[activeIndex]?.ultra;
  const effortLabel = EFFORT_STOPS[activeIndex]?.label ?? 'Default';

  const setEffortFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * lastIndex);
    const next = EFFORT_STOPS[idx].value;
    if (next !== effort) setRunMode(taskId, { effort: next });
  };

  const onSliderKey = (e: React.KeyboardEvent) => {
    let idx = activeIndex;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') idx = Math.min(activeIndex + 1, lastIndex);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') idx = Math.max(activeIndex - 1, 0);
    else return;
    e.preventDefault();
    setRunMode(taskId, { effort: EFFORT_STOPS[idx].value });
  };

  return (
    <div className="runmode">
      <button
        className="runmode__trigger"
        onClick={() => setOpen((v) => !v)}
        title="Run mode (⇧+Tab to cycle), effort & model"
      >
        <span className="runmode__mode">{modeShortLabel(permissionMode)}</span>
        <span className="runmode__sep">·</span>
        <span className="runmode__model">{pillModel}</span>
        <ChevronDown size={11} strokeWidth={2} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="runmode__backdrop" onClick={() => setOpen(false)} />
            <motion.div
              className="runmode__pop"
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={ANIM}
            >
              <div className="runmode__header">
                <span>Modes</span>
                <span className="runmode__hint"><kbd>⇧</kbd> + <kbd>tab</kbd> to switch</span>
              </div>
              {MODES.map((m) => {
                const on = m.value === permissionMode;
                return (
                  <button
                    key={m.value}
                    className={`runmode__item ${on ? 'is-on' : ''}`}
                    onClick={() => { setRunMode(taskId, { permissionMode: m.value }); }}
                  >
                    <span className="runmode__item-icon">{m.icon}</span>
                    <span className="runmode__item-text">
                      <span className="runmode__item-label">{m.label}</span>
                      <span className="runmode__item-desc">{m.desc}</span>
                    </span>
                    {on && <Check size={14} strokeWidth={2.25} className="runmode__item-check" />}
                  </button>
                );
              })}

              {/* Effort — a discrete slider; the top stop ("Ultracode") is max effort. */}
              <div className="runmode__row runmode__row--effort">
                <span className="runmode__effort-head">
                  <Dumbbell size={14} strokeWidth={1.75} />
                  <span>Effort <em>({effortLabel})</em></span>
                </span>
                <div
                  ref={trackRef}
                  className={`runmode__slider ${isUltra ? 'is-ultra' : ''}`}
                  role="slider"
                  tabIndex={0}
                  aria-label="Reasoning effort"
                  aria-valuemin={0}
                  aria-valuemax={lastIndex}
                  aria-valuenow={activeIndex}
                  aria-valuetext={effortLabel}
                  onKeyDown={onSliderKey}
                  onPointerDown={(e) => {
                    trackRef.current?.setPointerCapture(e.pointerId);
                    setDragging(true);
                    setEffortFromClientX(e.clientX);
                  }}
                  onPointerMove={(e) => { if (dragging) setEffortFromClientX(e.clientX); }}
                  onPointerUp={(e) => { setDragging(false); trackRef.current?.releasePointerCapture(e.pointerId); }}
                >
                  <span className="runmode__slider-track" />
                  <span className={`runmode__slider-fill ${isUltra ? 'is-ultra' : ''}`} style={{ width: `${pct}%` }} />
                  {EFFORT_STOPS.map((s, i) => (
                    <span
                      key={s.value || 'default'}
                      className={`runmode__slider-dot ${i <= activeIndex ? 'is-filled' : ''} ${s.ultra ? 'is-ultra' : ''}`}
                      style={{ left: `${(i / lastIndex) * 100}%` }}
                    />
                  ))}
                  <span className={`runmode__slider-knob ${isUltra ? 'is-ultra' : ''}`} style={{ left: `${pct}%` }} />
                </div>
              </div>

              {/* Model — a dropdown; the Default entry names the resolved model. */}
              <div className="runmode__row runmode__row--model">
                <span className="runmode__row-label">Model</span>
                <div className="runmode__dropdown">
                  <button
                    className="runmode__dd-trigger"
                    onClick={() => setModelOpen((v) => !v)}
                    aria-expanded={modelOpen}
                  >
                    <span className="runmode__dd-current">{currentModelLabel}</span>
                    <ChevronDown size={13} strokeWidth={2} className={`runmode__dd-caret ${modelOpen ? 'is-open' : ''}`} />
                  </button>
                  <AnimatePresence>
                    {modelOpen && (
                      <motion.div
                        className="runmode__dd-list"
                        initial={{ opacity: 0, y: 4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 4, scale: 0.98 }}
                        transition={ANIM}
                      >
                        {MODELS.map((m) => {
                          const on = m.id === model;
                          return (
                            <button
                              key={m.id || 'default'}
                              className={`runmode__dd-item ${on ? 'is-on' : ''}`}
                              onClick={() => { setRunMode(taskId, { model: m.id }); setModelOpen(false); }}
                            >
                              <span>{m.label}</span>
                              {on && <Check size={13} strokeWidth={2.25} className="runmode__dd-check" />}
                            </button>
                          );
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
