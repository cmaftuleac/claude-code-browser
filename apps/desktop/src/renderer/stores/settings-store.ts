import { create } from 'zustand';
import {
  type Settings,
  type SettingsPatch,
  type ThemeMode,
  DEFAULT_SETTINGS,
} from '@fineguide-tesseract/shared';
import { useUiStore } from './ui-store';

/**
 * Renderer mirror of the persisted user settings. Hydrates from
 * `window.ccb.settings.load()` on init, writes through `window.ccb.settings.save`
 * (optimistically updating locally first), and stays in sync with other windows
 * via `settings:onChange`. Appearance changes (theme / accent / density) are
 * applied to the document root immediately so the UI re-themes live.
 */

type ResolvedTheme = 'light' | 'dark';

/** The light/dark bucket a named theme paints in — what Monaco & code highlighting
 *  key off. `claude` and `white` are both light; only `dark` is dark. */
function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'dark' ? 'dark' : 'light';
}

/** Push appearance settings onto <html> so CSS vars + Monaco pick them up.
 *  `data-theme` carries the named theme (`claude` falls through to the :root base;
 *  `white`/`dark` have override blocks in styles.css). */
function applyAppearance(s: Settings['appearance']): ResolvedTheme {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.style.setProperty('--accent', s.accent);
  return resolveTheme(s.theme);
}

/** Local equivalent of main's saveSettings merge — applied optimistically. */
function mergePatch(cur: Settings, patch: SettingsPatch): Settings {
  return {
    version: 1,
    appearance: { ...cur.appearance, ...patch.appearance },
    editor: { ...cur.editor, ...patch.editor },
    agent: {
      ...cur.agent,
      ...patch.agent,
      mcpServers: patch.agent?.mcpServers ?? cur.agent.mcpServers,
    },
    general: { ...cur.general, ...patch.general },
  };
}

interface SettingsState {
  settings: Settings;
  /** The light/dark bucket the active theme paints in (Monaco/code highlighting). */
  resolvedTheme: ResolvedTheme;
  hydrated: boolean;
  init(): Promise<void>;
  /** Merge a patch, apply appearance, and persist (cross-window broadcast). */
  set(patch: SettingsPatch): void;
}

let inited = false;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  resolvedTheme: resolveTheme(DEFAULT_SETTINGS.appearance.theme),
  hydrated: false,

  init: async () => {
    if (inited) return; // StrictMode-safe
    inited = true;

    // Other windows changing settings (or main's authoritative copy).
    window.ccb.settings.onChange((next) => {
      set({ settings: next, resolvedTheme: applyAppearance(next.appearance) });
    });

    const loaded = await window.ccb.settings.load();
    set({ settings: loaded, resolvedTheme: applyAppearance(loaded.appearance), hydrated: true });

    // Rail visibility is persisted: seed the live UI store from settings, then
    // mirror any later change (from the View menu or the General section) back
    // into settings. The guard keeps this from looping with our own writes.
    useUiStore.setState({
      tasksRailOpen: loaded.general.tasksRailOpen,
      stateRailOpen: loaded.general.stateRailOpen,
    });
    useUiStore.subscribe((state, prev) => {
      if (state.tasksRailOpen === prev.tasksRailOpen && state.stateRailOpen === prev.stateRailOpen) return;
      const g = get().settings.general;
      if (g.tasksRailOpen !== state.tasksRailOpen || g.stateRailOpen !== state.stateRailOpen) {
        get().set({ general: { tasksRailOpen: state.tasksRailOpen, stateRailOpen: state.stateRailOpen } });
      }
    });
  },

  set: (patch) => {
    const next = mergePatch(get().settings, patch);
    set({ settings: next, resolvedTheme: applyAppearance(next.appearance) });
    void window.ccb.settings.save(patch);
  },
}));
