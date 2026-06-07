import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useBrowserInstance, useBrowserStore, registerBrowserControl } from '../stores/browser-store';
import { useEditorStore, useEditorSlice, takePickerTrigger, clearPickerTrigger } from '../stores/editor-store';
import { useTasksStore } from '../stores/tasks-store';
import { WebBrowserMirror } from './WebBrowserMirror';
import type { ElementAnchor, DomTreeNode } from '@fineguide-tesseract/shared';

/** <webview> is an Electron-only intrinsic element with no React JSX typing. */
const Webview = 'webview' as unknown as ComponentType<Record<string, unknown>>;

/** Pending "guest gone" teardowns, keyed by browserId, so a StrictMode
 *  double-mount can cancel a teardown before it tears down a live guest. */
const guestGoneTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * One embedded browser canvas, bound to a single browser instance (`browserId`).
 *
 * Electron mode: renders <webview> with the in-page Photoshop editor attached as
 * its preload, reports this instance's guest webContents id to main (so the
 * agent can drive it), and bridges editor IPC into this instance's editor slice.
 *
 * Web mode: a plain <iframe> with the same loadedUrl (no visual editor — can't
 * inject into cross-origin iframes).
 */
export function BrowserCanvas({ browserId }: { browserId: string }) {
  const inst = useBrowserInstance(browserId);
  const loadedUrl = inst?.loadedUrl ?? '';
  // Suspended → the <webview> is unmounted (renderer process freed); show a
  // placeholder. Re-mounting on resume reloads loadedUrl from scratch.
  const suspended = !!inst?.suspended;
  const mode = useEditorSlice(browserId).mode;
  const ref = useRef<HTMLElement | null>(null);
  const [preloadPath, setPreloadPath] = useState<string | null>(null);
  const isElectron = window.ccb.isElectron;

  useEffect(() => {
    if (!isElectron) return;
    window.ccb.editorPreloadPath().then((p) => setPreloadPath(p ? `file://${p}` : null));
  }, [isElectron]);

  // On unmount (this instance closed): drop the guest-send bridge for this id and
  // tell main the guest is gone, so editor actions / agent routing don't message a
  // destroyed <webview>. Deferred a tick so React 18 StrictMode's dev-only
  // mount→unmount→remount doesn't tear down a LIVE guest mid-session: the remount
  // re-runs this effect and cancels the pending teardown. A real unmount lets it
  // fire on the next tick.
  useEffect(() => {
    const pending = guestGoneTimers.get(browserId);
    if (pending) { clearTimeout(pending); guestGoneTimers.delete(browserId); }
    return () => {
      const t = setTimeout(() => {
        guestGoneTimers.delete(browserId);
        useEditorStore.getState().registerGuestSend(browserId, null);
        registerBrowserControl(browserId, null);
        clearPickerTrigger(browserId);
        window.ccb.notifyGuestGone(browserId);
      }, 0);
      guestGoneTimers.set(browserId, t);
    };
  }, [browserId]);

  // Suspension unmounts the <webview> (freeing its renderer process) while THIS
  // component stays mounted, so the unmount cleanup above won't fire. Tear down
  // the per-instance bridges here so editor actions / agent routing don't message
  // a destroyed guest; dom-ready re-registers them when the tab resumes.
  useEffect(() => {
    if (!suspended) return;
    useEditorStore.getState().registerGuestSend(browserId, null);
    registerBrowserControl(browserId, null);
    window.ccb.notifyGuestGone(browserId);
  }, [suspended, browserId]);

  useEffect(() => {
    if (!isElectron) return;
    const el = ref.current as unknown as Electron.WebviewTag | null;
    if (!el || !preloadPath) return;

    const onDomReady = () => {
      window.ccb.setGuest(browserId, el.getWebContentsId());
      useEditorStore.getState().registerGuestSend(browserId, (channel, payload) => el.send(channel, payload));
      el.send('editor:setMode', useEditorStore.getState().slices[browserId]?.mode ?? 'browse');
      useBrowserStore.getState().setNav(browserId, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() });
      registerBrowserControl(browserId, {
        goBack: () => { if (el.canGoBack()) el.goBack(); },
        goForward: () => { if (el.canGoForward()) el.goForward(); },
        reload: () => el.reload(),
      });
    };

    const onNavigate = (e: Electron.DidNavigateEvent | Electron.DidNavigateInPageEvent) => {
      useBrowserStore.getState().setNav(browserId, {
        url: (e as Electron.DidNavigateEvent).url,
        canGoBack: el.canGoBack(),
        canGoForward: el.canGoForward(),
      });
      // The DOM tree + selectedPath are index paths into the old document; drop
      // them and re-fetch only if the Components tree is currently open.
      const editor = useEditorStore.getState();
      editor.clearTree(browserId);
      if (editor.slices[browserId]?.rightPanel === 'tree') editor.requestTree(browserId);
    };
    const onTitle = (e: Electron.PageTitleUpdatedEvent) => {
      useBrowserStore.getState().setTitle(browserId, e.title);
    };

    const onIpc = (e: Electron.IpcMessageEvent) => {
      const editor = useEditorStore.getState();
      switch (e.channel) {
        case 'editor:selected': {
          const p = e.args[0] as { anchor: ElementAnchor; styles: Record<string, string>; attributes: Record<string, string> };
          editor.setSelection(browserId, p.anchor, p.styles, p.attributes);
          break;
        }
        case 'editor:deselected':
          editor.clearSelection(browserId);
          break;
        case 'editor:journal':
          editor.setJournal(browserId, e.args[0] as never);
          break;
        case 'editor:copySelector':
          void navigator.clipboard.writeText(String(e.args[0]));
          break;
        case 'editor:tree':
          editor.setTree(browserId, (e.args[0] as { tree: DomTreeNode }).tree);
          break;
        case 'editor:picked': {
          const p = e.args[0] as { anchor: ElementAnchor; treePath: string };
          // Drive the tree auto-select (if the Components tab is open) …
          editor.setSelectedPath(browserId, p.treePath);
          // … and land the anchor as a chip in the conversation that triggered
          // the pick (falls back to the active task; tolerates a closed task).
          const taskId = takePickerTrigger(browserId) ?? useTasksStore.getState().activeId;
          if (taskId) useTasksStore.getState().addDraftAnchor(taskId, p.anchor);
          break;
        }
      }
    };

    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', onNavigate as EventListener);
    el.addEventListener('did-navigate-in-page', onNavigate as EventListener);
    el.addEventListener('page-title-updated', onTitle as EventListener);
    el.addEventListener('ipc-message', onIpc as EventListener);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-navigate', onNavigate as EventListener);
      el.removeEventListener('did-navigate-in-page', onNavigate as EventListener);
      el.removeEventListener('page-title-updated', onTitle as EventListener);
      el.removeEventListener('ipc-message', onIpc as EventListener);
    };
    // `loadedUrl` is in the deps because the <webview> only mounts once a URL is
    // set; without it, opening a browser empty and navigating later would leave
    // the guest bridge unattached (dead visual editor) for that instance.
  }, [preloadPath, isElectron, loadedUrl, browserId]);

  return (
    <div className="canvas">
      {!loadedUrl && (
        <div className="canvas__empty" style={{ animation: 'fade-in 200ms ease' }}>
          Enter a URL or local dev server (e.g. <code>localhost:3000</code>) to start.
        </div>
      )}
      {loadedUrl && suspended && (
        <button
          type="button"
          className="canvas__suspended"
          onClick={() => { useBrowserStore.getState().resume(browserId); useBrowserStore.getState().setActive(browserId); }}
          title="This tab was unloaded to save memory — click to reload"
        >
          <span className="canvas__suspended-title">Tab suspended to save memory</span>
          <span className="canvas__suspended-url">{loadedUrl}</span>
          <span className="canvas__suspended-hint">Click to reload</span>
        </button>
      )}
      {loadedUrl && !suspended && isElectron && preloadPath && (
        <Webview
          ref={ref as never}
          src={loadedUrl}
          preload={preloadPath}
          webpreferences="contextIsolation=yes,sandbox=no,spellcheck=no"
          allowpopups="true"
          className={`canvas__webview ${mode === 'edit' ? 'canvas__webview--edit' : ''}`}
        />
      )}
      {loadedUrl && !suspended && !isElectron && (
        // Web mode: mirror a real browser running on the selected host (direct
        // P2P WebRTC, or JPEG-frame fallback over the control WS) — not a
        // cross-origin-locked <iframe>.
        <WebBrowserMirror browserId={browserId} url={loadedUrl} />
      )}
    </div>
  );
}
