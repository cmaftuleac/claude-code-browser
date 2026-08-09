import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';

// Mirrors Claude Code's terminal "thinking" indicator: 6 base glyphs played as
// a palindrome (forward then reversed) so the animation eases at the ends
// instead of snapping back to the first frame. 120ms per frame matches CC's
// `Math.floor(time/120)` frame index.
const SPINNER_BASE = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_BASE, ...[...SPINNER_BASE].reverse()];
const SPINNER_INTERVAL_MS = 120;
import type { ClientMessage, ElementAnchor, AttachedFile } from '@claude-code-browser/shared';
import { useChatStore, selectActiveIsRunning, selectActiveRunMode } from '../stores/chat-store';
import { useConnectionStore } from '../stores/connection-store';
import { MY_TAB_ID } from '../tab';
import { useElementPicker } from '../hooks/useElementPicker';
import { SlashCommandMenu } from './SlashCommandMenu';
import type { SlashCommand } from './SlashCommandMenu';
import { useSourcePaths } from './SourcesPanel';
import { RunModePicker, nextPermissionMode } from './RunModePicker';

interface Props {
  send: (msg: ClientMessage) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

export function ChatInput({ send }: Props) {
  const [images, setImages] = useState<string[]>([]);
  // Non-image attachments. Images keep their own channel because the model takes
  // them inline as vision input; everything else the host writes to a temp dir and
  // references by path, so the agent Reads it as a file.
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  /** Command names the running CLI reports (agent:capabilities) — no descriptions. */
  const [cliCommands, setCliCommands] = useState<string[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { activatePicker } = useElementPicker();
  const sourcePaths = useSourcePaths();
  const targetTabUrl = useConnectionStore((s) => s.targetTabUrl);
  // Primitive projections of the project context, so effects can depend on the VALUE
  // rather than on a `sourcePaths` array that is reallocated on every tab change.
  // `origin` matters as much as the folder: with no source configured (the default)
  // the host resolves the per-website folder from the origin alone, and with neither
  // it can only reach the user-global ~/.claude commands.
  const sourceKey = sourcePaths[0] ?? '';
  const originKey = useMemo(() => {
    try { return new URL(targetTabUrl).host; } catch { return ''; }
  }, [targetTabUrl]);

  const pendingAnchors = useChatStore((s) => s.pendingAnchors);
  const runMode = useChatStore(selectActiveRunMode);
  const clearAnchors = useChatStore((s) => s.clearAnchors);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const activeView = useChatStore((s) => s.activeView);
  const isAgentRunning = useChatStore(selectActiveIsRunning);
  const setSessionRunning = useChatStore((s) => s.setSessionRunning);
  const newChat = useChatStore((s) => s.newChat);
  const adoptRunMode = useChatStore((s) => s.adoptRunMode);

  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (!isAgentRunning) { setSpinnerFrame(0); return; }
    const id = setInterval(() => {
      setSpinnerFrame((i) => (i + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isAgentRunning]);

  const placeholder = 'Ask about this page...';

  // Slash commands come from two sources: the host's filesystem scan (names +
  // descriptions + arg hints) and the running CLI's own list (authoritative, covers
  // built-ins and plugin commands the scan can't see, but name-only). Keep them apart
  // and merge for display so neither loses what the other has.
  // Re-requested whenever the project folder changes — the scan covers that folder's
  // .claude/commands, so the menu would otherwise only ever show the user-global ones.
  useEffect(() => {
    send({ type: 'commands:list', origin: originKey || undefined, projectDir: sourceKey || undefined } as ClientMessage);
    const onScanned = (e: Event) => setSlashCommands((e as CustomEvent).detail);
    const onCapabilities = (e: Event) => setCliCommands((e as CustomEvent).detail as string[]);
    window.addEventListener('ccb:commands', onScanned);
    window.addEventListener('ccb:capabilities', onCapabilities);
    return () => {
      window.removeEventListener('ccb:commands', onScanned);
      window.removeEventListener('ccb:capabilities', onCapabilities);
    };
    // Keyed on primitives, NOT on `sourcePaths`/`targetTabUrl` directly: useSourcePaths
    // returns a fresh array on any browser-tab change, which would re-fire commands:list
    // constantly — and the host answers it with a fully synchronous directory scan on
    // the same thread that pumps streamed tokens.
  }, [send, sourceKey, originKey]);

  const allCommands = useMemo<SlashCommand[]>(() => {
    const byName = new Map(slashCommands.map((c) => [c.name, c]));
    for (const name of cliCommands) {
      const key = `/${name}`;
      if (!byName.has(key)) byName.set(key, { name: key, description: '' });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [slashCommands, cliCommands]);

  // Insert chip at cursor when new anchor arrives
  const lastAnchorCountRef = useRef(0);
  useEffect(() => {
    if (pendingAnchors.length > lastAnchorCountRef.current) {
      insertChipAtCursor(pendingAnchors[pendingAnchors.length - 1]);
      // Ensure editor gets focus after element selection (side panel may have lost focus)
      setTimeout(() => editorRef.current?.focus(), 50);
    }
    lastAnchorCountRef.current = pendingAnchors.length;
  }, [pendingAnchors]);

  function insertChipAtCursor(anchor: ElementAnchor) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();

    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.className = 'inline-chip';
    chip.dataset.anchorIndex = String(pendingAnchors.length - 1);
    chip.title = anchor.domPath;
    chip.innerHTML = `<span class="inline-chip__icon">\u29BE</span><span class="inline-chip__label">&lt;${anchor.tagName}&gt;</span>`;

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editor.contains(range.startContainer)) {
        range.deleteContents();
        range.insertNode(chip);
        range.setStartAfter(chip);
        range.setEndAfter(chip);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(chip);
      }
    } else {
      editor.appendChild(chip);
    }

    const space = document.createTextNode('\u00A0');
    chip.after(space);
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(space);
      r.setEndAfter(space);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function getEditorText(): string {
    const editor = editorRef.current;
    if (!editor) return '';
    let text = '';
    for (const node of Array.from(editor.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? '';
      } else if (node instanceof HTMLElement && node.classList.contains('inline-chip')) {
        const idx = node.dataset.anchorIndex;
        const anchor = idx !== undefined ? pendingAnchors[Number(idx)] : null;
        text += anchor ? `<${anchor.tagName}>` : node.textContent ?? '';
      } else {
        text += node.textContent ?? '';
      }
    }
    return text.replace(/\u00A0/g, ' ').trim();
  }

  const handleSend = useCallback(() => {
    const message = getEditorText();
    if (!message && pendingAnchors.length === 0 && images.length === 0 && files.length === 0) return;

    const anchors = pendingAnchors.length > 0 ? [...pendingAnchors] : undefined;
    const imgs = images.length > 0 ? [...images] : undefined;
    const docs = files.length > 0 ? [...files] : undefined;

    // Resolve which bucket the message + running flag belong to. For empty/pending,
    // we send no sessionId and let the host create one; clientRequestId correlates
    // events back to the pending bucket until session:created arrives.
    let sessionIdForSend: string | undefined;
    let clientRequestId: string | undefined;
    let runningKey: string;
    if (activeView.kind === 'session') {
      sessionIdForSend = activeView.sessionId;
      runningKey = activeView.sessionId;
    } else if (activeView.kind === 'pending') {
      clientRequestId = activeView.clientRequestId;
      runningKey = activeView.clientRequestId;
    } else {
      clientRequestId = newChat();
      runningKey = clientRequestId;
    }
    // Pin the mode this turn is being sent with onto the conversation, so it stops
    // tracking the shared default: a chat that inherited "Ask" must not silently
    // change when the user later re-aims the default for new chats. No-op if this
    // conversation already has its own.
    adoptRunMode(runningKey, runMode);

    addUserMessage(message, anchors, imgs);
    const tid = MY_TAB_ID;
    const sendMsg = (url: string) => {
      // origin (host:port) is the per-website key; projectDir (sources[0]) is the
      // project folder → the session's cwd. The host resolves a per-origin default
      // folder when none is configured.
      let origin = '';
      try { origin = new URL(url).host; } catch { /* not a parseable URL */ }
      send({
        type: 'chat:send',
        sessionId: sessionIdForSend,
        clientRequestId,
        message,
        anchors,
        images: imgs,
        files: docs,
        url,
        origin: origin || undefined,
        projectDir: sourcePaths[0],
        sources: sourcePaths.length > 0 ? sourcePaths : undefined,
        // Per-conversation run mode from the picker.
        permissionMode: runMode.permissionMode,
        effort: runMode.effort,
        model: runMode.model,
        // Sent even when false: the host reconciles a resident/pre-warmed session
        // from this payload, so omitting `false` would leave it stuck on.
        ultracode: runMode.ultracode,
        unattended: runMode.unattended,
      });
    };
    if (tid) {
      chrome.tabs.get(tid, (tab) => sendMsg(chrome.runtime.lastError ? '' : tab?.url ?? ''));
    } else {
      sendMsg('');
    }
    setSessionRunning(runningKey, true);

    clearAnchors();
    setImages([]);
    setFiles([]);
    lastAnchorCountRef.current = 0;
    if (editorRef.current) editorRef.current.innerHTML = '';
    setShowSlashMenu(false);
  }, [pendingAnchors, images, files, addUserMessage, send, activeView, sourcePaths, clearAnchors, setSessionRunning, newChat, adoptRunMode, runMode]);

  const handleStop = useCallback(() => {
    // A new chat has no sessionId yet, so send its clientRequestId: the host's
    // pending-session path used to stop whichever pending chat came first, which with
    // two new chats in flight meant Stop killed the wrong one.
    const sid = activeView.kind === 'session' ? activeView.sessionId : '';
    send({
      type: 'agent:interrupt',
      sessionId: sid,
      ...(activeView.kind === 'pending' ? { clientRequestId: activeView.clientRequestId } : {}),
    });
    // Immediately mark the active bucket idle — host will confirm with chat:error
    if (activeView.kind === 'session') setSessionRunning(activeView.sessionId, false);
    else if (activeView.kind === 'pending') setSessionRunning(activeView.clientRequestId, false);
  }, [activeView, send, setSessionRunning]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showSlashMenu) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // ⇧+Tab cycles the permission mode (matches Claude Code / the desktop app).
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const st = useChatStore.getState();
      st.setRunMode({ permissionMode: nextPermissionMode(selectActiveRunMode(st).permissionMode) });
    }
  };

  const handleInput = () => {
    const text = editorRef.current?.textContent ?? '';
    if (text.startsWith('/')) {
      setSlashFilter(text);
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  };

  const handleSlashSelect = (command: string) => {
    if (editorRef.current) {
      editorRef.current.textContent = command;
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(editorRef.current);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setShowSlashMenu(false);
    editorRef.current?.focus();
  };

  /** Split a dropped/picked/pasted batch: images inline, everything else by path. */
  const addAttachments = async (list: File[]) => {
    const imgs: string[] = [];
    const docs: AttachedFile[] = [];
    for (const f of list) {
      const dataUrl = await readFileAsDataUrl(f);
      if (f.type.startsWith('image/')) imgs.push(dataUrl);
      else docs.push({ name: f.name, dataUrl });
    }
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
    if (docs.length) setFiles((prev) => [...prev, ...docs]);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const newImages: string[] = [];
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) newImages.push(await readFileAsDataUrl(file));
      }
      setImages((prev) => [...prev, ...newImages]);
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    await addAttachments(Array.from(e.dataTransfer.files));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addAttachments(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  return (
    <div className="chat-input" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      {isAgentRunning && (
        <div className="chat-input__spinner" aria-label="Processing">
          {SPINNER_FRAMES[spinnerFrame]}
        </div>
      )}
      {showSlashMenu && (
        <SlashCommandMenu
          commands={allCommands}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashMenu(false)}
        />
      )}

      {files.length > 0 && (
        <div className="chat-input__files">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="chat-input__file" title={f.name}>
              <span className="chat-input__file-name">{f.name}</span>
              <button
                className="chat-input__file-remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >×</button>
            </div>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="chat-input__images">
          {images.map((src, i) => (
            <div key={i} className="chat-input__image-preview">
              <img src={src} alt="Attached" />
              <button className="chat-input__image-remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>x</button>
            </div>
          ))}
        </div>
      )}

      <div
        ref={editorRef}
        className="chat-input__editor"
        contentEditable
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onPaste={handlePaste}
        data-placeholder={placeholder}
        role="textbox"
        suppressContentEditableWarning
      />

      <div className="chat-input__toolbar">
        <div className="chat-input__toolbar-left">
          <button className="chat-input__tool-btn chat-input__tool-btn--picker" onClick={activatePicker} title="Pick element">
            {'\u2316'}
          </button>
          <button className="chat-input__tool-btn" onClick={() => fileInputRef.current?.click()} title="Attach file">
            @
          </button>
          <button className="chat-input__tool-btn chat-input__tool-btn--slash" onClick={() => { setShowSlashMenu(!showSlashMenu); setSlashFilter('/'); }} title="Slash commands">
            /
          </button>
        </div>

        <div className="chat-input__toolbar-right">
          <RunModePicker />
          {isAgentRunning && (
            <button className="chat-input__stop-btn" onClick={handleStop} title="Stop">
              {'\u25A0'}
            </button>
          )}
          <button className="chat-input__send-btn" onClick={handleSend} title="Send">
            {'\u2191'}
          </button>
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
    </div>
  );
}
