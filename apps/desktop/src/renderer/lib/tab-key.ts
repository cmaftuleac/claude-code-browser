import type { ActiveTab } from '../stores/ui-store';

/** A tab's stable string identity, used as its key everywhere in the layout
 *  tree, as React keys, and for cheap set-diffing during reconcile.
 *    conv     → `conv:<taskId>`
 *    file     → `file:<path>`
 *    browser  → `browser:<browserId>` (one per embedded browser instance)
 *    settings → `settings:` (singleton per window) */
export type TabKey = string;

export function tabKey(tab: ActiveTab): TabKey {
  switch (tab.kind) {
    case 'conv': return `conv:${tab.taskId}`;
    case 'file': return `file:${tab.path}`;
    case 'browser': return `browser:${tab.id}`;
    case 'settings': return 'settings:';
  }
}

/** Inverse of {@link tabKey}. Splits on the *first* colon only, so file paths
 *  (and browser uuids, which contain no colon) round-trip correctly. */
export function parseTabKey(key: TabKey): ActiveTab {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === 'conv') return { kind: 'conv', taskId: rest };
  if (kind === 'browser') return { kind: 'browser', id: rest };
  if (kind === 'settings') return { kind: 'settings' };
  return { kind: 'file', path: rest };
}
