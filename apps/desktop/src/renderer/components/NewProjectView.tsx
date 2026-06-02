import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, FolderOpen } from 'lucide-react';
import { useWorkspaceStore } from '../stores/workspace-store';

const DEFAULT_PARENT = '~/Projects';

/** "New project" surface — a pushed view inside HomeScreen's navigation
 *  stack. Replaces the old modal popup. Renders with a top-left back
 *  chevron that pops back to the project list. */
export function NewProjectView({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('');
  const [parent, setParent] = useState(DEFAULT_PARENT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const openFolder = useWorkspaceStore((s) => s.openFolder);

  useEffect(() => {
    // Tiny delay so the slide-in animation finishes before focus kicks the
    // keyboard caret in. Pure UX nicety.
    const t = window.setTimeout(() => nameRef.current?.focus(), 180);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.clearTimeout(t); };
  }, [onBack]);

  const choseParent = async () => {
    if (!window.ccb.isElectron) return;
    const picked = await window.ccb.fs.pickFolder();
    if (picked) setParent(picked);
  };

  const submit = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError('Project name is required.'); return; }
    if (trimmed.includes('/') || trimmed.includes('\\')) { setError('Project name cannot contain slashes.'); return; }
    setSubmitting(true);
    const res = await window.ccb.fs.createProject(parent, trimmed);
    if (!res.ok || !res.path) {
      setSubmitting(false);
      setError(res.error ?? 'Could not create project.');
      return;
    }
    await openFolder(res.path);
  };

  return (
    <div className="push-view">
      <button className="push-view__back" onClick={onBack} aria-label="Back">
        <ChevronLeft size={16} strokeWidth={2} />
        <span>Back</span>
      </button>

      <div className="push-view__body">
        <h1 className="push-view__title">New project</h1>
        <p className="push-view__hint">Creates an empty folder ready for Claude Code to work in.</p>

        <label className="push-view__field">
          <span className="push-view__field-label">Project name</span>
          <input
            ref={nameRef}
            className="push-view__input"
            value={name}
            placeholder="my-new-project"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            spellCheck={false}
          />
        </label>

        <label className="push-view__field">
          <span className="push-view__field-label">Parent folder</span>
          <div className="push-view__row">
            <input
              className="push-view__input"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              spellCheck={false}
            />
            {window.ccb.isElectron && (
              <button className="push-view__choose" onClick={choseParent} title="Choose…">
                <FolderOpen size={13} strokeWidth={1.75} />
                Choose…
              </button>
            )}
          </div>
        </label>

        {error && <div className="push-view__error">{error}</div>}

        <div className="push-view__actions">
          <button
            className="push-view__btn push-view__btn--primary"
            onClick={() => void submit()}
            disabled={submitting || !name.trim()}
          >
            {submitting ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
