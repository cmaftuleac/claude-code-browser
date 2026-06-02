import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useWorkspaceStore } from '../stores/workspace-store';

export function MarkdownView({ path }: { path: string }) {
  const content = useWorkspaceStore((s) => {
    const buf = s.fileBuffers[path];
    return buf?.kind === 'text' ? buf.content : '';
  });
  return (
    <div className="md-rendered">
      <div className="md-rendered__inner">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
