import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useDomTreeStore } from '../stores/dom-tree-store';
import { useChatStore } from '../stores/chat-store';
import type { DomTreeNode } from '../stores/dom-tree-store';
import { MY_TAB_ID, sendToMyTab } from '../tab';

const STORAGE_KEY = 'ccb-dom-panel-collapsed';

export function DomTreePanel() {
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['']));
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const tree = useDomTreeStore((s) => s.tree);
  const selectedPath = useDomTreeStore((s) => s.selectedPath);
  const isLoading = useDomTreeStore((s) => s.isLoading);

  // Load collapsed state from storage
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const collapsed = result[STORAGE_KEY] ?? true;
      setPanelCollapsed(collapsed);
      setUserCollapsed(collapsed);
    });
  }, []);

  const togglePanel = useCallback(() => {
    setPanelCollapsed((prev) => {
      const next = !prev;
      setUserCollapsed(next);
      chrome.storage.local.set({ [STORAGE_KEY]: next });
      return next;
    });
  }, []);

  const fetchTree = useCallback(() => {
    const store = useDomTreeStore.getState();
    if (store.isLoading) return;
    store.setLoading(true);
    sendToMyTab({ type: 'GET_DOM_TREE' }, (response: unknown) => {
      store.setLoading(false);
      const res = response as { tree?: DomTreeNode } | null;
      if (res?.tree) {
        store.setTree(res.tree);
        // Keep expanded paths and selected node — tree data updates but UI state persists
      } else {
        store.setTree(null);
      }
    });
  }, []);

  // Fetch tree when panel opens
  useEffect(() => {
    if (!panelCollapsed) fetchTree();
  }, [panelCollapsed, fetchTree]);

  // Re-fetch tree when OUR tab navigates (only when panel is open). Scoped to this
  // panel's own tab — not the active tab — so independent panels don't cross-fetch.
  useEffect(() => {
    if (panelCollapsed) return;
    const onUpdated = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === MY_TAB_ID && info.status === 'complete') fetchTree();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [panelCollapsed, fetchTree]);

  // Scroll to selected node
  useEffect(() => {
    if (selectedPath == null || userCollapsed) return;

    const parts = selectedPath.split('.');
    const ancestors = new Set<string>(['']);
    for (let i = 0; i < parts.length; i++) {
      ancestors.add(parts.slice(0, i + 1).join('.'));
    }
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      ancestors.forEach((p) => next.add(p));
      return next;
    });

    requestAnimationFrame(() => {
      scrollContainerRef.current
        ?.querySelector(`[data-path="${selectedPath}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [selectedPath, userCollapsed]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((node: DomTreeNode) => {
    useChatStore.getState().addAnchor({
      selector: node.anchor.selector,
      xpath: node.anchor.xpath,
      domPath: node.anchor.domPath,
      tagName: node.anchor.tagName,
      textPreview: node.anchor.textPreview,
      htmlSnippet: node.anchor.htmlSnippet,
      boundingRect: node.anchor.boundingRect,
    });
  }, []);

  const handleMouseEnter = useCallback((node: DomTreeNode) => {
    sendToMyTab({
      type: 'HIGHLIGHT_ELEMENT',
      selector: node.anchor.selector,
      xpath: node.anchor.xpath,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    sendToMyTab({ type: 'REMOVE_HIGHLIGHT' });
  }, []);

  return (
    <div className="dom-tree-panel">
      <button className="dom-tree-panel__toggle" onClick={togglePanel}>
        <span className="dom-tree-panel__arrow">{panelCollapsed ? '\u25B6' : '\u25BC'}</span>
        <span>Components</span>
        {!panelCollapsed && (
          <button
            className="dom-tree-panel__refresh"
            onClick={(e) => { e.stopPropagation(); fetchTree(); }}
            title="Refresh DOM tree"
          >
            {'\u21BB'}
          </button>
        )}
      </button>

      {!panelCollapsed && (
        <div className="dom-tree-panel__content" ref={scrollContainerRef}>
          {isLoading && <div className="dom-tree-panel__loading">Loading...</div>}
          {!isLoading && !tree && <div className="dom-tree-panel__empty">No tree available</div>}
          {!isLoading && tree && (
            <TreeNode
              node={tree}
              depth={0}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath}
              onToggle={toggleExpand}
              onClick={handleNodeClick}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            />
          )}
        </div>
      )}
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
  const arrow = hasChildren ? (isExpanded ? '\u25BE' : '\u25B8') : ' ';

  return (
    <>
      <div
        className={`dom-tree-row${isSelected ? ' dom-tree-row--selected' : ''}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        data-path={node.path}
        onMouseEnter={() => onMouseEnter(node)}
        onMouseLeave={onMouseLeave}
      >
        <span
          className="dom-tree-row__arrow"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.path); }}
        >
          {arrow}
        </span>
        <span className="dom-tree-row__label" onClick={() => onClick(node)}>
          <span className="dom-tree-row__tag">{node.tagName}</span>
          {node.id && <span className="dom-tree-row__id">#{node.id}</span>}
          {node.classes && <span className="dom-tree-row__classes">.{node.classes.replace(/ /g, '.')}</span>}
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
        <div
          className="dom-tree-row dom-tree-row--truncated"
          style={{ paddingLeft: (depth + 1) * 16 + 4 }}
        >
          ... {node.childCount - node.children.length} more
        </div>
      )}
    </>
  );
}
