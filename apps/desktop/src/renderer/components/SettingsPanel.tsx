import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Palette, Code2, Bot, UserRound, SlidersHorizontal, Info,
  Plus, Trash2, Pencil, Check, X, LogOut, ExternalLink, Server,
} from 'lucide-react';
import { MODEL_OPTIONS, planById, type McpServerSpec, type PermissionModeSetting } from '@fineguide-tesseract/shared';
import { useSettingsStore } from '../stores/settings-store';
import { useUiStore, type SettingsSection } from '../stores/ui-store';
import { useAuthStore } from '../stores/auth-store';
import { useRecentsStore } from '../stores/recents-store';
import { useConnectionStore } from '../stores/connection-store';
import { BrandMark } from './icons/BrandMark';
import { Segmented } from './controls/Segmented';
import { PlansView } from './PlansView';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

const REPO_URL = 'https://github.com/cmaftuleac/claude-code-browser';
const STORE_URL = 'https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf';

const SECTIONS: Array<{ id: SettingsSection; label: string; Icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'editor', label: 'Editor', Icon: Code2 },
  { id: 'agent', label: 'Agent', Icon: Bot },
  { id: 'account', label: 'Account', Icon: UserRound },
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'about', label: 'About', Icon: Info },
];

// ── Reusable controls ────────────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <div className="set-row__label">{label}</div>
        {hint && <div className="set-row__hint">{hint}</div>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`set-switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <motion.span className="set-switch__thumb" layout transition={{ type: 'spring', stiffness: 500, damping: 34 }} />
    </button>
  );
}

function Stepper({ value, min, max, step = 1, prefix, suffix, onChange }: {
  value: number; min: number; max: number; step?: number; prefix?: string; suffix?: string; onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="set-stepper">
      <button type="button" className="set-stepper__btn" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="Decrease">−</button>
      <span className="set-stepper__val">{prefix}{value}{suffix}</span>
      <button type="button" className="set-stepper__btn" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="Increase">+</button>
    </div>
  );
}

const ACCENTS = ['#d97757', '#5b7cfa', '#2f9e6e', '#b94032', '#8b5cf6', '#e0992a', '#3b82c4', '#475569'];

// ── Sections ─────────────────────────────────────────────────────────────────

function AppearanceSection() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const set = useSettingsStore((s) => s.set);
  return (
    <>
      <Row label="Theme" hint="Claude Code (warm cream), a clean White, or Dark.">
        <Segmented
          value={a.theme}
          options={[{ value: 'claude', label: 'Claude Code' }, { value: 'white', label: 'White' }, { value: 'dark', label: 'Dark' }]}
          onChange={(theme) => set({ appearance: { theme } })}
        />
      </Row>
      <Row label="Accent color" hint="Used for highlights, buttons, and focus.">
        <div className="set-swatches">
          {ACCENTS.map((c) => (
            <button
              key={c}
              type="button"
              className={`set-swatch ${a.accent.toLowerCase() === c.toLowerCase() ? 'is-on' : ''}`}
              style={{ background: c }}
              aria-label={c}
              onClick={() => set({ appearance: { accent: c } })}
            >
              {a.accent.toLowerCase() === c.toLowerCase() && <Check size={12} strokeWidth={2.5} />}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Density" hint="Compact tightens paddings across the UI.">
        <Segmented
          value={a.density}
          options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
          onChange={(density) => set({ appearance: { density } })}
        />
      </Row>
    </>
  );
}

function EditorSection() {
  const e = useSettingsStore((s) => s.settings.editor);
  const set = useSettingsStore((s) => s.set);
  return (
    <>
      <Row label="Font size">
        <Stepper value={e.fontSize} min={10} max={22} suffix="px" onChange={(fontSize) => set({ editor: { fontSize } })} />
      </Row>
      <Row label="Tab size" hint="Spaces per indentation level.">
        <Segmented
          value={String(e.tabSize)}
          options={[{ value: '2', label: '2' }, { value: '4', label: '4' }, { value: '8', label: '8' }]}
          onChange={(v) => set({ editor: { tabSize: Number(v) } })}
        />
      </Row>
      <Row label="Word wrap">
        <Toggle checked={e.wordWrap === 'on'} onChange={(v) => set({ editor: { wordWrap: v ? 'on' : 'off' } })} />
      </Row>
      <Row label="Minimap">
        <Toggle checked={e.minimap} onChange={(minimap) => set({ editor: { minimap } })} />
      </Row>
      <Row label="Render whitespace">
        <Segmented
          value={e.renderWhitespace}
          options={[{ value: 'none', label: 'None' }, { value: 'selection', label: 'Selection' }, { value: 'all', label: 'All' }]}
          onChange={(renderWhitespace) => set({ editor: { renderWhitespace } })}
        />
      </Row>
      <Row label="Format on save" hint="No formatter is wired yet — this is a placeholder.">
        <Toggle checked={e.formatOnSave} onChange={(formatOnSave) => set({ editor: { formatOnSave } })} />
      </Row>
    </>
  );
}

const PERMISSION_OPTIONS: Array<{ value: PermissionModeSetting; label: string; hint: string }> = [
  { value: 'default', label: 'Ask', hint: 'Prompt before edits and commands.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Apply file edits without asking; still prompt for commands.' },
  { value: 'plan', label: 'Plan', hint: 'Research & propose a plan; make no changes.' },
  { value: 'auto', label: 'Auto', hint: 'Claude picks the safest mode for each task.' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Never prompt — edits and commands run freely.' },
];

function AgentSection() {
  const ag = useSettingsStore((s) => s.settings.agent);
  const set = useSettingsStore((s) => s.set);
  return (
    <>
      <p className="set-note">These are the <strong>defaults for new conversations</strong>. Change a conversation's mode, effort, or model on the fly with the run-mode picker in the composer (⇧+Tab cycles modes).</p>
      <Row label="Model">
        <div className="set-radios">
          {MODEL_OPTIONS.map((m) => {
            const on = ag.model === m.id;
            return (
              <button key={m.id} type="button" className={`set-radio ${on ? 'is-on' : ''}`} onClick={() => set({ agent: { model: m.id } })}>
                <span className="set-radio__dot" aria-hidden>{on && <Check size={11} strokeWidth={3} />}</span>
                {m.label}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Permission mode" hint={PERMISSION_OPTIONS.find((p) => p.value === ag.permissionMode)?.hint}>
        <Segmented
          value={ag.permissionMode}
          options={PERMISSION_OPTIONS.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(permissionMode) => set({ agent: { permissionMode } })}
        />
      </Row>
      <Row label="Reasoning effort" hint="Higher effort thinks longer; Default lets the model decide.">
        <Segmented
          value={ag.effort}
          options={[
            { value: '', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Med' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'X-High' },
            { value: 'max', label: 'Max' },
          ]}
          onChange={(effort) => set({ agent: { effort } })}
        />
      </Row>
      <Row label="Turn limit" hint="Cap automatic agent turns per conversation.">
        <div className="set-inline">
          <Toggle checked={!!ag.maxTurns} onChange={(on) => set({ agent: { maxTurns: on ? 20 : 0 } })} />
          {!!ag.maxTurns && (
            <Stepper value={ag.maxTurns} min={1} max={200} step={5} onChange={(maxTurns) => set({ agent: { maxTurns } })} />
          )}
        </div>
      </Row>
      <Row label="Cost limit" hint="Stop a conversation once it spends this much.">
        <div className="set-inline">
          <Toggle checked={!!ag.maxBudgetUsd} onChange={(on) => set({ agent: { maxBudgetUsd: on ? 5 : 0 } })} />
          {!!ag.maxBudgetUsd && (
            <Stepper value={ag.maxBudgetUsd} min={1} max={500} step={1} prefix="$" onChange={(maxBudgetUsd) => set({ agent: { maxBudgetUsd } })} />
          )}
        </div>
      </Row>
      <McpServers servers={ag.mcpServers} onChange={(mcpServers) => set({ agent: { mcpServers } })} />
    </>
  );
}

// ── MCP server management (Agent section) ────────────────────────────────────

type McpDraft = { name: string; transport: 'stdio' | 'http' | 'sse'; command: string; args: string; url: string };
const EMPTY_DRAFT: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '' };

function specToDraft(name: string, spec: McpServerSpec): McpDraft {
  if ('url' in spec) return { name, transport: spec.type, command: '', args: '', url: spec.url };
  return { name, transport: 'stdio', command: spec.command, args: (spec.args ?? []).join(' '), url: '' };
}

function draftToSpec(d: McpDraft): McpServerSpec | null {
  if (d.transport === 'stdio') {
    if (!d.command.trim()) return null;
    const args = d.args.trim() ? d.args.trim().split(/\s+/) : undefined;
    return { type: 'stdio', command: d.command.trim(), ...(args ? { args } : {}) };
  }
  if (!d.url.trim()) return null;
  return { type: d.transport, url: d.url.trim() };
}

function McpServers({ servers, onChange }: {
  servers: Record<string, McpServerSpec>;
  onChange: (next: Record<string, McpServerSpec>) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null); // key being edited, '' = new
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(servers);

  const startAdd = () => { setDraft(EMPTY_DRAFT); setEditing(''); setError(null); };
  const startEdit = (name: string) => { setDraft(specToDraft(name, servers[name])); setEditing(name); setError(null); };
  const cancel = () => { setEditing(null); setError(null); };

  const remove = (name: string) => {
    const next = { ...servers }; delete next[name]; onChange(next);
  };

  const save = () => {
    const name = draft.name.trim();
    if (!name) { setError('Name is required.'); return; }
    const spec = draftToSpec(draft);
    if (!spec) { setError(draft.transport === 'stdio' ? 'A command is required.' : 'A URL is required.'); return; }
    const next = { ...servers };
    if (editing && editing !== name) delete next[editing]; // renamed
    next[name] = spec;
    onChange(next);
    setEditing(null);
  };

  return (
    <div className="set-mcp">
      <div className="set-mcp__head">
        <div>
          <div className="set-row__label">MCP servers</div>
          <div className="set-row__hint">Model Context Protocol tools the agent can call.</div>
        </div>
        {editing === null && (
          <button type="button" className="set-btn set-btn--ghost" onClick={startAdd}><Plus size={13} strokeWidth={2} /> Add</button>
        )}
      </div>

      {entries.length === 0 && editing === null && (
        <div className="set-mcp__empty"><Server size={15} strokeWidth={1.75} /> No MCP servers configured.</div>
      )}

      <div className="set-mcp__list">
        {entries.map(([name, spec]) => (
          <div key={name} className="set-mcp__item">
            <div className="set-mcp__item-info">
              <span className="set-mcp__name">{name}</span>
              <span className="set-mcp__meta">{'url' in spec ? `${spec.type} · ${spec.url}` : `stdio · ${spec.command}`}</span>
            </div>
            <div className="set-mcp__item-actions">
              <button type="button" className="set-icon-btn" onClick={() => startEdit(name)} aria-label="Edit"><Pencil size={13} strokeWidth={1.75} /></button>
              <button type="button" className="set-icon-btn set-icon-btn--danger" onClick={() => remove(name)} aria-label="Remove"><Trash2 size={13} strokeWidth={1.75} /></button>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {editing !== null && (
          <motion.div
            className="set-mcp__form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={ANIM}
          >
            <input className="set-input" placeholder="Name (e.g. github)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Segmented
              value={draft.transport}
              options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }, { value: 'sse', label: 'sse' }]}
              onChange={(transport) => setDraft({ ...draft, transport })}
            />
            {draft.transport === 'stdio' ? (
              <>
                <input className="set-input" placeholder="Command (e.g. npx)" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                <input className="set-input" placeholder="Arguments (space-separated)" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
              </>
            ) : (
              <input className="set-input" placeholder="URL (https://…)" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            )}
            {error && <div className="set-mcp__error">{error}</div>}
            <div className="set-mcp__form-actions">
              <button type="button" className="set-btn set-btn--ghost" onClick={cancel}><X size={13} strokeWidth={2} /> Cancel</button>
              <button type="button" className="set-btn set-btn--primary" onClick={save}><Check size={13} strokeWidth={2} /> Save</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AccountSection() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [view, setView] = useState<'account' | 'plan'>('account');
  const signedIn = status === 'authed' && user;

  // If the user signs out (here or in another window) while parked in the plan
  // sub-view, fall back to the account view so a later sign-in doesn't re-open it.
  useEffect(() => { if (!signedIn) setView('account'); }, [signedIn]);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === 'plan' && signedIn ? (
        <motion.div key="plan" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={ANIM}>
          <PlansView mode="settings" onBack={() => setView('account')} />
        </motion.div>
      ) : (
        <motion.div key="account" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={ANIM}>
          {signedIn ? (
            <>
              <div className="set-account">
                <div className="set-account__avatar" aria-hidden>{(user.name ?? user.email).slice(0, 1).toUpperCase()}</div>
                <div className="set-account__info">
                  {user.name && <div className="set-account__name">{user.name}</div>}
                  <div className="set-account__email">{user.email}</div>
                </div>
              </div>
              {user.orgName && (
                <Row label="Organization">
                  <span className="set-account__type">{user.orgName}</span>
                </Row>
              )}
              {user.plan && (
                <>
                  <Row label="Plan" hint={user.plan !== 'free' ? `Billed ${user.interval ?? 'monthly'}` : 'Free plan'}>
                    <span className="set-plan-badge">{planById(user.plan).name}</span>
                  </Row>
                  <button type="button" className="set-btn set-btn--ghost" onClick={() => setView('plan')}>
                    <SlidersHorizontal size={13} strokeWidth={1.75} /> Manage plan
                  </button>
                </>
              )}
              <button type="button" className="set-btn set-btn--danger-outline" onClick={() => void logout()}>
                <LogOut size={13} strokeWidth={1.75} /> Sign out
              </button>
            </>
          ) : (
            <p className="set-note">You're not signed in. Sign-in is optional on desktop — open the account menu on the Home screen to connect a cloud account.</p>
          )}
          <Row label="Backend" hint="Cloud API origin (set via CCB_BACKEND_ORIGIN).">
            <code className="set-code">{window.ccb.backendOrigin || '—'}</code>
          </Row>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function GeneralSection() {
  const g = useSettingsStore((s) => s.settings.general);
  const set = useSettingsStore((s) => s.set);
  const recents = useRecentsStore((s) => s.items);
  const removeRecent = useRecentsStore((s) => s.remove);
  const tasksRailOpen = useUiStore((s) => s.tasksRailOpen);
  const stateRailOpen = useUiStore((s) => s.stateRailOpen);

  return (
    <>
      <Row label="Show Tasks rail" hint="The left rail with conversations & recents.">
        {/* The settings-store mirrors rail changes back to disk (see init). */}
        <Toggle checked={tasksRailOpen} onChange={(v) => useUiStore.setState({ tasksRailOpen: v })} />
      </Row>
      <Row label="Show State rail" hint="The right rail with the file tree & inspector.">
        <Toggle checked={stateRailOpen} onChange={(v) => useUiStore.setState({ stateRailOpen: v })} />
      </Row>
      <Row label="Reopen last project on launch">
        <Toggle checked={g.reopenLastProject} onChange={(reopenLastProject) => set({ general: { reopenLastProject } })} />
      </Row>
      <Row label="Recent projects" hint={`${recents.length} remembered.`}>
        <button type="button" className="set-btn set-btn--ghost" disabled={recents.length === 0} onClick={() => { for (const r of recents) void removeRecent(r.path); }}>
          <Trash2 size={13} strokeWidth={1.75} /> Clear recents
        </button>
      </Row>
    </>
  );
}

function AboutSection() {
  const version = useConnectionStore((s) => s.serverVersion);
  const open = (url: string) => () => { void window.ccb.fs.openExternal(url); };
  return (
    <div className="set-about">
      <div className="set-about__glyph" aria-hidden><BrandMark size={52} /></div>
      <h2 className="set-about__title">Fineguide Tesseract</h2>
      <div className="set-about__version">{version ? `Version ${version}` : 'Connecting…'}</div>
      <p className="set-about__desc">
        An AI-native desktop workspace — an embedded browser and Photoshop-style HTML editor on top of Claude Code.
      </p>
      <div className="set-about__links">
        <button type="button" className="set-btn set-btn--ghost" onClick={open(REPO_URL)}><ExternalLink size={13} strokeWidth={1.75} /> GitHub</button>
        <button type="button" className="set-btn set-btn--ghost" onClick={open(STORE_URL)}><ExternalLink size={13} strokeWidth={1.75} /> Chrome Web Store</button>
      </div>
      <div className="set-about__footer">© Fineguide.AI · MIT License</div>
    </div>
  );
}

// ── Panel shell ──────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const active = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        {SECTIONS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`settings__nav-item ${active === id ? 'is-on' : ''}`}
            onClick={() => setSection(id)}
          >
            {active === id && <motion.span layoutId="settings-nav-active" className="settings__nav-active" transition={ANIM} />}
            <Icon size={15} strokeWidth={1.75} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="settings__body">
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            className="settings__section"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={ANIM}
          >
            <h1 className="settings__heading">{SECTIONS.find((s) => s.id === active)?.label}</h1>
            {active === 'appearance' && <AppearanceSection />}
            {active === 'editor' && <EditorSection />}
            {active === 'agent' && <AgentSection />}
            {active === 'account' && <AccountSection />}
            {active === 'general' && <GeneralSection />}
            {active === 'about' && <AboutSection />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
