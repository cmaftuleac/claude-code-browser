import type { TabKey } from './tab-key';

/**
 * The workspace split layout — a recursive tree of editor groups (VS Code style).
 *
 *  • A `group` is a leaf: an ordered list of tabs + which one is active. Each
 *    group renders its own tab strip.
 *  • A `split` arranges N children left-to-right (`row`) or top-to-bottom
 *    (`column`) with resizable fractional `sizes` (always sum to 1).
 *
 * Invariants enforced by {@link collapse} + {@link ensureRootSplit}:
 *  • no empty groups; no empty / single-child splits below the root;
 *  • adjacent same-direction splits are flattened;
 *  • `sizes.length === children.length` and sums to 1;
 *  • the ROOT is always a `split` (a lone group lives as a 1-child root split)
 *    so first-level splits don't re-parent — and therefore don't remount —
 *    the source group's content.
 */
export type SplitDirection = 'row' | 'column';

export interface GroupNode {
  type: 'group';
  id: string;
  tabs: TabKey[];
  activeIndex: number;
}

export interface SplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = GroupNode | SplitNode;

/* ── id generation ─────────────────────────────────────────────────────── */

let idCounter = 0;
export function newGroupId(): string { return `g${++idCounter}`; }
export function newSplitId(): string { return `s${++idCounter}`; }

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

export function makeGroup(tabs: TabKey[], activeIndex = 0): GroupNode {
  return { type: 'group', id: newGroupId(), tabs, activeIndex: clampIndex(activeIndex, tabs.length) };
}

/* ── queries ───────────────────────────────────────────────────────────── */

export function findGroup(node: LayoutNode, id: string): GroupNode | null {
  if (node.type === 'group') return node.id === id ? node : null;
  for (const c of node.children) {
    const g = findGroup(c, id);
    if (g) return g;
  }
  return null;
}

export function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  if (node.type === 'split') {
    for (const c of node.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
  }
  return null;
}

export function findGroupOfTab(node: LayoutNode, key: TabKey): GroupNode | null {
  if (node.type === 'group') return node.tabs.includes(key) ? node : null;
  for (const c of node.children) {
    const g = findGroupOfTab(c, key);
    if (g) return g;
  }
  return null;
}

export function findParentSplit(root: LayoutNode, childId: string): SplitNode | null {
  if (root.type === 'group') return null;
  for (const c of root.children) {
    if (c.id === childId) return root;
    const p = findParentSplit(c, childId);
    if (p) return p;
  }
  return null;
}

export function collectTabKeys(node: LayoutNode): TabKey[] {
  if (node.type === 'group') return [...node.tabs];
  return node.children.flatMap(collectTabKeys);
}

export function collectGroups(node: LayoutNode): GroupNode[] {
  if (node.type === 'group') return [node];
  return node.children.flatMap(collectGroups);
}

/** Leftmost-topmost leaf — the focus fallback after a group is removed. */
export function firstGroup(node: LayoutNode): GroupNode {
  let n: LayoutNode = node;
  while (n.type === 'split') n = n.children[0];
  return n;
}

export function locateTab(root: LayoutNode, key: TabKey): { groupId: string; index: number } | null {
  const g = findGroupOfTab(root, key);
  if (!g) return null;
  return { groupId: g.id, index: g.tabs.indexOf(key) };
}

export function activeKeyOf(g: GroupNode): TabKey | undefined {
  return g.tabs[clampIndex(g.activeIndex, g.tabs.length)];
}

/* ── size math ─────────────────────────────────────────────────────────── */

export function renormalize(sizes: number[], n: number): number[] {
  if (n <= 0) return [];
  if (sizes.length !== n) return Array(n).fill(1 / n);
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return Array(n).fill(1 / n);
  return sizes.map((s) => s / sum);
}

/* ── structural edits (pure; always return a NEW tree) ─────────────────── */

/** Replace the node with `id` by `next`; `next === null` removes it (its parent
 *  split drops the child + its size slice). Does NOT collapse — callers run
 *  {@link collapse} afterwards. */
export function replaceNode(root: LayoutNode, id: string, next: LayoutNode | null): LayoutNode | null {
  if (root.id === id) return next;
  if (root.type === 'group') return root;
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const replaced = replaceNode(child, id, next);
    if (replaced != null) { kids.push(replaced); sizes.push(root.sizes[i]); }
  });
  return { ...root, children: kids, sizes };
}

/**
 * Enforce the tree invariants, bottom-up:
 *  1. recurse into children first;
 *  2. drop empty groups (and their size slice);
 *  3. drop empty splits; collapse a single-child split into that child;
 *  4. flatten a child split of the same direction (multiplying sizes);
 *  5. renormalize surviving sizes proportionally.
 * Returns `null` when the whole tree empties.
 */
export function collapse(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'group') return node.tabs.length === 0 ? null : node;

  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const c = collapse(child);
    if (c == null) return;
    if (c.type === 'split' && c.direction === node.direction) {
      // Flatten: splice the grandchildren up, scaling their sizes by this slot.
      c.children.forEach((gc, j) => { kids.push(gc); sizes.push(node.sizes[i] * c.sizes[j]); });
    } else {
      kids.push(c);
      sizes.push(node.sizes[i]);
    }
  });

  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { ...node, children: kids, sizes: renormalize(sizes, kids.length) };
}

/** Keep the root a `split` so a lone group never re-parents on its first split. */
export function ensureRootSplit(node: LayoutNode | null): LayoutNode | null {
  if (node == null) return null;
  if (node.type === 'split') return node;
  return { type: 'split', id: newSplitId(), direction: 'row', children: [node], sizes: [1] };
}

/** collapse + re-wrap root — the normal form applied after every structural edit. */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  return ensureRootSplit(collapse(node));
}

/**
 * Move a group's active tab into a NEW sibling group (one-pane-per-tab). Returns
 * `newGroupId: null` (a no-op) when the group has ≤1 tab — splitting would just
 * duplicate the layout. When the parent split matches `direction` (or is the
 * single-child root wrapper), the new group is inserted as a sibling so 2×N
 * grids stay flat and the source group keeps its React position.
 */
/** Shared tree surgery: place `created` as a new sibling of `groupId`, with the
 *  source group replaced by `source`. When the parent split matches `direction`
 *  (or is the single-child root wrapper) the new group is inserted as a sibling
 *  so 2×N grids stay flat and the source keeps its React position (no remount).
 *
 *  Caveat: splitting a group PERPENDICULAR to a multi-child parent must wrap it
 *  in a new split node, which changes its slot's React key — so the source group
 *  remounts. Monaco state survives (FileEditor keepCurrentModel + central model
 *  pruning) and the Preview survives (single overlay webview), so the only loss
 *  is transient (e.g. a conversation pane's scroll position). */
function placeSibling(
  root: LayoutNode,
  groupId: string,
  direction: SplitDirection,
  position: 'before' | 'after',
  source: GroupNode,
  created: GroupNode,
): { root: LayoutNode | null; newGroupId: string } {
  const parent = findParentSplit(root, groupId);
  let next: LayoutNode;
  if (parent && (parent.direction === direction || parent.children.length === 1)) {
    const dir = parent.children.length === 1 ? direction : parent.direction;
    const idx = parent.children.findIndex((c) => c.id === groupId);
    const kids = [...parent.children];
    const sizes = [...parent.sizes];
    kids[idx] = source;
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    const insertAt = position === 'after' ? idx + 1 : idx;
    kids.splice(insertAt, 0, created);
    sizes.splice(insertAt, 0, half);
    const newParent: SplitNode = { ...parent, direction: dir, children: kids, sizes };
    next = replaceNode(root, parent.id, newParent)!;
  } else {
    const children = position === 'after' ? [source, created] : [created, source];
    const split: SplitNode = { type: 'split', id: newSplitId(), direction, children, sizes: [0.5, 0.5] };
    next = replaceNode(root, groupId, split)!;
  }
  return { root: normalize(next), newGroupId: created.id };
}

/** Move a group's active tab into a new sibling group. No-op (newGroupId null)
 *  for a single-tab group — the caller handles that case (e.g. open a scratch
 *  file in the new pane). */
export function splitGroup(
  root: LayoutNode,
  groupId: string,
  direction: SplitDirection,
  position: 'before' | 'after',
): { root: LayoutNode | null; newGroupId: string | null } {
  const group = findGroup(root, groupId);
  if (!group || group.tabs.length <= 1) return { root, newGroupId: null };
  const moving = activeKeyOf(group)!;
  const remaining = group.tabs.filter((k) => k !== moving);
  const source: GroupNode = { ...group, tabs: remaining, activeIndex: clampIndex(group.activeIndex, remaining.length) };
  return placeSibling(root, groupId, direction, position, source, makeGroup([moving], 0));
}

/** Open `newKey` in a brand-new sibling group, leaving the source group intact.
 *  Used to make splitting a single-tab pane create a fresh scratch file beside
 *  it rather than being a no-op. */
export function splitGroupNewTab(
  root: LayoutNode,
  groupId: string,
  direction: SplitDirection,
  position: 'before' | 'after',
  newKey: TabKey,
): { root: LayoutNode | null; newGroupId: string | null } {
  const group = findGroup(root, groupId);
  if (!group) return { root, newGroupId: null };
  return placeSibling(root, groupId, direction, position, { ...group }, makeGroup([newKey], 0));
}

/** Replace one tab key everywhere it appears (used to promote an untitled tab
 *  to its real path after Save As). */
export function renameTab(root: LayoutNode, oldKey: TabKey, newKey: TabKey): LayoutNode {
  if (root.type === 'group') {
    return root.tabs.includes(oldKey)
      ? { ...root, tabs: root.tabs.map((k) => (k === oldKey ? newKey : k)) }
      : root;
  }
  return { ...root, children: root.children.map((c) => renameTab(c, oldKey, newKey)) };
}

/** Set which tab is active within a group (no structural change). */
export function setGroupActive(root: LayoutNode, groupId: string, index: number): LayoutNode {
  if (root.type === 'group') {
    return root.id === groupId ? { ...root, activeIndex: clampIndex(index, root.tabs.length) } : root;
  }
  return { ...root, children: root.children.map((c) => setGroupActive(c, groupId, index)) };
}

/** Replace a split's fractional sizes (already clamped/normalized by the caller). */
export function resizeSplit(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'group') return root;
  if (root.id === splitId) {
    // Ignore a stale-length write (the split changed shape between the drag's
    // pointerdown snapshot and this move) — applying it would break sum-to-1.
    if (sizes.length !== root.children.length) return root;
    return { ...root, sizes };
  }
  return { ...root, children: root.children.map((c) => resizeSplit(c, splitId, sizes)) };
}

/** Replace a group's whole tab list + active index (used by drag-to-move). */
export function setGroupTabs(root: LayoutNode, groupId: string, tabs: TabKey[], activeIndex: number): LayoutNode {
  if (root.type === 'group') {
    return root.id === groupId ? { ...root, tabs, activeIndex: clampIndex(activeIndex, tabs.length) } : root;
  }
  return { ...root, children: root.children.map((c) => setGroupTabs(c, groupId, tabs, activeIndex)) };
}

/**
 * Move `key` into `targetGroupId` at `index` (default end). Same-group is a
 * reorder; cross-group removes from the source (collapsing it if it empties) and
 * inserts into the target, which becomes active there. Returns `moved:false`
 * when nothing changed (e.g. dropped back in place) or the tab/target is gone.
 */
export function moveTab(
  root: LayoutNode,
  key: TabKey,
  targetGroupId: string,
  index?: number,
): { root: LayoutNode | null; moved: boolean } {
  const src = findGroupOfTab(root, key);
  const tgt = findGroup(root, targetGroupId);
  if (!src || !tgt) return { root, moved: false };

  if (src.id === targetGroupId) {
    const from = src.tabs.indexOf(key);
    const without = src.tabs.filter((k) => k !== key);
    // `index` was computed against the strip that still contained the dragged
    // tab; once it's removed, anything past its old slot shifts left by one.
    let at = index == null ? without.length : index;
    if (from !== -1 && from < at) at -= 1;
    at = Math.max(0, Math.min(at, without.length));
    const tabs = [...without.slice(0, at), key, ...without.slice(at)];
    if (tabs.length === src.tabs.length && tabs.every((k, i) => k === src.tabs[i])) {
      return { root, moved: false };
    }
    return { root: setGroupTabs(root, src.id, tabs, at), moved: true };
  }

  // Cross-group: drop `key` from the source, re-pinning its active tab.
  const srcActiveKey = activeKeyOf(src);
  const srcTabs = src.tabs.filter((k) => k !== key);
  let srcActive = srcActiveKey != null && srcActiveKey !== key ? srcTabs.indexOf(srcActiveKey) : -1;
  if (srcActive < 0) srcActive = clampIndex(src.activeIndex, srcTabs.length);
  let next = setGroupTabs(root, src.id, srcTabs, srcActive);

  const tgtNow = findGroup(next, targetGroupId)!;
  const at = index == null ? tgtNow.tabs.length : Math.max(0, Math.min(index, tgtNow.tabs.length));
  const tabs = [...tgtNow.tabs.slice(0, at), key, ...tgtNow.tabs.slice(at)];
  next = setGroupTabs(next, targetGroupId, tabs, at);
  return { root: normalize(next), moved: true };
}

/** Append tabs to the end of a specific group's strip. */
export function appendTabs(root: LayoutNode, groupId: string, keys: TabKey[]): LayoutNode {
  if (root.type === 'group') {
    return root.id === groupId ? { ...root, tabs: [...root.tabs, ...keys] } : root;
  }
  return { ...root, children: root.children.map((c) => appendTabs(c, groupId, keys)) };
}

/**
 * Drop any tab not in `live` from every group (and de-dupe: a key kept in the
 * first group that holds it is removed from any later group). Each group's
 * `activeIndex` is re-pinned to the tab that was active, or snapped to a nearby
 * survivor. Empty groups are left for {@link collapse} to remove.
 */
export function pruneDead(node: LayoutNode | null, live: Set<TabKey>, seen: Set<TabKey> = new Set()): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    const wasActive = activeKeyOf(node);
    const tabs: TabKey[] = [];
    for (const k of node.tabs) {
      if (live.has(k) && !seen.has(k)) { tabs.push(k); seen.add(k); }
    }
    let activeIndex = wasActive != null ? tabs.indexOf(wasActive) : -1;
    if (activeIndex < 0) activeIndex = clampIndex(node.activeIndex, tabs.length);
    return { ...node, tabs, activeIndex };
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const p = pruneDead(child, live, seen);
    if (p != null) { kids.push(p); sizes.push(node.sizes[i]); }
  });
  return { ...node, children: kids, sizes };
}
