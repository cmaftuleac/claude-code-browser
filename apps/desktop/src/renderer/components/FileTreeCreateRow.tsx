import { useEffect, useRef, useState } from 'react';
import { File as FileIcon, Folder as FolderIcon } from 'lucide-react';

interface Props {
  kind: 'file' | 'folder';
  depth: number;
  onSubmit: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}

/**
 * Inline create row rendered as a child of an expanded directory while the
 * user names a new file or folder. Same shape as a normal tree row but with
 * an editable input. Enter submits, Esc cancels, blur submits if non-empty.
 */
export function FileTreeCreateRow({ kind, depth, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guard so the blur handler doesn't fight the Enter/Esc handlers.
  const settledRef = useRef<boolean>(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const finish = async (commit: boolean): Promise<void> => {
    if (settledRef.current || submitting) return;
    if (!commit) { settledRef.current = true; onCancel(); return; }
    const trimmed = value.trim();
    if (!trimmed) { settledRef.current = true; onCancel(); return; }
    setSubmitting(true);
    const res = await onSubmit(trimmed);
    if (!res.ok) {
      setError(res.error ?? 'Could not create.');
      setSubmitting(false);
      // Re-focus so the user can fix the name.
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    settledRef.current = true;
  };

  return (
    <div>
      <div className="tree__row is-creating" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="tree__twisty" aria-hidden />
        <span className="tree__icon" aria-hidden>
          {kind === 'folder' ? <FolderIcon size={13} strokeWidth={1.75} /> : <FileIcon size={13} strokeWidth={1.75} />}
        </span>
        <input
          ref={inputRef}
          className="tree__rename"
          value={value}
          placeholder={kind === 'folder' ? 'New folder' : 'New file'}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void finish(false); }
            else { e.stopPropagation(); }
          }}
          onBlur={() => { void finish(value.trim().length > 0); }}
          spellCheck={false}
        />
      </div>
      {error && (
        <div className="tree__rename-error" style={{ paddingLeft: 8 + depth * 12 + 32 }}>{error}</div>
      )}
    </div>
  );
}
