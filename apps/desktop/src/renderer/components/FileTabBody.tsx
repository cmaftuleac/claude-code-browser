import { motion } from 'framer-motion';
import { Eye, Code2, Table, FolderOpen, ExternalLink, Info, type LucideIcon } from 'lucide-react';
import { HexIcon } from './icons/HexIcon';
import { FileEditor } from './FileEditor';
import { MarkdownView } from './MarkdownView';
import { HexView } from './HexView';
import { DataGridView } from './DataGridView';
import { ImageView } from './ImageView';
import { AudioView } from './AudioView';
import { VideoView } from './VideoView';
import { PdfView } from './PdfView';
import { InfoView } from './InfoView';
import { UnsupportedFileView } from './UnsupportedFileView';
import { FileMessageView } from './FileMessageView';
import { useFileViewModesStore } from '../stores/file-view-modes-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useFileContextMenu } from '../hooks/useFileContextMenu';
import { fileKind, kindLabel, modesForBuffer, type ViewMode } from '../lib/file-kind';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

type IconLike = LucideIcon | React.ComponentType<{ size?: number | string; strokeWidth?: number }>;

const MODE_META: Record<ViewMode, { Icon: IconLike; label: string }> = {
  rendered: { Icon: Eye, label: 'Rendered' },
  source: { Icon: Code2, label: 'Source' },
  grid: { Icon: Table, label: 'Grid' },
  hex: { Icon: HexIcon, label: 'Hex' },
  info: { Icon: Info, label: 'Info' },
};

/** Format-specific toolbar shown above the file content. */
function FileToolbar({ path, isBinary, availableModes }: { path: string; isBinary: boolean; availableModes: ViewMode[] }) {
  const kind = fileKind(path);
  const mode = useFileViewModesStore((s) => s.get(path, isBinary));
  const setMode = useFileViewModesStore((s) => s.set);

  return (
    <div className="file-toolbar">
      <span className="file-toolbar__label">{isBinary ? `Binary · ${kindLabel(kind)}` : kindLabel(kind)}</span>
      <div className="file-toolbar__spacer" />

      {availableModes.length > 1 && (
        <div className="file-toolbar__seg">
          {availableModes.map((m) => {
            const isActive = mode === m;
            const { Icon, label } = MODE_META[m];
            // Universal modes that we want compact: info + hex render icon-only.
            const iconOnly = m === 'info' || m === 'hex';
            return (
              <button
                key={m}
                className={`file-toolbar__seg-btn ${isActive ? 'is-active' : ''} ${iconOnly ? 'file-toolbar__seg-btn--icon' : ''}`}
                onClick={() => setMode(path, m)}
                style={{ position: 'relative' }}
                title={label}
                aria-label={iconOnly ? label : undefined}
              >
                {isActive && (
                  <motion.span
                    layoutId={`file-toolbar-bg:${path}`}
                    className="file-toolbar__seg-bg"
                    transition={ANIM}
                  />
                )}
                <Icon size={12} strokeWidth={1.75} />
                {!iconOnly && <span style={{ position: 'relative' }}>{label}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="file-toolbar__seg">
        <button
          className="file-toolbar__seg-btn file-toolbar__seg-btn--icon"
          onClick={() => void window.ccb.fs.openWith(path)}
          title="Open with…"
          aria-label="Open with…"
        >
          <ExternalLink size={12} strokeWidth={1.75} />
        </button>
        <button
          className="file-toolbar__seg-btn file-toolbar__seg-btn--icon"
          onClick={() => void window.ccb.fs.revealInFinder(path)}
          title="Reveal in Finder"
          aria-label="Reveal in Finder"
        >
          <FolderOpen size={12} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/** Renders a file tab — picks the right viewer based on the active view mode
 *  + buffer kind, with toolbar above. */
export function FileTabBody({ path }: { path: string }) {
  const buf = useWorkspaceStore((s) => s.fileBuffers[path]);
  const error = useWorkspaceStore((s) => s.fileErrors[path]);
  const isBinary = buf?.kind === 'binary';
  const kind = fileKind(path);
  const userMode = useFileViewModesStore((s) => s.get(path, isBinary));
  const availableModes = modesForBuffer(kind, isBinary);
  // Coerce a stale user mode (e.g. 'source' on a binary buffer) into something this buffer supports.
  const mode: ViewMode = availableModes.includes(userMode) ? userMode : availableModes[0];

  // Baseline right-click menu for every viewer. Rich viewers (Markdown, Image,
  // Hex, Grid, Video, Audio, PDF) attach their own handler with extra items and
  // stopPropagation — so this only ever fires for the "passive" panes (Info,
  // Unsupported, empty/error states). We bail for Monaco / webview so the
  // source editor keeps its own (richer, non-native) menu.
  const { open: openMenu, menu } = useFileContextMenu(path);
  const onContextMenu = (e: React.MouseEvent): void => {
    const t = e.target as Element | null;
    if (t?.closest('.monaco-editor') || t?.closest('webview')) return;
    openMenu(e);
  };

  // Couldn't open/read the file — show the reason in place of any viewer.
  // Keep a minimal toolbar (no mode switcher) so "Open With…" / "Reveal" still
  // give the user a way to recover.
  if (error) {
    return (
      <div className="file-tab-body">
        <FileToolbar path={path} isBinary={false} availableModes={[]} />
        <div className="file-tab-body__content" onContextMenu={onContextMenu}>
          <FileMessageView variant="error" path={path} detail={error} />
        </div>
        {menu}
      </div>
    );
  }

  // Empty file — no content to render in a rendered/grid/hex view. Show a
  // message there, but keep the Info pane working and ALWAYS keep the source
  // editor editable (an empty text buffer — incl. a brand-new untitled scratch
  // file — must open an editable Monaco, not a dead "empty" card).
  // Use the LIVE content length for text (so a once-empty file stops being
  // "empty" the moment you type, and Hex/Grid refresh); on-disk size for binary.
  const isEmpty = !!buf && (buf.kind === 'text' ? buf.content.length === 0 : buf.size === 0);

  let body: React.ReactNode;
  if (isEmpty && mode !== 'info' && mode !== 'source') {
    body = <FileMessageView variant="empty" path={path} />;
  } else
  switch (mode) {
    case 'grid':
      body = <DataGridView path={path} />;
      break;
    case 'hex':
      body = <HexView path={path} />;
      break;
    case 'info':
      body = <InfoView path={path} />;
      break;
    case 'rendered':
      if (kind === 'markdown') body = <MarkdownView path={path} />;
      else if (kind === 'image') body = <ImageView path={path} />;
      else if (kind === 'audio') body = <AudioView path={path} />;
      else if (kind === 'video') body = <VideoView path={path} />;
      else if (kind === 'pdf') body = <PdfView path={path} />;
      else body = <UnsupportedFileView path={path} kind={kind} />;
      break;
    case 'source':
    default:
      body = <FileEditor path={path} />;
      break;
  }

  return (
    <div className="file-tab-body">
      <FileToolbar path={path} isBinary={isBinary} availableModes={availableModes} />
      <div className="file-tab-body__content" onContextMenu={onContextMenu}>{body}</div>
      {menu}
    </div>
  );
}
