import { MousePointerClick, Copy, Trash2, EyeOff, Sparkles, Eraser } from 'lucide-react';
import { useEditorStore } from '../stores/editor-store';
import { useTasksStore, selectActiveTask } from '../stores/tasks-store';
import { useBrowserStore } from '../stores/browser-store';
import { useWorkspaceStore } from '../stores/workspace-store';

/** Inspector-style sidebar: edit computed styles & attributes of the selected
 *  element (round-tripped live to the guest), plus the visual edit journal and
 *  the "Save to code" action that hands the journal to the agent. */
export function PropertiesPanel() {
  const { selected, styles, attributes, journal, applyStyle, applyAttr, runAction, clearJournal } = useEditorStore();
  const send = useTasksStore((s) => s.send);
  const setActiveSurface = useTasksStore((s) => s.setActiveSurface);
  const activeTask = useTasksStore(selectActiveTask);
  const loadedUrl = useBrowserStore((s) => s.loadedUrl);
  const projectDir = useWorkspaceStore((s) => s.root);

  if (!selected) {
    return <div className="props props--empty">Switch to <b>Edit</b> mode and click an element to inspect it.</div>;
  }

  const saveToCode = () => {
    if (journal.length === 0) return;
    const summary = journal
      .map((e, i) => {
        const change = e.before !== undefined ? `: ${e.before} → ${e.after}` : e.after ? `: ${e.after}` : '';
        return `${i + 1}. [${e.type}] ${e.selector}${e.name ? ` (${e.name})` : ''}${change}`;
      })
      .join('\n');
    send({
      message:
        `Apply these visual edits I made on ${loadedUrl} to the source code` +
        `${projectDir ? ` in ${projectDir}` : ''}. Find the corresponding source and make equivalent changes:\n\n${summary}`,
      url: loadedUrl,
      anchors: [selected],
      projectDir: projectDir || undefined,
      editJournal: journal,
    });
    if (activeTask) setActiveSurface(activeTask.id, 'conv');
  };

  return (
    <div className="props">
      <div className="props__head">
        <MousePointerClick className="props__head-icon" size={14} strokeWidth={1.75} />
        <span className="props__tag">&lt;{selected.tagName}&gt;</span>
      </div>
      <code className="props__selector">{selected.selector}</code>

      <div className="props__actions">
        <button onClick={() => runAction('duplicate')}><Copy size={12} strokeWidth={1.75} /> Duplicate</button>
        <button onClick={() => runAction('hide')}><EyeOff size={12} strokeWidth={1.75} /> Hide</button>
        <button onClick={() => runAction('delete')}><Trash2 size={12} strokeWidth={1.75} /> Delete</button>
      </div>

      <Section title="Styles">
        {Object.entries(styles).map(([prop, value]) => (
          <Field key={prop} label={prop} value={value} onCommit={(v) => applyStyle(prop, v)} />
        ))}
      </Section>

      <Section title="Attributes">
        {Object.entries(attributes).map(([name, value]) => (
          <Field key={name} label={name} value={value} onCommit={(v) => applyAttr(name, v)} />
        ))}
        {Object.keys(attributes).length === 0 && <div className="props__hint">No attributes.</div>}
      </Section>

      <Section title={`Edit journal · ${journal.length}`}>
        {journal.length === 0 && <div className="props__hint">Drag, resize, or edit properties to record changes.</div>}
        {journal.map((e, i) => (
          <div key={i} className="props__journal-row">
            <span className="props__journal-type">{e.type}</span>
            <span className="props__journal-detail">
              {e.name ? `${e.name} ` : ''}{e.before !== undefined ? `${e.before} → ${e.after}` : e.after}
            </span>
          </div>
        ))}
        <div className="props__journal-actions">
          <button className="props__save" disabled={journal.length === 0} onClick={saveToCode}>
            <Sparkles size={13} strokeWidth={1.75} /> Save to code
          </button>
          <button disabled={journal.length === 0} onClick={clearJournal}>
            <Eraser size={12} strokeWidth={1.75} /> Clear
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="props__section">
      <div className="props__section-title">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <label className="props__field">
      <span className="props__field-label">{label}</span>
      <input
        className="props__field-input"
        defaultValue={value}
        key={value}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value);
        }}
      />
    </label>
  );
}
