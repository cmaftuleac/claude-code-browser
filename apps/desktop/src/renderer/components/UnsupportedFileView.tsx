import { Image, FileType, Sheet, File } from 'lucide-react';
import { kindLabel, type FileKind } from '../lib/file-kind';

const ICON: Partial<Record<FileKind, React.ReactNode>> = {
  image: <Image size={28} strokeWidth={1.5} />,
  pdf: <FileType size={28} strokeWidth={1.5} />,
  word: <File size={28} strokeWidth={1.5} />,
  spreadsheet: <Sheet size={28} strokeWidth={1.5} />,
  csv: <Sheet size={28} strokeWidth={1.5} />,
};

/** Placeholder for formats whose rendered preview isn't wired yet. The
 *  toolbar above offers the format-specific actions; this is what fills the
 *  body when "Rendered" is selected and we don't have a renderer for it. */
export function UnsupportedFileView({ path, kind }: { path: string; kind: FileKind }) {
  return (
    <div className="file-unsupported">
      <span className="file-unsupported__icon">{ICON[kind] ?? <File size={28} strokeWidth={1.5} />}</span>
      <h2 className="file-unsupported__title">{kindLabel(kind)} preview not yet supported</h2>
      <p className="file-unsupported__path">{path}</p>
      <p className="file-unsupported__hint">Use the toolbar above to switch to <b>Source</b> view (if the file is text), or open the file externally.</p>
    </div>
  );
}
