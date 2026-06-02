import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useBrowserStore } from '../stores/browser-store';
import { useEditorStore } from '../stores/editor-store';
import type { ElementAnchor } from '@claude-code-browser/shared';

/** <webview> is an Electron-only intrinsic element with no React JSX typing. */
const Webview = 'webview' as unknown as ComponentType<Record<string, unknown>>;

/**
 * The embedded browser canvas.
 *
 * Electron mode: renders <webview> with the in-page Photoshop editor attached
 * as its preload, reports guest webContents id to main, bridges editor IPC.
 *
 * Web mode: renders a plain <iframe> with the same loadedUrl. The visual
 * editor (selection / drag / resize / save-to-code) is unavailable because
 * browsers don't allow injecting scripts into cross-origin iframes — we still
 * give you a usable in-app preview.
 */
export function BrowserCanvas() {
  const loadedUrl = useBrowserStore((s) => s.loadedUrl);
  const mode = useEditorStore((s) => s.mode);
  const ref = useRef<HTMLElement | null>(null);
  const [preloadPath, setPreloadPath] = useState<string | null>(null);
  const isElectron = window.ccb.isElectron;

  useEffect(() => {
    if (!isElectron) return;
    window.ccb.editorPreloadPath().then((p) => setPreloadPath(p ? `file://${p}` : null));
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron) return;
    const el = ref.current as unknown as Electron.WebviewTag | null;
    if (!el || !preloadPath) return;

    const onDomReady = () => {
      window.ccb.setGuest(el.getWebContentsId());
      useEditorStore.getState().registerGuestSend((channel, payload) => el.send(channel, payload));
      el.send('editor:setMode', useEditorStore.getState().mode);
    };

    const onIpc = (e: Electron.IpcMessageEvent) => {
      const editor = useEditorStore.getState();
      switch (e.channel) {
        case 'editor:selected': {
          const p = e.args[0] as { anchor: ElementAnchor; styles: Record<string, string>; attributes: Record<string, string> };
          editor.setSelection(p.anchor, p.styles, p.attributes);
          break;
        }
        case 'editor:deselected':
          editor.clearSelection();
          break;
        case 'editor:journal':
          editor.setJournal(e.args[0] as never);
          break;
        case 'editor:copySelector':
          void navigator.clipboard.writeText(String(e.args[0]));
          break;
      }
    };

    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('ipc-message', onIpc as EventListener);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('ipc-message', onIpc as EventListener);
    };
  }, [preloadPath, isElectron]);

  return (
    <div className="canvas">
      {!loadedUrl && (
        <div className="canvas__empty" style={{ animation: 'fade-in 200ms ease' }}>
          Enter a URL or local dev server (e.g. <code>localhost:3000</code>) to start.
        </div>
      )}
      {loadedUrl && isElectron && preloadPath && (
        <Webview
          ref={ref as never}
          src={loadedUrl}
          preload={preloadPath}
          webpreferences="contextIsolation=yes,sandbox=no"
          allowpopups="true"
          className={`canvas__webview ${mode === 'edit' ? 'canvas__webview--edit' : ''}`}
        />
      )}
      {loadedUrl && !isElectron && (
        <iframe
          src={loadedUrl}
          className="canvas__webview"
          title="Preview"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        />
      )}
    </div>
  );
}
