import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import type { DomTreeNode } from '@fineguide-tesseract/shared';
import { useEditorStore, useEditorSlice } from '../stores/editor-store';
import { useTasksStore } from '../stores/tasks-store';

/**
 * Components sidebar for ONE browser instance — the desktop analogue of the
 * extension's DomTreePanel. Reads the per-browser DOM tree from the editor
 * slice; hovering a node highlights it on the page (guest overlay), clicking a
 * node stages its anchor on the active conversation, and a pick on the page
 * (which sets `selectedPath`) auto-expands the node's ancestors and scrolls it
 * into view. Open/close is owned by the slide-in panel + tab in BrowserSurface.
 */
export function DomTreePanel({ browserId }: { browserId: string }) {
  const slice = useEditorSlice(browserId);
  const tree = slice.domTree;
  const selectedPath = slice.selectedPath;
  const isLoading = slice.treeLoading;
  const requestTree = useEditorStore((s) => s.requestTree);
  const highlight = useEditorStore((s) => s.highlight);
  const removeHighlight = useEditorStore((s) => s.removeHighlight);
  const setSelectedPath = useEditorStore((s) => s.setSelectedPath);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['']));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-expand ancestors + scroll to the selected node (after a page pick, or a
  // tree click). Ported from the extension's DomTreePanel.
  useEffect(() => {
    if (selectedPath == null) return;
    const parts = selectedPath.split('.');
    const ancestors = new Set<string>(['']);
    for (let i = 0; i < parts.length; i++) ancestors.add(parts.slice(0, i + 1).join('.'));
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      ancestors.forEach((p) => next.add(p));
      return next;
    });
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-path="${selectedPath}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [selectedPath]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onNodeClick = useCallback((node: DomTreeNode) => {
    setSelectedPath(browserId, node.path);
    // Land the anchor on the active conversation (create one if none is open).
    const tasks = useTasksStore.getState();
    const taskId = tasks.activeId ?? tasks.newTask();
    tasks.addDraftAnchor(taskId, node.anchor);
  }, [browserId, setSelectedPath]);

  const onNodeEnter = useCallback(
    (node: DomTreeNode) => highlight(browserId, node.anchor.selector, node.anchor.xpath),
    [browserId, highlight],
  );
  const onNodeLeave = useCallback(() => removeHighlight(browserId), [browserId, removeHighlight]);

  return (
    <div className="dom-tree">
      <div className="dom-tree__head">
        <span className="dom-tree__title">Components</span>
        <button className="dom-tree__refresh" onClick={() => requestTree(browserId)} title="Refresh DOM tree">
          <RotateCw size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div className="dom-tree__body" ref={scrollRef}>
        {isLoading && <div className="dom-tree__hint">Loading…</div>}
        {!isLoading && !tree && <div className="dom-tree__hint">No tree yet. Load a page, then refresh.</div>}
        {!isLoading && tree && (
          <TreeNode
            node={tree}
            depth={0}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={toggleExpand}
            onClick={onNodeClick}
            onMouseEnter={onNodeEnter}
            onMouseLeave={onNodeLeave}
          />
        )}
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: DomTreeNode;
  depth: number;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onClick: (node: DomTreeNode) => void;
  onMouseEnter: (node: DomTreeNode) => void;
  onMouseLeave: () => void;
}

function TreeNode({ node, depth, expandedPaths, selectedPath, onToggle, onClick, onMouseEnter, onMouseLeave }: TreeNodeProps) {
  const hasChildren = node.children.length > 0 || node.truncated;
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.path === selectedPath;
  const arrow = hasChildren ? (isExpanded ? '▾' : '▸') : '';

  return (
    <>
      <div
        className={`dom-tree__row${isSelected ? ' is-selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        data-path={node.path}
        onMouseEnter={() => onMouseEnter(node)}
        onMouseLeave={onMouseLeave}
      >
        <span
          className="dom-tree__arrow"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.path); }}
        >
          {arrow}
        </span>
        <span className="dom-tree__label" onClick={() => onClick(node)}>
          <span className="dom-tree__tag">{node.tagName}</span>
          {node.id && <span className="dom-tree__id">#{node.id}</span>}
          {node.classes && <span className="dom-tree__cls">.{node.classes.replace(/ /g, '.')}</span>}
        </span>
      </div>

      {isExpanded && node.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onClick={onClick}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        />
      ))}

      {isExpanded && node.truncated && (
        <div className="dom-tree__row dom-tree__row--more" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>
          … {node.childCount - node.children.length} more
        </div>
      )}
    </>
  );
}
