import { motion, AnimatePresence } from 'framer-motion';
import { Globe, Eye, MousePointerClick, RotateCw } from 'lucide-react';
import { BrowserCanvas } from './BrowserCanvas';
import { PropertiesPanel } from './PropertiesPanel';
import { useBrowserStore } from '../stores/browser-store';
import { useEditorStore } from '../stores/editor-store';

export function BrowserSurface() {
  const { addressBar, setAddressBar, navigate, loadedUrl } = useBrowserStore();
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const hasSelection = useEditorStore((s) => !!s.selected);

  return (
    <div className="browser-surface">
      <div className="browser-surface__bar">
        <form
          className="browser-surface__address"
          onSubmit={(e) => { e.preventDefault(); navigate(addressBar); }}
        >
          <Globe className="browser-surface__address-icon" size={14} strokeWidth={1.75} />
          <input
            className="browser-surface__url"
            value={addressBar}
            spellCheck={false}
            placeholder="URL or localhost:3000"
            onChange={(e) => setAddressBar(e.target.value)}
          />
          <button
            type="button"
            className="browser-surface__address-icon"
            title="Reload"
            onClick={() => loadedUrl && navigate(loadedUrl)}
          >
            <RotateCw size={13} strokeWidth={1.75} />
          </button>
        </form>
        <div className="browser-surface__modes">
          <button className={mode === 'browse' ? 'is-active' : ''} onClick={() => setMode('browse')} style={{ position: 'relative' }}>
            {mode === 'browse' && (
              <motion.span
                layoutId="browser-mode-bg"
                className="browser-surface__modes-bg"
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <Eye size={12} strokeWidth={1.75} /> Browse
          </button>
          <button className={mode === 'edit' ? 'is-active' : ''} onClick={() => setMode('edit')} style={{ position: 'relative' }}>
            {mode === 'edit' && (
              <motion.span
                layoutId="browser-mode-bg"
                className="browser-surface__modes-bg"
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              />
            )}
            <MousePointerClick size={12} strokeWidth={1.75} /> Edit
          </button>
        </div>
      </div>
      <div className="browser-surface__body">
        <BrowserCanvas />
        <AnimatePresence>
          {mode === 'edit' && hasSelection && (
            <motion.div
              key="inspector"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              className="browser-surface__inspector"
              style={{ overflow: 'hidden' }}
            >
              <PropertiesPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
