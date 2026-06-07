import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Square, X, FileText, SquareSlash, Mic } from 'lucide-react';
import type { AttachedFile, ElementAnchor } from '@fineguide-tesseract/shared';
import { useTasksStore } from '../stores/tasks-store';
import { useEditorStore, useEditorSlice, setPickerTrigger } from '../stores/editor-store';
import { useBrowserStore, useBrowserInstance } from '../stores/browser-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useConnectionStore } from '../stores/connection-store';
import { useUiStore } from '../stores/ui-store';
import { ConnectedBrowserChip } from './ConnectedBrowserChip';
import { SlashCommandMenu } from './SlashCommandMenu';
import { AttachMenu } from './AttachMenu';
import { RunModeMenu, nextPermissionMode } from './RunModeMenu';
import { VoicePanel } from './VoicePanel';
import { useVoiceConversation } from '../hooks/useVoiceConversation';
import { readFileAsDataUrl } from '../lib/drop-paths';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

// Claude Code's terminal "thinking" spinner: 6 base glyphs played as a palindrome
// (forward then reversed) so it eases at the ends. 120ms/frame matches CC.
const SPINNER_BASE = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_BASE, ...[...SPINNER_BASE].reverse()];

/** The textual form of a picked element: its tag plus a short slice of its
 *  content so the reference reads as e.g. `<button>Thank you…` rather than a
 *  bare `<button>`. Used both for the inline chip's label and the message text
 *  serialized on send. */
const LABEL_CONTENT_MAX = 28;
function anchorLabel(a: ElementAnchor): string {
  const tag = `<${a.tagName}>`;
  const content = (a.textPreview ?? '').replace(/\s+/g, ' ').trim();
  if (!content) return tag;
  return tag + (content.length > LABEL_CONTENT_MAX ? `${content.slice(0, LABEL_CONTENT_MAX).trimEnd()}…` : content);
}

export function Composer({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  /** Attached images as base64 data URLs — host decodes into /tmp/ccb-images/*. */
  const [images, setImages] = useState<string[]>([]);
  /** Generic (non-image) attachments — host writes them to /tmp/ccb-files/*. */
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** The contenteditable input. Uncontrolled — we own its DOM directly so we can
   *  embed inline element chips at the caret (mirrors the extension's ChatInput). */
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** Anchor metadata for the chips currently in the editor, keyed by a generated
   *  id stamped on each chip (`data-anchor-id`). Deleting a chip drops it from the
   *  set sent on submit; the lingering map entry is harmless and cleared on send. */
  const anchorMapRef = useRef<Map<string, ElementAnchor>>(new Map());
  const chipSeqRef = useRef(0);
  const dropWrapRef = useRef<HTMLDivElement | null>(null);

  const send = useTasksStore((s) => s.send);
  const clearDraftAnchors = useTasksStore((s) => s.clearDraftAnchors);
  const task = useTasksStore((s) => s.tasks.find((t) => t.id === taskId));
  const running = !!task?.running;
  const draftAnchors = task?.draftAnchors ?? [];
  // The chat's browser context = its connected browser (an explicit binding, or
  // the focused browser when unbound). Its URL + selected element ride along.
  const activeBrowserId = useBrowserStore((s) => s.activeId);
  const connectedBrowserId = task?.browserId ?? activeBrowserId;
  // Live page URL (tracks in-page navigation) sent as the agent's context.
  const pageUrl = useBrowserInstance(connectedBrowserId)?.currentUrl ?? '';
  const selected = useEditorSlice(connectedBrowserId).selected;
  const projectDir = useWorkspaceStore((s) => s.root);
  const commands = useConnectionStore((s) => s.commands);

  // Hands-free voice conversation (local Silero VAD + Web Speech STT/TTS).
  // The composer's action button is a mic while the input is empty; tapping it
  // starts a conversation and the button shows a pressed state until it ends.
  const voice = useVoiceConversation(taskId);
  const toggleVoice = () => {
    if (voice.active || voice.state === 'error') voice.stop();
    else void voice.start();
  };

  // Slash menu: open while the draft starts with "/" and at least one command matches.
  const slashMatches = showSlash
    ? commands.filter((c) => c.name.slice(1).toLowerCase().includes(text.replace(/^\//, '').toLowerCase()))
    : [];
  const menuOpen = showSlash && slashMatches.length > 0;

  // Drive the running spinner.
  useEffect(() => {
    if (!running) { setSpinnerFrame(0); return; }
    const id = setInterval(() => setSpinnerFrame((i) => (i + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, [running]);

  /** Route dropped/pasted/picked files: images → image previews, the rest → file chips. */
  const addFiles = async (incoming: Iterable<File>): Promise<void> => {
    const newImages: string[] = [];
    const newFiles: AttachedFile[] = [];
    for (const f of incoming) {
      try {
        const dataUrl = await readFileAsDataUrl(f);
        if (f.type.startsWith('image/')) newImages.push(dataUrl);
        else newFiles.push({ name: f.name || 'file', dataUrl });
      } catch { /* skip broken read */ }
    }
    if (newImages.length) setImages((prev) => [...prev, ...newImages]);
    if (newFiles.length) setFiles((prev) => [...prev, ...newFiles]);
  };

  /* ── Contenteditable serialization & inline chips ───────────────────────── */

  /** Serialize one editor node to plain text: inline chips become their
   *  `<tag>content…` label, <br>/block elements become newlines, everything
   *  else its text. */
  const serializeNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.classList.contains('composer__inline-chip')) {
      const a = node.dataset.anchorId ? anchorMapRef.current.get(node.dataset.anchorId) : undefined;
      return a ? anchorLabel(a) : node.textContent ?? '';
    }
    if (node.tagName === 'BR') return '\n';
    let inner = '';
    for (const c of Array.from(node.childNodes)) inner += serializeNode(c);
    return /^(DIV|P)$/.test(node.tagName) ? `\n${inner}` : inner;
  };

  /** The editor's full text, with chips rendered as their labels. */
  const getEditorText = (): string => {
    const editor = editorRef.current;
    if (!editor) return '';
    let out = '';
    for (const node of Array.from(editor.childNodes)) out += serializeNode(node);
    return out.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };

  /** The anchors of the chips still present in the editor, in document order. */
  const collectAnchors = (): ElementAnchor[] => {
    const editor = editorRef.current;
    if (!editor) return [];
    const out: ElementAnchor[] = [];
    editor.querySelectorAll<HTMLElement>('.composer__inline-chip[data-anchor-id]').forEach((el) => {
      const a = el.dataset.anchorId ? anchorMapRef.current.get(el.dataset.anchorId) : undefined;
      if (a) out.push(a);
    });
    return out;
  };

  /** Mirror the editor's text into React state (drives hasContent + the slash menu). */
  const syncText = () => {
    const t = getEditorText();
    setText(t);
    setShowSlash(t.startsWith('/'));
  };

  /** Insert a picked element as an inline chip at the caret (falls back to the
   *  end when the editor isn't focused, e.g. straight after picking in the
   *  browser). Mirrors the extension's insertChipAtCursor. */
  const insertChipAtCursor = (anchor: ElementAnchor) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const id = `a${chipSeqRef.current++}`;
    anchorMapRef.current.set(id, anchor);

    const chip = document.createElement('span');
    chip.className = 'composer__inline-chip';
    chip.contentEditable = 'false';
    chip.dataset.anchorId = id;
    chip.title = anchor.domPath || anchor.selector || '';
    const icon = document.createElement('span');
    icon.className = 'composer__inline-chip-icon';
    icon.textContent = '⦾';
    const label = document.createElement('span');
    label.className = 'composer__inline-chip-label';
    label.textContent = anchorLabel(anchor);
    chip.append(icon, label);

    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).startContainer)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(chip);
    } else {
      editor.appendChild(chip);
    }
    // A trailing space parks the caret outside the chip so typing continues cleanly.
    const space = document.createTextNode(' ');
    chip.after(space);
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(space);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    syncText();
  };

  // Drain anchors staged by the picker / Components-tree click into inline chips
  // at the caret, then clear the staging area. `draftAnchors` keeps a stable ref
  // across unrelated task updates, so this only fires when one is actually added.
  useEffect(() => {
    if (draftAnchors.length === 0) return;
    for (const a of draftAnchors) insertChipAtCursor(a);
    clearDraftAnchors(taskId);
    // The pick happened in the browser webview, which stole focus — restore it.
    setTimeout(() => editorRef.current?.focus(), 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAnchors, taskId]);

  const hasContent = !!text.trim() || images.length > 0 || files.length > 0 || !!selected;

  const submit = () => {
    // No running-guard: follow-up messages mid-turn are allowed. The store keeps
    // the task's sessionId, so the backend streams them into the live query (its
    // AsyncMessagePump queues them onto the next turn) — same as the extension.
    if (!hasContent) return;
    // Anchors this turn = the inline chips still present in the editor + any live
    // edit-mode selection. draftAnchors was already drained into chips, so the
    // store's merge adds nothing on top of these.
    const anchors = [...collectAnchors(), ...(selected ? [selected] : [])];
    send({
      taskId,
      message: getEditorText(),
      url: pageUrl,
      anchors: anchors.length > 0 ? anchors : undefined,
      projectDir: projectDir || undefined,
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined,
    });
    if (editorRef.current) editorRef.current.innerHTML = '';
    anchorMapRef.current.clear();
    setText('');
    setImages([]);
    setFiles([]);
    setShowSlash(false);
    if (connectedBrowserId) useEditorStore.getState().clearSelection(connectedBrowserId);
  };

  const stop = () => {
    if (task?.sessionId) window.ccb.send({ type: 'agent:interrupt', sessionId: task.sessionId });
  };

  /** Pick an element from this chat's connected browser into the draft. */
  const startPick = () => {
    const bs = useBrowserStore.getState();
    let id = connectedBrowserId && bs.instances[connectedBrowserId] ? connectedBrowserId : null;
    if (!id) id = bs.openBrowser({ hint: true }); // none connected → open one to type a URL into
    // Bring the target browser to the foreground (un-hides a webview in another
    // pane; the webview never reparents, so its guest bridge stays valid).
    useUiStore.getState().setActiveTab({ kind: 'browser', id });
    // A blank/just-opened browser has nothing to pick — let the user load a page first.
    if (!useBrowserStore.getState().instances[id]?.loadedUrl) return;
    setPickerTrigger(id, taskId);
    useEditorStore.getState().activatePicker(id);
  };

  /** Open a browser to browse the web (the "+" menu's "Browse the web"). */
  const onBrowse = () => {
    const id = useBrowserStore.getState().openBrowser({ hint: true });
    useUiStore.getState().setActiveTab({ kind: 'browser', id });
  };

  /** Open the slash-command menu (the "/" button): seed the editor with a
   *  leading "/" if it isn't already there, focus, and park the caret at the end
   *  so the menu filters as the user keeps typing. */
  const openSlash = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    // Seed a leading "/" so the command menu opens — but only when the editor
    // holds plain text (no inline element chips), so we never clobber a chip.
    const hasChips = !!editor.querySelector('.composer__inline-chip');
    if (!hasChips && !getEditorText().startsWith('/')) {
      editor.textContent = `/${getEditorText()}`;
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    syncText();
  };

  /** Advance the conversation's permission mode (⇧+Tab, and matches Claude Code). */
  const cycleMode = () => {
    const cur = task?.permissionMode ?? 'bypassPermissions';
    useTasksStore.getState().setRunMode(taskId, { permissionMode: nextPermissionMode(cur) });
  };

  const onSlashSelect = (command: string) => {
    const value = command.endsWith(' ') ? command : `${command} `;
    const editor = editorRef.current;
    if (editor) {
      editor.textContent = value;
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setText(value);
    setShowSlash(false);
    editorRef.current?.focus();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    const items = e.clipboardData?.items;
    const fromClipboard: File[] = [];
    for (const item of items ? Array.from(items) : []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) fromClipboard.push(f);
      }
    }
    if (fromClipboard.length) {
      e.preventDefault();
      void addFiles(fromClipboard);
      return;
    }
    // Plain-text only — never let rich HTML (fonts, colors, nested markup) land
    // in the contenteditable.
    e.preventDefault();
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (pasted) document.execCommand('insertText', false, pasted);
    syncText();
  };

  /** Drag-over flicker guard: ignore leave events whose relatedTarget is
   *  another descendant of the composer (crossing internal element borders). */
  const isStillInsideComposer = (e: React.DragEvent): boolean => {
    const wrap = dropWrapRef.current;
    return !!wrap && e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer || e.dataTransfer.types.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (isStillInsideComposer(e)) return;
    if (dragOver) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      ref={dropWrapRef}
      className={`composer ${dragOver ? 'is-drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onKeyDown={(e) => {
        // ⇧+Tab cycles the conversation's permission mode (matches Claude Code).
        // Handled at the container so it works from the editor or any footer
        // control; scoped to the composer subtree so it never hijacks global tab.
        if (e.key === 'Tab' && e.shiftKey) {
          e.preventDefault();
          cycleMode();
        }
      }}
    >
      <ConnectedBrowserChip taskId={taskId} />

      {/* The live edit-mode selection rides above the input as a chip (it tracks
          the page and is cleared on send); picked elements go inline in the editor. */}
      <AnimatePresence initial={false}>
        {selected && (
          <motion.div
            key="chips"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={ANIM}
            className="composer__chips"
          >
            <span className="composer__chip composer__chip--live" title={selected.domPath}>
              &lt;{selected.tagName}&gt;
              <button onClick={() => connectedBrowserId && useEditorStore.getState().clearSelection(connectedBrowserId)} title="Remove" aria-label="Remove element">
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {menuOpen && (
          <SlashCommandMenu commands={commands} filter={text} onSelect={onSlashSelect} onClose={() => setShowSlash(false)} />
        )}
      </AnimatePresence>

      <div className="composer__row">
        <AnimatePresence initial={false}>
          {(images.length > 0 || files.length > 0) && (
            <motion.div
              key="attachments"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={ANIM}
              className="composer__attachments"
            >
              {images.map((src, i) => (
                <motion.div
                  key={`img-${i}-${src.slice(0, 32)}`}
                  layout
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={ANIM}
                  className="composer__att"
                >
                  <img src={src} alt="" />
                  <button
                    className="composer__att-remove"
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove"
                    aria-label="Remove attachment"
                  >
                    <X size={11} strokeWidth={2.25} />
                  </button>
                </motion.div>
              ))}
              {files.map((f, i) => (
                <motion.div
                  key={`file-${i}-${f.name}`}
                  layout
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={ANIM}
                  className="composer__att composer__att--file"
                  title={f.name}
                >
                  <FileText size={14} strokeWidth={1.75} />
                  <span className="composer__att-name">{f.name}</span>
                  <button
                    className="composer__att-remove"
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove"
                    aria-label="Remove attachment"
                  >
                    <X size={11} strokeWidth={2.25} />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {(voice.active || voice.state === 'error') && (
            <VoicePanel key="voice" state={voice.state} interim={voice.interim} error={voice.error} />
          )}
        </AnimatePresence>

        <div className="composer__main">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files;
              if (fs && fs.length) void addFiles(Array.from(fs));
              e.target.value = '';
            }}
          />
          <div
            ref={editorRef}
            className="composer__editor"
            contentEditable
            role="textbox"
            aria-multiline="true"
            suppressContentEditableWarning
            data-placeholder={selected ? `Ask about <${selected.tagName}>…` : 'Reply…'}
            onInput={syncText}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (menuOpen) return; // let the slash menu handle Enter
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer__footer">
            <div className="composer__footer-left">
              <AttachMenu
                onUpload={() => fileInputRef.current?.click()}
                onAddContext={startPick}
                onBrowse={onBrowse}
              />
              <button
                className="composer__tool"
                onClick={openSlash}
                title="Slash commands"
                aria-label="Slash commands"
              >
                <SquareSlash size={16} strokeWidth={1.75} />
              </button>
              {running && (
                <span className="composer__spinner" aria-label="Processing">{SPINNER_FRAMES[spinnerFrame]}</span>
              )}
            </div>
            <div className="composer__controls">
              <RunModeMenu taskId={taskId} />
              {/* Stop rides alongside Send while a turn streams — the user can queue a
                  follow-up message without waiting for the current turn to finish. */}
              <AnimatePresence initial={false}>
                {running && (
                  <motion.button
                    key="stop"
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.7, opacity: 0 }}
                    transition={ANIM}
                    className="composer__stop"
                    onClick={stop}
                    title="Stop"
                  >
                    <Square size={13} strokeWidth={2} fill="currentColor" />
                  </motion.button>
                )}
              </AnimatePresence>
              {/* The action button is a mic while the composer is empty (start a
                  hands-free voice conversation; pressed state ends it) and an
                  arrow once there's something to send. */}
              <AnimatePresence initial={false} mode="popLayout">
                {hasContent ? (
                  <motion.button
                    key="send"
                    layout
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.7, opacity: 0 }}
                    transition={ANIM}
                    className="composer__send"
                    onClick={submit}
                    title="Send"
                  >
                    <ArrowUp size={16} strokeWidth={2.5} />
                  </motion.button>
                ) : (
                  <motion.button
                    key="voice"
                    layout
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.7, opacity: 0 }}
                    transition={ANIM}
                    className={`composer__voice${voice.active ? ' is-active' : ''}`}
                    onClick={toggleVoice}
                    title={voice.active ? 'End voice conversation' : 'Start voice conversation'}
                    aria-pressed={voice.active}
                  >
                    <Mic size={16} strokeWidth={2.25} />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
