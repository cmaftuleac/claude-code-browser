import Editor from '@monaco-editor/react';
import '../monaco-setup';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useSettingsStore } from '../stores/settings-store';

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell',
  py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'cpp',
  xml: 'xml', svg: 'xml', toml: 'ini', ini: 'ini',
};
function languageFor(path: string): string | undefined { return LANG[path.split('.').pop()?.toLowerCase() ?? '']; }

export function FileEditor({ path }: { path: string }) {
  const content = useWorkspaceStore((s) => {
    const buf = s.fileBuffers[path];
    return buf?.kind === 'text' ? buf.content : '';
  });
  const setFileContent = useWorkspaceStore((s) => s.setFileContent);
  const saveFile = useWorkspaceStore((s) => s.saveFile);
  const editor = useSettingsStore((s) => s.settings.editor);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);

  return (
    <Editor
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
      path={path}
      language={languageFor(path)}
      value={content}
      // Keep the model alive when this editor unmounts. Unmount happens not just
      // on a real close but also when a tab MOVES between panes and during the
      // brief double-mount window while a split collapses — in those cases the
      // same path is about to be (re)mounted elsewhere, and disposing here would
      // blank the surviving editor (and reopen would fight a half-disposed
      // model). Models are pruned centrally in App.tsx when the file actually
      // leaves `workingFiles`, so reopening a closed file still rebuilds cleanly.
      keepCurrentModel
      onChange={(v) => setFileContent(path, v ?? '')}
      onMount={(editor, m) => {
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
          void saveFile(path);
        });
      }}
      options={{
        fontSize: editor.fontSize,
        minimap: { enabled: editor.minimap },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: editor.tabSize,
        wordWrap: editor.wordWrap,
        renderWhitespace: editor.renderWhitespace,
      }}
    />
  );
}
