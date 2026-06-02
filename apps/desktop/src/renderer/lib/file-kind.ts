/** Classifies a file by extension so the viewer can dispatch the right surface. */
export type FileKind =
  | 'markdown'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'csv'
  | 'data'
  | 'code'
  | 'unknown';

const MD = new Set(['md', 'markdown', 'mdx']);
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'tif', 'heic']);
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'mpeg', 'mpg', 'wmv', 'flv', '3gp']);
const PDF = new Set(['pdf']);
const WORD = new Set(['doc', 'docx', 'odt', 'rtf']);
const SPREAD = new Set(['xls', 'xlsx', 'ods']);
const CSV = new Set(['csv', 'tsv']);
const DATA = new Set([
  'parquet',
  'arrow', 'feather', 'ipc',
  'jsonl', 'ndjson',
]);

/** Known programming/text extensions that should open in Monaco source view.
 *  Files whose extension isn't in any set fall through to `unknown` instead of
 *  silently being shoved into Monaco. */
const CODE = new Set([
  // Web / JS-family
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'json5', 'jsonc',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'vue', 'svelte', 'astro',
  // Markup / config
  'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg', 'properties', 'editorconfig',
  'gitignore', 'gitattributes', 'dockerignore', 'npmignore', 'eslintignore',
  'xml', 'plist', 'graphql', 'gql', 'proto',
  // Systems / scripting
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'swift',
  'cs', 'fs', 'fsx', 'vb', 'pl', 'pm', 'lua', 'r', 'dart', 'erl', 'ex', 'exs',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'dockerfile', 'makefile', 'cmake', 'gradle',
  // Docs / plain text
  'txt', 'log', 'text', 'rst', 'tex', 'org',
]);

export function fileKind(filename: string): FileKind {
  const name = filename.toLowerCase();
  const ext = name.split('.').pop() ?? '';
  // Some files are typed by exact name, not extension.
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('cmakelists')) return 'code';
  if (MD.has(ext)) return 'markdown';
  if (IMG.has(ext)) return 'image';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (PDF.has(ext)) return 'pdf';
  if (WORD.has(ext)) return 'word';
  if (SPREAD.has(ext)) return 'spreadsheet';
  if (CSV.has(ext)) return 'csv';
  if (DATA.has(ext)) return 'data';
  if (CODE.has(ext)) return 'code';
  return 'unknown';
}

export function kindLabel(kind: FileKind): string {
  switch (kind) {
    case 'markdown': return 'Markdown';
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'video': return 'Video';
    case 'pdf': return 'PDF';
    case 'word': return 'Word document';
    case 'spreadsheet': return 'Spreadsheet';
    case 'csv': return 'CSV';
    case 'data': return 'Data';
    case 'code': return 'Code';
    case 'unknown': return 'File';
  }
}

export type ViewMode = 'rendered' | 'source' | 'grid' | 'hex' | 'info';

/** Default view mode for a freshly-opened file.
 *  Text-but-unknown (Dockerfile-without-extension, makefiles, .env, etc.)
 *  defaults to the Monaco editor — not the Info pane. */
export function defaultViewMode(kind: FileKind, isBinary: boolean): ViewMode {
  switch (kind) {
    case 'markdown':
    case 'image':
    case 'audio':
    case 'video':
    case 'pdf':
    case 'word': return 'rendered';
    case 'csv':
    case 'data':
    case 'spreadsheet': return 'grid';
    case 'code': return 'source';
    case 'unknown': return isBinary ? 'info' : 'source';
  }
}

/** Modes the user can switch between for this (kind, isBinary) combo.
 *  Hex + Info are universal — every file can show its bytes and its metadata. */
export function modesForBuffer(kind: FileKind, isBinary: boolean): ViewMode[] {
  const modes: ViewMode[] = [];
  if (!isBinary) {
    // Text files. Some "text" kinds also have a meaningful rendered view —
    // notably SVG (rendered as an image) and markdown.
    if (kind === 'image') modes.push('rendered', 'source');
    else if (kind === 'markdown') modes.push('rendered', 'source');
    else if (kind === 'csv') modes.push('grid', 'source');
    else if (kind === 'data') modes.push('grid', 'source');
    else modes.push('source'); // includes 'code' and text-but-unknown
  } else {
    if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf' || kind === 'word' || kind === 'spreadsheet') modes.push('rendered');
    if (kind === 'data' || kind === 'csv' || kind === 'spreadsheet') modes.push('grid');
  }
  // Universal trailing modes — every file gets a raw-bytes view and an info pane.
  modes.push('hex', 'info');
  return modes;
}
