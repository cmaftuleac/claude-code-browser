import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, Paperclip, Square, X, ChevronDown } from 'lucide-react';
import { useTasksStore } from '../stores/tasks-store';
import { useEditorStore } from '../stores/editor-store';
import { useBrowserStore } from '../stores/browser-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useConnectionStore } from '../stores/connection-store';
import { readFileAsDataUrl } from '../lib/drop-paths';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

export function Composer({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  /** Attached images as base64 data URLs — same shape `apps/extension` sends
   *  and the host already decodes into /tmp/ccb-images/*.png. */
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropWrapRef = useRef<HTMLDivElement | null>(null);

  const send = useTasksStore((s) => s.send);
  const task = useTasksStore((s) => s.tasks.find((t) => t.id === taskId));
  const running = !!task?.running;
  const selected = useEditorStore((s) => s.selected);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const loadedUrl = useBrowserStore((s) => s.loadedUrl);
  const projectDir = useWorkspaceStore((s) => s.root);
  const commands = useConnectionStore((s) => s.commands);

  const matches = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(q)).slice(0, 8);
  }, [text, commands]);

  const addImageFiles = async (files: Iterable<File>): Promise<void> => {
    const collected: string[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try { collected.push(await readFileAsDataUrl(f)); }
      catch { /* skip broken read */ }
    }
    if (collected.length) setImages((prev) => [...prev, ...collected]);
  };

  const submit = () => {
    const message = text.trim();
    if ((!message && images.length === 0) || running) return;
    send({
      message,
      url: loadedUrl,
      anchors: selected ? [selected] : undefined,
      projectDir: projectDir || undefined,
      images: images.length > 0 ? images : undefined,
    });
    setText('');
    setImages([]);
    clearSelection();
  };

  const stop = () => {
    if (task?.sessionId) window.ccb.send({ type: 'agent:interrupt', sessionId: task.sessionId });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const fromClipboard: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) fromClipboard.push(f);
      }
    }
    if (fromClipboard.length) {
      e.preventDefault();
      void addImageFiles(fromClipboard);
    }
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
    if (e.dataTransfer?.files?.length) void addImageFiles(Array.from(e.dataTransfer.files));
  };

  // Auto-expand textarea to fit content up to 8 visible lines. Resets to
  // `auto` first so it can shrink when text is deleted.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = parseFloat(getComputedStyle(el).getPropertyValue('--composer-textarea-max') || '160');
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [text]);

  return (
    <div
      ref={dropWrapRef}
      className={`composer ${dragOver ? 'is-drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <AnimatePresence initial={false}>
        {selected && (
          <motion.div
            key="chip"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={ANIM}
            className="composer__chips"
          >
            <span className="composer__chip">
              &lt;{selected.tagName}&gt;
              <button onClick={clearSelection} title="Remove">
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {matches.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={ANIM}
            className="composer__commands"
          >
            {matches.map((c) => (
              <button key={c.name} className="cmd" onClick={() => setText(c.name + ' ')}>
                <span className="cmd__name">{c.name}</span>
                <span className="cmd__desc">{c.description}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="composer__row">
        <AnimatePresence initial={false}>
          {images.length > 0 && (
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
                  key={`${i}-${src.slice(0, 32)}`}
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
            </motion.div>
          )}
        </AnimatePresence>

        <div className="composer__main">
          <button
            className="composer__attach"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
          >
            <Paperclip size={15} strokeWidth={1.75} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files;
              if (fs && fs.length) void addImageFiles(Array.from(fs));
              e.target.value = '';
            }}
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={selected ? `Ask about <${selected.tagName}>…` : 'Reply…'}
            rows={1}
          />
          <div className="composer__controls">
          <button className="composer__model" title="Model (read-only in this build)">
            Opus 4.5 <ChevronDown size={11} strokeWidth={2} />
          </button>
          <AnimatePresence mode="wait" initial={false}>
            {running ? (
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
            ) : (
              <motion.button
                key="send"
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.7, opacity: 0 }}
                transition={ANIM}
                className="composer__send"
                onClick={submit}
                disabled={!text.trim() && images.length === 0}
                title="Send"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </motion.button>
            )}
          </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
