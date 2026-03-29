// Prevent double-injection — use IIFE so we can early-return
(function() {
if ((window as unknown as { __ccb_injected?: boolean }).__ccb_injected) return;
(window as unknown as { __ccb_injected: boolean }).__ccb_injected = true;

let pickerActive = false;
let overlay: HTMLDivElement | null = null;
let tooltip: HTMLDivElement | null = null;
let currentTarget: Element | null = null;

let highlightOverlay: HTMLDivElement | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ACTIVATE_PICKER') {
    if (pickerActive) {
      deactivatePicker();
    } else {
      activatePicker();
    }
  }

  if (message.type === 'GET_DOM_TREE') {
    const tree = buildDomTree(document.body, '', 0, 8, 20);
    sendResponse({ tree });
    return true;
  }

  if (message.type === 'GET_SUBTREE') {
    const el = findElementByPath(document.body, message.path);
    if (el) {
      const children = buildDomTreeChildren(el, message.path, 0, 4, 20);
      sendResponse({ children });
    } else {
      sendResponse({ children: [] });
    }
    return true;
  }

  if (message.type === 'HIGHLIGHT_ELEMENT') {
    removeHighlight();
    if (message.selector) {
      let el: Element | null = null;
      try { el = document.querySelector(message.selector); } catch { /* ignore */ }
      if (!el && message.xpath) {
        try {
          const result = document.evaluate(message.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = result.singleNodeValue as Element | null;
        } catch { /* ignore */ }
      }
      if (el) {
        showHighlight(el);
      }
    }
  }

  if (message.type === 'REMOVE_HIGHLIGHT') {
    removeHighlight();
  }
});

function activatePicker() {
  if (pickerActive) return;
  pickerActive = true;

  document.body.classList.add('ccb-picker-active');

  overlay = document.createElement('div');
  overlay.className = 'ccb-picker-overlay';
  document.body.appendChild(overlay);

  tooltip = document.createElement('div');
  tooltip.className = 'ccb-picker-tooltip';
  document.body.appendChild(tooltip);

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

function deactivatePicker() {
  pickerActive = false;
  currentTarget = null;
  document.body.classList.remove('ccb-picker-active');
  if (overlay) { overlay.remove(); overlay = null; }
  if (tooltip) { tooltip.remove(); tooltip = null; }
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
}

function onMouseMove(e: MouseEvent) {
  let target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || target === overlay || target === tooltip) return;

  // Resolve: bubble up from SVG internals to their meaningful container,
  // but keep the SVG itself selectable.
  target = resolveTarget(target);
  currentTarget = target;

  const rect = target.getBoundingClientRect();
  if (overlay) {
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }
  if (tooltip) {
    tooltip.textContent = describeElement(target);
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
  }
}

function onClick(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (!currentTarget) {
    deactivatePicker();
    return;
  }

  const anchor = extractElementInfo(currentTarget);
  const treePath = computeElementPath(currentTarget);
  chrome.runtime.sendMessage({ type: 'ELEMENT_SELECTED', anchor, treePath }, () => void chrome.runtime.lastError);
  deactivatePicker();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    deactivatePicker();
  }
}

// ── Target Resolution ───────────────────────────────────────────────────────

// Only bubble up from SVG *internal* elements (path, g, circle, etc.) — NOT <svg> itself.
const SVG_INTERNALS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'use', 'defs', 'clippath', 'mask', 'symbol', 'tspan']);
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);

function resolveTarget(el: Element): Element {
  const tag = el.tagName.toLowerCase();

  // If it's an SVG internal (path, g, etc.) walk up to the <svg> or interactive parent.
  // But if it's the <svg> element itself, keep it.
  if (!SVG_INTERNALS.has(tag)) return el;

  let current: Element | null = el;
  while (current) {
    const t = current.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(t)) return current;
    if (t === 'svg') return current; // stop at the <svg> element
    if (current.id || current.getAttribute('data-testid')) return current;
    current = current.parentElement;
  }
  return el;
}

// ── Element Info Extraction ──────────────────────────────────────────────────

function extractElementInfo(el: Element) {
  const rect = el.getBoundingClientRect();
  return {
    selector: buildCssSelector(el),
    xpath: buildXPath(el),
    domPath: buildDomPath(el),
    tagName: el.tagName.toLowerCase(),
    textPreview: getTextPreview(el),
    htmlSnippet: getHtmlSnippet(el),
    boundingRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

/** Build full DOM path like: div#root > div.flex.overflow-hidden > nav.w-12 > button */
function buildDomPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    const id = current.id ? `#${current.id}` : '';
    const classes = Array.from(current.classList).join(' ');
    const classPart = classes ? `.${classes.replace(/ /g, '.')}` : '';

    // Add nth index if there are same-tag siblings
    let index = '';
    const parent = current.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
      if (sameTag.length > 1) {
        index = `[${sameTag.indexOf(current)}]`;
      }
    }

    parts.unshift(`${tag}${id}${classPart}${index}`);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Get outer HTML truncated, stripping children for brevity */
function getHtmlSnippet(el: Element): string {
  const clone = el.cloneNode(false) as Element;
  const html = clone.outerHTML;
  // For self-closing or empty elements, return as-is
  if (html.length <= 300) return html;
  return html.slice(0, 300) + '...';
}

function getTextPreview(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim().slice(0, 80);
  const title = el.getAttribute('title');
  if (title) return title.trim().slice(0, 80);
  const directText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.trim())
    .filter(Boolean)
    .join(' ');
  if (directText) return directText.slice(0, 80);
  return (el.textContent ?? '').trim().slice(0, 80);
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const classes = Array.from(el.classList).slice(0, 3).map((c) => `.${c}`).join('');
  const text = getTextPreview(el);
  const textPart = text ? ` "${text.slice(0, 30)}"` : '';
  return `<${tag}${id}${classes}>${textPart}`;
}

// ── Selector Generation ─────────────────────────────────────────────────────

function buildCssSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const tag = el.tagName.toLowerCase();
    const sel = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  if (el.classList.length > 0) {
    const tag = el.tagName.toLowerCase();
    const sel = tag + Array.from(el.classList).map((c) => `.${CSS.escape(c)}`).join('');
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break; }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
    if (sameTag.length > 1) {
      parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(current) + 1})`);
    } else {
      parts.unshift(tag);
    }
    current = parent;
  }
  return parts.join(' > ');
}

// ── DOM Tree Building ───────────────────────────────────────────────────────

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'link', 'meta']);

interface DomTreeNodeData {
  tagName: string;
  id: string;
  classes: string;
  path: string;
  childCount: number;
  children: DomTreeNodeData[];
  truncated: boolean;
  anchor: {
    selector: string;
    xpath: string;
    domPath: string;
    tagName: string;
    textPreview: string;
    htmlSnippet: string;
    boundingRect: { x: number; y: number; width: number; height: number };
  };
}

function buildDomTree(el: Element, path: string, depth: number, maxDepth: number, maxChildren: number): DomTreeNodeData {
  const tag = el.tagName.toLowerCase();
  const id = el.id || '';
  const classes = Array.from(el.classList).slice(0, 4).join(' ');
  const anchor = extractElementInfo(el);

  const elementChildren = Array.from(el.children).filter(
    (child) => !SKIP_TAGS.has(child.tagName.toLowerCase())
  );
  const childCount = elementChildren.length;

  let children: DomTreeNodeData[] = [];
  let truncated = false;

  if (depth < maxDepth) {
    const limit = Math.min(elementChildren.length, maxChildren);
    for (let i = 0; i < limit; i++) {
      const childPath = path ? `${path}.${i}` : String(i);
      children.push(buildDomTree(elementChildren[i], childPath, depth + 1, maxDepth, maxChildren));
    }
    truncated = elementChildren.length > maxChildren;
  } else if (childCount > 0) {
    truncated = true;
  }

  return { tagName: tag, id, classes, path, childCount, children, truncated, anchor };
}

function buildDomTreeChildren(el: Element, parentPath: string, depth: number, maxDepth: number, maxChildren: number): DomTreeNodeData[] {
  const elementChildren = Array.from(el.children).filter(
    (child) => !SKIP_TAGS.has(child.tagName.toLowerCase())
  );
  const limit = Math.min(elementChildren.length, maxChildren);
  const children: DomTreeNodeData[] = [];
  for (let i = 0; i < limit; i++) {
    const childPath = parentPath ? `${parentPath}.${i}` : String(i);
    children.push(buildDomTree(elementChildren[i], childPath, depth, maxDepth, maxChildren));
  }
  return children;
}

function findElementByPath(root: Element, path: string): Element | null {
  if (!path) return root;
  const indices = path.split('.').map(Number);
  let current: Element = root;
  for (const idx of indices) {
    const children = Array.from(current.children).filter(
      (child) => !SKIP_TAGS.has(child.tagName.toLowerCase())
    );
    if (idx >= children.length) return null;
    current = children[idx];
  }
  return current;
}

// ── Highlight ───────────────────────────────────────────────────────────────

function showHighlight(el: Element) {
  removeHighlight();
  const rect = el.getBoundingClientRect();
  highlightOverlay = document.createElement('div');
  highlightOverlay.className = 'ccb-highlight-overlay';
  highlightOverlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    border: 2px solid #f59e0b;
    background: rgba(245, 158, 11, 0.12);
    z-index: 2147483645;
    border-radius: 2px;
    transition: all 0.05s ease-out;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
  `;
  document.body.appendChild(highlightOverlay);
}

function removeHighlight() {
  if (highlightOverlay) {
    highlightOverlay.remove();
    highlightOverlay = null;
  }
}

// ── Element Path for Picker ─────────────────────────────────────────────────

function computeElementPath(el: Element): string {
  const parts: number[] = [];
  let current: Element | null = el;
  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter(
      (child) => !SKIP_TAGS.has(child.tagName.toLowerCase())
    );
    const idx = siblings.indexOf(current);
    parts.unshift(idx);
    current = parent;
  }
  return parts.join('.');
}

// ── Selector Generation ─────────────────────────────────────────────────────

function buildXPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) { parts.unshift(`/${tag}`); break; }
    if (current.id) { parts.unshift(`//${tag}[@id="${current.id}"]`); break; }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
    parts.unshift(`/${tag}[${siblings.indexOf(current) + 1}]`);
    current = parent;
  }
  return parts.join('');
}

})(); // end double-injection guard
