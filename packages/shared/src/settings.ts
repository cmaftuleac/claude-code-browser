/**
 * User-configurable application settings for the desktop app (and, where it
 * makes sense, the web build). Persisted as plain JSON in the main process
 * (`userData/settings.json`) and mirrored into a renderer zustand store.
 *
 * TYPE-ONLY + a couple of `const` defaults — safe to import from main, the
 * preload bridge, the renderer, and the web transport alike.
 */

/**
 * Appearance theme — three explicit named palettes:
 *  - `claude`: the default warm cream look (Claude coral on cream surfaces).
 *  - `white`:  a clean, cool, neutral light palette.
 *  - `dark`:   a warm-dark counterpart of the cream palette.
 * `claude` and `white` both render as a "light" editor/code theme; `dark` is dark.
 */
export type ThemeMode = 'claude' | 'white' | 'dark';

/** UI density — affects paddings/row heights via a body data-attribute. */
export type Density = 'comfortable' | 'compact';

/**
 * The agent permission modes we expose in the UI. A structural subset of the
 * SDK's `PermissionMode` (we omit `dontAsk`). `bypassPermissions` stays the
 * default to preserve the app's current behavior. `auto` lets Claude pick the
 * safest mode per task (requires the SDK build that ships it — pinned at 0.2.112).
 */
export type PermissionModeSetting = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';

/** Reasoning effort, mirrors the SDK's `EffortLevel`. `''` (unset) ⇒ SDK default.
 *  `xhigh` ("Extra high") is supported on select models only. */
export type EffortSetting = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Monaco's word-wrap setting (a subset of the editor's option). */
export type WordWrapSetting = 'on' | 'off';

/** Monaco's render-whitespace setting. */
export type RenderWhitespaceSetting = 'none' | 'selection' | 'all';

/**
 * A single MCP server entry, structurally compatible with the SDK's
 * `McpServerConfig` (minus the in-process `sdk` variant, which isn't
 * user-configurable). agent-core casts these straight into `query()`.
 */
export type McpServerSpec =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

export interface EditorSettings {
  /** Monaco font size in px. */
  fontSize: number;
  /** Spaces per indentation level. */
  tabSize: number;
  wordWrap: WordWrapSetting;
  minimap: boolean;
  renderWhitespace: RenderWhitespaceSetting;
  /** Stubbed for now — no formatter is wired yet. */
  formatOnSave: boolean;
}

export interface AgentSettings {
  /** Claude model id (e.g. `claude-opus-4-8`). Empty ⇒ SDK default. */
  model: string;
  permissionMode: PermissionModeSetting;
  /** Reasoning effort. '' ⇒ SDK default. */
  effort: EffortSetting;
  /** Configured MCP servers, keyed by display name. */
  mcpServers: Record<string, McpServerSpec>;
  /** Hard turn cap per conversation (0/undefined ⇒ unbounded). */
  maxTurns?: number;
  /** Per-conversation spend ceiling in USD (0/undefined ⇒ unbounded). */
  maxBudgetUsd?: number;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  /** Accent color as a hex string, bound to the `--accent` CSS var. */
  accent: string;
  density: Density;
}

export interface GeneralSettings {
  /** Persist the left Tasks rail open/closed across launches. */
  tasksRailOpen: boolean;
  /** Persist the right State rail open/closed across launches. */
  stateRailOpen: boolean;
  /** Reopen the last project automatically on launch. */
  reopenLastProject: boolean;
}

/** The full settings object. Versioned so future migrations are unambiguous. */
export interface Settings {
  version: 1;
  appearance: AppearanceSettings;
  editor: EditorSettings;
  agent: AgentSettings;
  general: GeneralSettings;
}

/** Latest available models, newest/most-capable first. The UI offers these;
 *  `model: ''` (SDK default) is also valid. Kept here so main + renderer agree. */
export const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

/** Defaults mirror today's hardcoded behavior so turning settings on changes
 *  nothing until the user edits something. */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  appearance: {
    // Defaults mirror the current hardcoded look: the warm cream "Claude Code" theme.
    theme: 'claude',
    accent: '#d97757',
    density: 'comfortable',
  },
  editor: {
    fontSize: 13,
    tabSize: 2,
    wordWrap: 'off',
    minimap: true,
    renderWhitespace: 'selection',
    formatOnSave: false,
  },
  agent: {
    model: 'claude-opus-4-8',
    permissionMode: 'bypassPermissions',
    effort: '',
    mcpServers: {},
  },
  general: {
    tasksRailOpen: true,
    stateRailOpen: true,
    reopenLastProject: false,
  },
};

/** Coerce a stored theme to a valid named theme. Migrates the earlier
 *  `light`/`system` model (and anything unknown) to the `claude` default;
 *  `dark` carries over unchanged. */
function normalizeTheme(theme: unknown): ThemeMode {
  return theme === 'white' || theme === 'dark' ? theme : 'claude';
}

/** Deep-merge a stored (possibly partial / older) settings object over the
 *  defaults so missing keys are always populated. One level of nesting is
 *  enough for our shape. */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  if (!stored) return DEFAULT_SETTINGS;
  return {
    version: 1,
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...stored.appearance,
      theme: normalizeTheme(stored.appearance?.theme),
    },
    editor: { ...DEFAULT_SETTINGS.editor, ...stored.editor },
    agent: {
      ...DEFAULT_SETTINGS.agent,
      ...stored.agent,
      mcpServers: stored.agent?.mcpServers ?? DEFAULT_SETTINGS.agent.mcpServers,
    },
    general: { ...DEFAULT_SETTINGS.general, ...stored.general },
  };
}

/** A deep-partial used for incremental `save(patch)` calls from the renderer. */
export type SettingsPatch = {
  appearance?: Partial<AppearanceSettings>;
  editor?: Partial<EditorSettings>;
  agent?: Partial<AgentSettings>;
  general?: Partial<GeneralSettings>;
};
