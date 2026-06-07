/**
 * Desktop auto-update event, broadcast from the Electron main process to every
 * renderer over the `updater:event` IPC channel. The renderer keeps only the
 * latest one and surfaces a subtle "Update ready" pill on `downloaded`.
 *
 * The flow is intentionally quiet: `checking` → `available` → `progress` →
 * `downloaded`. The update is staged and applied on the next quit; the pill
 * just lets eager users apply it immediately. `none`/`error` are terminal for
 * a given check cycle and never surface UI on their own.
 */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string };
