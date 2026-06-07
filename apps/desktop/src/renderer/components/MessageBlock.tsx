import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Brain, Wrench, AlertTriangle, Copy, FileText, Paperclip } from 'lucide-react';
import { Markdown } from '../lib/markdown';
import type { Block } from '../stores/tasks-store';
import { ContextMenu, type CtxItem } from './ContextMenu';
import { PermissionRequestCard } from './PermissionRequestCard';

const ANIM = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

interface MenuAnchor { x: number; y: number; rendered: string; raw?: string; }

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => { /* clipboard may be blocked */ });
}

function blockContextItems(anchor: MenuAnchor): CtxItem[] {
  const items: CtxItem[] = [
    { kind: 'item', label: 'Copy Text', icon: <Copy size={13} strokeWidth={1.75} />, onActivate: () => copyToClipboard(anchor.rendered) },
  ];
  // Only assistant blocks render markdown — their "raw" is the markdown source.
  if (anchor.raw && anchor.raw !== anchor.rendered) {
    items.push({ kind: 'item', label: 'Copy as Markdown', icon: <FileText size={13} strokeWidth={1.75} />, onActivate: () => copyToClipboard(anchor.raw!) });
  }
  return items;
}

export function MessageBlock({ block, taskId }: { block: Block; taskId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const openMenu = (e: React.MouseEvent, raw?: string): void => {
    e.preventDefault();
    e.stopPropagation();
    const rendered = ref.current?.textContent ?? '';
    setMenu({ x: e.clientX, y: e.clientY, rendered, raw });
  };

  if (block.kind === 'user') {
    // Anchors are stored structurally on the block (send() injects no `<tag>`
    // markers into the text), so render them as a chip row rather than parsing
    // the content. Both anchors and images are absent for resumed sessions.
    const anchors = block.anchors ?? [];
    const images = block.images ?? [];
    const files = block.files ?? [];
    return (
      <>
        <motion.div
          ref={ref}
          layout
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={ANIM}
          className="block block--user"
          onContextMenu={(e) => openMenu(e, block.content)}
        >
          {anchors.length > 0 && (
            <div className="block--user__chips">
              {anchors.map((a, i) => (
                <span className="block--user__chip" key={`${i}-${a.selector}`} title={a.domPath}>
                  &lt;{a.tagName}&gt;
                </span>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="block--user__images">
              {images.map((src, i) => (
                <img key={`${i}-${src.slice(0, 32)}`} src={src} alt="attachment" />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="block--user__files">
              {files.map((f, i) => (
                <span className="block--user__file" key={`${i}-${f.name}`} title={f.name}>
                  <Paperclip size={12} strokeWidth={1.75} />
                  {f.name}
                </span>
              ))}
            </div>
          )}
          {block.content && <span className="block--user__text">{block.content}</span>}
        </motion.div>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={blockContextItems(menu)} onDismiss={() => setMenu(null)} />}
      </>
    );
  }

  if (block.kind === 'assistant') {
    return (
      <>
        <motion.div
          ref={ref}
          layout
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={ANIM}
          className="block block--assistant"
          onContextMenu={(e) => openMenu(e, block.content)}
        >
          <Markdown>{block.content}</Markdown>
        </motion.div>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={blockContextItems(menu)} onDismiss={() => setMenu(null)} />}
      </>
    );
  }

  if (block.kind === 'thinking') {
    return <CollapsibleCard icon={<Brain size={12} strokeWidth={1.75} />} label={`Thinking${block.streaming ? '…' : ''}`} body={block.content} mono />;
  }

  if (block.kind === 'tool') {
    return <CollapsibleCard icon={<Wrench size={12} strokeWidth={1.75} />} label={block.toolName === '_notice_' ? 'Notice' : block.toolName} body={block.summary} mono />;
  }

  if (block.kind === 'permission') {
    return <PermissionRequestCard block={block} taskId={taskId} />;
  }

  // system
  return (
    <>
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ANIM}
        className="block block--system"
        onContextMenu={(e) => openMenu(e, block.content)}
      >
        <AlertTriangle size={13} strokeWidth={1.75} />
        <span>{block.content}</span>
      </motion.div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={blockContextItems(menu)} onDismiss={() => setMenu(null)} />}
    </>
  );
}

function CollapsibleCard({ icon, label, body, mono }: { icon: React.ReactNode; label: string; body: string; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ANIM}
        className="block-card"
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, rendered: body }); }}
      >
        <button className="block-card__head" onClick={() => setOpen((v) => !v)}>
          <span className="block-card__icon">{open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}</span>
          <span className="block-card__icon">{icon}</span>
          <span className="block-card__label">{label}</span>
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={ANIM}
              style={{ overflow: 'hidden' }}
            >
              <div className="block-card__body" style={!mono ? { fontFamily: 'inherit' } : undefined}>
                {body}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={blockContextItems(menu)} onDismiss={() => setMenu(null)} />}
    </>
  );
}
