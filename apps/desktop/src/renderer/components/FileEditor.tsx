import Editor from '@monaco-editor/react';
import '../monaco-setup';
import { useWorkspaceStore } from '../stores/workspace-store';

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

  return (
    <Editor
      theme="vs"
      path={path}
      language={languageFor(path)}
      value={content}
      onChange={(v) => setFileContent(path, v ?? '')}
      onMount={(editor, m) => {
        editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
          void saveFile(path);
        });
      }}
      options={{
        fontSize: 13,
        minimap: { enabled: true },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: 'selection',
      }}
    />
  );
}
