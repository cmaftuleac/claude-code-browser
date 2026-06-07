import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Eye, MousePointerClick, RotateCw, ArrowLeft, ArrowRight, PanelRight } from 'lucide-react';
import { BrowserCanvas } from './BrowserCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { DomTreePanel } from './DomTreePanel';
import { useBrowserInstance, useBrowserStore, browserControl } from '../stores/browser-store';
import { useEditorStore, useEditorSlice } from '../stores/editor-store';

export function BrowserSurface({ browserId }: { browserId: string }) {
  const inst = useBrowserInstance(browserId);
  const setAddressBar = useBrowserStore((s) => s.setAddressBar);
  const setAddressEditing = useBrowserStore((s) => s.setAddressEditing);
  const navigate = useBrowserStore((s) => s.navigate);
  const slice = useEditorSlice(browserId);
  const mode = slice.mode;
  const setMode = useEditorStore((s) => s.setMode);
  const rightPanel = slice.rightPanel;
  const setRightPanel = useEditorStore((s) => s.setRightPanel);
  const requestTree = useEditorStore((s) => s.requestTree);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch the DOM tree whenever the Tree tab becomes the open panel (and it
  // hasn't been fetched yet for this page); navigation clears it via BrowserCanvas.
  useEffect(() => {
    if (rightPanel === 'tree' && !slice.domTree && !slice.treeLoading) requestTree(browserId);
  }, [rightPanel, slice.domTree, slice.treeLoading, browserId, requestTree]);

  const addressBar = inst?.addressBar ?? '';
  const loadedUrl = inst?.loadedUrl ?? '';
  const canGoBack = !!inst?.canGoBack;
  const canGoForward = !!inst?.canGoForward;

  // A brand-new (blank) browser focuses the address bar so you can just type.
  useEffect(() => { if (!loadedUrl) inputRef.current?.focus(); }, [loadedUrl]);

  return (
    <div className="browser-surface">
      <div className="browser-surface__bar">
        <div className="browser-surface__nav">
          <button
            type="button"
            className="browser-surface__nav-btn"
            title="Back"
            disabled={!canGoBack}
            onClick={() => browserControl(browserId)?.goBack()}
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="browser-surface__nav-btn"
            title="Forward"
            disabled={!canGoForward}
            onClick={() => browserControl(browserId)?.goForward()}
          >
            <ArrowRight size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="browser-surface__nav-btn"
            title="Reload"
            disabled={!loadedUrl}
            onClick={() => { const c = browserControl(browserId); if (c) c.reload(); else if (loadedUrl) navigate(browserId, loadedUrl); }}
          >
            <RotateCw size={13} strokeWidth={1.75} />
          </button>
        </div>
        <form
          className="browser-surface__address"
          onSubmit={(e) => { e.preventDefault(); if (addressBar.trim()) navigate(browserId, addressBar); }}
        >
          <Globe className="browser-surface__address-icon" size={14} strokeWidth={1.75} />
          <input
            ref={inputRef}
            className="browser-surface__url"
            value={addressBar}
            spellCheck={false}
            placeholder="URL or localhost:3000"
            onChange={(e) => setAddressBar(browserId, e.target.value)}
            onFocus={() => setAddressEditing(browserId, true)}
            onBlur={() => setAddressEditing(browserId, false)}
          />
        </form>
        <div className="browser-surface__modes">
          <button className={mode === 'browse' ? 'is-active' : ''} onClick={() => setMode(browserId, 'browse')} style={{ position: 'relative' }}>
            {mode === 'browse' && (
              <motion.span
                layoutId={`browser-mode-bg-${browserId}`}
                className="browser-surface__modes-bg"
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <Eye size={12} strokeWidth={1.75} /> Browse
          </button>
          <button className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode(browserId, 'edit')} style={{ position: 'relative' }}>
            {mode === 'edit' && (
              <motion.span
                layoutId={`browser-mode-bg-${browserId}`}
                className="browser-surface__modes-bg"
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <MousePointerClick size={12} strokeWidth={1.75} /> Edit
          </button>
        </div>
        <button
          type="button"
          className={`browser-surface__panel-toggle ${rightPanel !== 'closed' ? 'is-active' : ''}`}
          title="Components & inspector"
          onClick={() => setRightPanel(browserId, rightPanel === 'closed' ? 'tree' : 'closed')}
        >
          <PanelRight size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="browser-surface__body">
        <BrowserCanvas browserId={browserId} />
        <AnimatePresence>
          {rightPanel !== 'closed' && (
            <motion.div
              key="rightpanel"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 340, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              className="browser-surface__inspector"
              style={{ overflow: 'hidden' }}
            >
              <div className="browser-surface__tabs">
                <button
                  className={rightPanel === 'tree' ? 'is-active' : ''}
                  onClick={() => setRightPanel(browserId, 'tree')}
                >
                  Components
                </button>
                <button
                  className={rightPanel === 'style' ? 'is-active' : ''}
                  onClick={() => setRightPanel(browserId, 'style')}
                >
                  Inspector
                </button>
              </div>
              <div className="browser-surface__tab-body">
                {rightPanel === 'tree' ? <DomTreePanel browserId={browserId} /> : <PropertiesPanel browserId={browserId} />}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
