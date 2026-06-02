/**
 * In-page visual editor — injected into the <webview> guest as its preload.
 *
 * Evolves the extension's content-script.ts: element picking + selector/XPath
 * generation + overlay highlighting, plus the Photoshop-style toolset (drag,
 * resize, stacking, quick actions) and an edit journal for "Save to code".
 *
 * All editing chrome lives *inside the guest page* so it tracks scroll/zoom
 * perfectly. It talks to the host renderer over webview IPC:
 *   guest → host:  ipcRenderer.sendToHost(channel, payload)
 *   host  → guest:  webviewEl.send(channel, payload)  → ipcRenderer.on(channel)
 */
import { ipcRenderer } from 'electron';

type EditType = 'style' | 'attr' | 'text' | 'move' | 'resize' | 'reparent';
interface JournalEntry {
  selector: string;
  xpath?: string;
  type: EditType;
  name?: string;
  before?: string;
  after?: string;
}

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const EDITOR_ATTR = 'data-ccb-editor';

let mode: 'browse' | 'edit' = 'browse';
let hovered: HTMLElement | null = null;
let selected: HTMLElement | null = null;
const journal: JournalEntry[] = [];

// ── Overlay chrome ───────────────────────────────────────────────────────────

let root: HTMLElement;
let hoverBox: HTMLElement;
let selectBox: HTMLElement;
let toolbar: HTMLElement;
const handles: Record<string, HTMLElement> = {};

function isEditorNode(el: Element | null): boolean {
  return !!el && (el.closest(`[${EDITOR_ATTR}]`) !== null);
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.setAttribute(EDITOR_ATTR, '');
  style.textContent = `
    [${EDITOR_ATTR}] { position: fixed; z-index: 2147483640; pointer-events: none; box-sizing: border-box; }
    .ccb-hover { border: 1px solid #4aa3ff; background: rgba(74,163,255,0.08); }
    .ccb-select { border: 1.5px solid #f5a623; }
    .ccb-handle { width: 9px; height: 9px; background: #f5a623; border: 1px solid #fff;
      border-radius: 2px; pointer-events: auto; }
    .ccb-handle.nw{cursor:nwse-resize}.ccb-handle.se{cursor:nwse-resize}
    .ccb-handle.ne{cursor:nesw-resize}.ccb-handle.sw{cursor:nesw-resize}
    .ccb-handle.n{cursor:ns-resize}.ccb-handle.s{cursor:ns-resize}
    .ccb-handle.e{cursor:ew-resize}.ccb-handle.w{cursor:ew-resize}
    .ccb-toolbar { display: flex; gap: 2px; padding: 3px; background: #2a2a2a;
      border: 1px solid #444; border-radius: 6px; pointer-events: auto;
      font: 12px/1 -apple-system, system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
    .ccb-toolbar button { all: unset; color: #ddd; padding: 4px 7px; border-radius: 4px; cursor: pointer; }
    .ccb-toolbar button:hover { background: #444; color: #fff; }
    body.ccb-edit-mode * { cursor: default !important; }
  `;
  document.documentElement.appendChild(style);
}

function makeBox(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(EDITOR_ATTR, '');
  el.className = cls;
  el.style.display = 'none';
  document.documentElement.appendChild(el);
  return el;
}

function buildChrome(): void {
  injectStyles();
  root = makeBox('ccb-root');
  hoverBox = makeBox('ccb-hover');
  selectBox = makeBox('ccb-select');

  for (const dir of HANDLE_DIRS) {
    const h = makeBox(`ccb-handle ${dir}`);
    h.addEventListener('pointerdown', (e) => startResize(e, dir));
    handles[dir] = h;
  }

  toolbar = makeBox('ccb-toolbar');
  const actions: Array<[string, string, () => void]> = [
    ['✎', 'Edit text', () => editText()],
    ['⧉', 'Duplicate', () => quickAction('duplicate')],
    ['↑', 'Move up', () => quickAction('moveUp')],
    ['↓', 'Move down', () => quickAction('moveDown')],
    ['⌫', 'Hide', () => quickAction('hide')],
    ['⧉sel', 'Copy selector', () => quickAction('copySelector')],
    ['🗑', 'Delete', () => quickAction('delete')],
  ];
  for (const [label, title, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    toolbar.appendChild(b);
  }
}

function positionOverlay(box: HTMLElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
}

function refreshSelectionChrome(): void {
  if (!selected) return;
  const r = selected.getBoundingClientRect();
  positionOverlay(selectBox, selected);
  const at: Record<string, [number, number]> = {
    nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top],
    e: [r.right, r.top + r.height / 2], se: [r.right, r.bottom], s: [r.left + r.width / 2, r.bottom],
    sw: [r.left, r.bottom], w: [r.left, r.top + r.height / 2],
  };
  for (const dir of HANDLE_DIRS) {
    const [x, y] = at[dir];
    handles[dir].style.display = 'block';
    handles[dir].style.left = `${x - 4.5}px`;
    handles[dir].style.top = `${y - 4.5}px`;
  }
  toolbar.style.display = 'flex';
  toolbar.style.left = `${Math.max(4, r.left)}px`;
  toolbar.style.top = `${r.top > 40 ? r.top - 34 : r.bottom + 6}px`;
}

function hideSelectionChrome(): void {
  selectBox.style.display = 'none';
  toolbar.style.display = 'none';
  for (const dir of HANDLE_DIRS) handles[dir].style.display = 'none';
}

// ── Anchor / selector helpers (ported from content-script.ts) ─────────────────

function cssSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testid = el.getAttribute('data-testid');
  if (testid) return `[data-testid="${testid}"]`;
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.classList.length) {
      part += '.' + Array.from(node.classList).slice(0, 2).map((c) => CSS.escape(c)).join('.');
    }
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      const current = node;
      const sames = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      if (sames.length > 1) part += `:nth-of-type(${sames.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
    node = parent;
  }
  return parts.join(' > ');
}

function xPath(el: HTMLElement): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node.nodeType === 1) {
    let idx = 1;
    let sib = node.previousElementSibling;
    while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
    parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = node.parentElement;
  }
  return '/' + parts.join('/');
}

function domPath(el: HTMLElement): string {
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) part += `#${node.id}`;
    else if (node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).join('.');
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function buildAnchor(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return {
    selector: cssSelector(el),
    xpath: xPath(el),
    domPath: domPath(el),
    tagName: el.tagName.toLowerCase(),
    textPreview: (el.textContent ?? '').trim().slice(0, 80),
    htmlSnippet: el.outerHTML.slice(0, 300),
    boundingRect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

const STYLE_PROPS = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'background-color', 'font-size', 'font-weight', 'border',
  'border-radius', 'flex-direction', 'justify-content', 'align-items', 'gap', 'opacity',
];

function readStyles(el: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const p of STYLE_PROPS) out[p] = cs.getPropertyValue(p).trim();
  return out;
}

function readAttributes(el: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    if (a.name === EDITOR_ATTR) continue;
    out[a.name] = a.value;
  }
  return out;
}

// ── Selection ─────────────────────────────────────────────────────────────────

function select(el: HTMLElement): void {
  selected = el;
  hoverBox.style.display = 'none';
  refreshSelectionChrome();
  ipcRenderer.sendToHost('editor:selected', {
    anchor: buildAnchor(el),
    styles: readStyles(el),
    attributes: readAttributes(el),
  });
}

function deselect(): void {
  selected = null;
  hideSelectionChrome();
  ipcRenderer.sendToHost('editor:deselected');
}

function pushJournal(entry: JournalEntry): void {
  journal.push(entry);
  ipcRenderer.sendToHost('editor:journal', journal);
}

// ── Pointer interactions ────────────────────────────────────────────────────

function onMouseMove(e: MouseEvent): void {
  if (mode !== 'edit' || dragging || resizing) return;
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  if (!el || isEditorNode(el) || el === hovered) return;
  hovered = el;
  positionOverlay(hoverBox, el);
  hoverBox.style.display = 'block';
}

function onClick(e: MouseEvent): void {
  if (mode !== 'edit') return;
  const el = e.target as HTMLElement;
  if (isEditorNode(el)) return;
  e.preventDefault();
  e.stopPropagation();
  select(el);
}

// drag-to-move (and Alt-drag to reparent/stack into the element under the cursor)
let dragging = false;
let dragStart = { x: 0, y: 0, baseX: 0, baseY: 0 };

function onSelectablePointerDown(e: PointerEvent): void {
  if (mode !== 'edit' || !selected) return;
  const target = e.target as HTMLElement;
  if (isEditorNode(target) && !target.classList.contains('ccb-select')) return; // handles/toolbar handle themselves
  // Only start a move when the press lands on the selected element.
  const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  if (hit !== selected && !selected.contains(hit)) return;
  dragging = true;
  const cs = getComputedStyle(selected);
  dragStart = { x: e.clientX, y: e.clientY, baseX: parseFloat(cs.left) || 0, baseY: parseFloat(cs.top) || 0 };
  if (cs.position === 'static') selected.style.position = 'relative';
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (dragging && selected) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    selected.style.left = `${dragStart.baseX + dx}px`;
    selected.style.top = `${dragStart.baseY + dy}px`;
    refreshSelectionChrome();
  } else if (resizing && selected) {
    doResize(e);
  }
}

function onPointerUp(e: PointerEvent): void {
  if (dragging && selected) {
    dragging = false;
    if (e.altKey) {
      // Stack: reparent the selected element into the element under the cursor.
      const before = selected.parentElement ? cssSelector(selected.parentElement) : '';
      selected.style.left = '';
      selected.style.top = '';
      const dropEl = elementUnder(e.clientX, e.clientY, selected);
      if (dropEl && dropEl !== selected && !selected.contains(dropEl)) {
        dropEl.appendChild(selected);
        pushJournal({ selector: cssSelector(selected), xpath: xPath(selected), type: 'reparent', before, after: cssSelector(dropEl) });
      }
    } else {
      pushJournal({
        selector: cssSelector(selected), xpath: xPath(selected), type: 'move',
        before: '0,0', after: `${parseFloat(selected.style.left) || 0},${parseFloat(selected.style.top) || 0}`,
      });
    }
    refreshSelectionChrome();
  }
  if (resizing) endResize();
}

function elementUnder(x: number, y: number, ignore: HTMLElement): HTMLElement | null {
  const prev = ignore.style.pointerEvents;
  ignore.style.pointerEvents = 'none';
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (isEditorNode(el)) el = null;
  ignore.style.pointerEvents = prev;
  return el;
}

// resize
let resizing = false;
let resizeDir = '';
let resizeStart = { x: 0, y: 0, w: 0, h: 0 };

function startResize(e: PointerEvent, dir: string): void {
  if (!selected) return;
  e.preventDefault();
  e.stopPropagation();
  resizing = true;
  resizeDir = dir;
  const r = selected.getBoundingClientRect();
  resizeStart = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
}

function doResize(e: PointerEvent): void {
  if (!selected) return;
  const dx = e.clientX - resizeStart.x;
  const dy = e.clientY - resizeStart.y;
  let w = resizeStart.w;
  let h = resizeStart.h;
  if (resizeDir.includes('e')) w = resizeStart.w + dx;
  if (resizeDir.includes('w')) w = resizeStart.w - dx;
  if (resizeDir.includes('s')) h = resizeStart.h + dy;
  if (resizeDir.includes('n')) h = resizeStart.h - dy;
  selected.style.width = `${Math.max(8, Math.round(w))}px`;
  selected.style.height = `${Math.max(8, Math.round(h))}px`;
  refreshSelectionChrome();
}

function endResize(): void {
  resizing = false;
  if (selected) {
    pushJournal({
      selector: cssSelector(selected), xpath: xPath(selected), type: 'resize',
      before: `${Math.round(resizeStart.w)}x${Math.round(resizeStart.h)}`,
      after: `${selected.style.width}x${selected.style.height}`,
    });
  }
}

// ── Quick actions / property apply ────────────────────────────────────────────

function quickAction(action: string): void {
  if (!selected) return;
  const sel = cssSelector(selected);
  switch (action) {
    case 'delete': {
      pushJournal({ selector: sel, xpath: xPath(selected), type: 'attr', name: '__removed', before: 'present', after: 'removed' });
      selected.remove();
      deselect();
      break;
    }
    case 'duplicate': {
      const clone = selected.cloneNode(true) as HTMLElement;
      selected.after(clone);
      pushJournal({ selector: sel, type: 'attr', name: '__duplicated', after: 'true' });
      break;
    }
    case 'hide': {
      const before = selected.style.display;
      selected.style.display = 'none';
      pushJournal({ selector: sel, xpath: xPath(selected), type: 'style', name: 'display', before, after: 'none' });
      deselect();
      break;
    }
    case 'moveUp':
      if (selected.previousElementSibling) {
        selected.parentElement?.insertBefore(selected, selected.previousElementSibling);
        pushJournal({ selector: sel, type: 'reparent', name: 'order', after: 'moveUp' });
        refreshSelectionChrome();
      }
      break;
    case 'moveDown':
      if (selected.nextElementSibling) {
        selected.parentElement?.insertBefore(selected.nextElementSibling, selected);
        pushJournal({ selector: sel, type: 'reparent', name: 'order', after: 'moveDown' });
        refreshSelectionChrome();
      }
      break;
    case 'copySelector':
      ipcRenderer.sendToHost('editor:copySelector', sel);
      break;
  }
}

function editText(): void {
  if (!selected) return;
  const el = selected;
  const before = el.textContent ?? '';
  const sel = cssSelector(el);
  const xp = xPath(el);
  // Make the element directly editable in place. This is the standard
  // visual-editor UX — no popup, no overlay; the user just types where the
  // text lives. Enter commits, Esc cancels.
  const prevEditable = el.getAttribute('contenteditable');
  el.setAttribute('contenteditable', 'plaintext-only');
  el.spellcheck = false;
  el.focus();
  // Select all so the user can immediately overwrite.
  const range = document.createRange();
  range.selectNodeContents(el);
  const selObj = window.getSelection();
  if (selObj) { selObj.removeAllRanges(); selObj.addRange(range); }

  let committed = false;
  const finish = (commit: boolean): void => {
    if (committed) return;
    committed = true;
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    if (prevEditable == null) el.removeAttribute('contenteditable');
    else el.setAttribute('contenteditable', prevEditable);
    el.blur();
    const after = el.textContent ?? '';
    if (commit && after !== before) {
      pushJournal({ selector: sel, xpath: xp, type: 'text', before, after });
    } else if (!commit) {
      // Revert to original text on Escape.
      el.textContent = before;
    }
    refreshSelectionChrome();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = (): void => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

function applyStyle(property: string, value: string): void {
  if (!selected) return;
  const before = selected.style.getPropertyValue(property);
  selected.style.setProperty(property, value);
  pushJournal({ selector: cssSelector(selected), xpath: xPath(selected), type: 'style', name: property, before, after: value });
  refreshSelectionChrome();
}

function applyAttr(name: string, value: string): void {
  if (!selected) return;
  const before = selected.getAttribute(name) ?? '';
  selected.setAttribute(name, value);
  pushJournal({ selector: cssSelector(selected), xpath: xPath(selected), type: 'attr', name, before, after: value });
}

function setMode(next: 'browse' | 'edit'): void {
  mode = next;
  document.body?.classList.toggle('ccb-edit-mode', next === 'edit');
  hoverBox.style.display = 'none';
  if (next === 'browse') deselect();
}

// ── Host → guest channel ──────────────────────────────────────────────────────

ipcRenderer.on('editor:setMode', (_e, m: 'browse' | 'edit') => setMode(m));
ipcRenderer.on('editor:applyStyle', (_e, p: { property: string; value: string }) => applyStyle(p.property, p.value));
ipcRenderer.on('editor:applyAttr', (_e, p: { name: string; value: string }) => applyAttr(p.name, p.value));
ipcRenderer.on('editor:action', (_e, p: { action: string }) => quickAction(p.action));
ipcRenderer.on('editor:selectBySelector', (_e, selector: string) => {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el) select(el);
});
ipcRenderer.on('editor:requestJournal', () => ipcRenderer.sendToHost('editor:journal', journal));
ipcRenderer.on('editor:clearJournal', () => { journal.length = 0; ipcRenderer.sendToHost('editor:journal', journal); });

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot(): void {
  buildChrome();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', onSelectablePointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('scroll', () => { if (selected) refreshSelectionChrome(); }, true);
  window.addEventListener('resize', () => { if (selected) refreshSelectionChrome(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode === 'edit') deselect();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
