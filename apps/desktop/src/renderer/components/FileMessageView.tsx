import { motion } from 'framer-motion';
import { FileX2, FileQuestion } from 'lucide-react';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

/**
 * Informative placeholder shown in place of a file's content — works for any
 * file format. Two variants:
 *   - `empty`: the file has zero bytes / no content.
 *   - `error`: the file couldn't be opened or read; `detail` carries the reason.
 */
export function FileMessageView({
  variant, path, detail,
}: {
  variant: 'empty' | 'error';
  path: string;
  detail?: string;
}) {
  const isError = variant === 'error';
  const filename = path.split('/').pop() ?? path;
  return (
    <motion.div
      className="file-message"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={ANIM}
    >
      <span className={`file-message__icon ${isError ? 'is-error' : ''}`}>
        {isError ? <FileX2 size={30} strokeWidth={1.5} /> : <FileQuestion size={30} strokeWidth={1.5} />}
      </span>
      <h2 className="file-message__title">{isError ? "Couldn't open this file" : 'This file is empty'}</h2>
      <p className="file-message__path">{filename}</p>
      {isError ? (
        detail && <pre className="file-message__detail">{detail}</pre>
      ) : (
        <p className="file-message__hint">There's nothing to show — the file has no content yet.</p>
      )}
    </motion.div>
  );
}
