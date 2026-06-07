import { FileText } from 'lucide-react';
import { Markdown } from '../lib/markdown';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useFileContextMenu, copyText } from '../hooks/useFileContextMenu';
import type { CtxItem } from './ContextMenu';

export function MarkdownView({ path }: { path: string }) {
  const content = useWorkspaceStore((s) => {
    const buf = s.fileBuffers[path];
    return buf?.kind === 'text' ? buf.content : '';
  });
  const { open, menu } = useFileContextMenu(path);

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const extras: CtxItem[] = [
      { kind: 'item', label: 'Copy as Markdown', icon: <FileText size={13} strokeWidth={1.75} />, onActivate: () => copyText(content) },
    ];
    open(e, extras);
  };

  return (
    <div className="md-rendered" onContextMenu={onContextMenu}>
      <div className="md-rendered__inner">
        <Markdown>{content}</Markdown>
      </div>
      {menu}
    </div>
  );
}
