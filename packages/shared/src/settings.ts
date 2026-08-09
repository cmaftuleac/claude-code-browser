/**
 * Agent run-mode types shared by the side panel (the run-mode picker) and the
 * native messaging host.
 *
 * TYPE-ONLY plus one `const` table — safe to import from the extension bundle
 * and from the Node host alike.
 */

/**
 * The agent permission modes we expose in the UI. A structural subset of the
 * SDK's `PermissionMode` (we omit `dontAsk`). `bypassPermissions` stays the
 * default to preserve the extension's current behavior. `auto` lets Claude pick
 * the safest mode per task.
 */
export type PermissionModeSetting = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';

/** Reasoning effort, mirrors the SDK's `EffortLevel`. `''` (unset) ⇒ SDK default.
 *  `xhigh` ("Extra high") is supported on select models only. */
export type EffortSetting = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Fallback model list for the picker, newest/most-capable first. `model: ''`
 * (SDK default) is also valid.
 *
 * The host asks the running CLI for its real list via `Query.supportedModels()`
 * and pushes it to the panel as `agent:models`; this table is only what the
 * picker shows before the first session exists (or if that call fails), so it
 * can go stale without breaking anything.
 */
export const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
