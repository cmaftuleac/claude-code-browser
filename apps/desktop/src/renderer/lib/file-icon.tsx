import {
  File, FileCode, FileJson, FileText, FileType, Image, Braces, Cog, Hash, Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface IconSpec {
  Icon: LucideIcon;
  /** Subtle hue token applied via CSS color (uses --text-2 by default). */
  hue?: string;
}

const MAP: Record<string, IconSpec> = {
  ts: { Icon: FileCode, hue: '#3b82f6' },
  tsx: { Icon: FileCode, hue: '#3b82f6' },
  js: { Icon: FileCode, hue: '#eab308' },
  jsx: { Icon: FileCode, hue: '#eab308' },
  mjs: { Icon: FileCode, hue: '#eab308' },
  cjs: { Icon: FileCode, hue: '#eab308' },
  json: { Icon: FileJson, hue: '#f59e0b' },
  json5: { Icon: FileJson, hue: '#f59e0b' },
  yaml: { Icon: Braces, hue: '#a78bfa' },
  yml: { Icon: Braces, hue: '#a78bfa' },
  toml: { Icon: Braces, hue: '#a78bfa' },
  md: { Icon: FileText, hue: '#94a3b8' },
  markdown: { Icon: FileText, hue: '#94a3b8' },
  txt: { Icon: FileText },
  html: { Icon: FileCode, hue: '#fb923c' },
  htm: { Icon: FileCode, hue: '#fb923c' },
  css: { Icon: FileCode, hue: '#22d3ee' },
  scss: { Icon: FileCode, hue: '#ec4899' },
  less: { Icon: FileCode, hue: '#3b82f6' },
  py: { Icon: FileCode, hue: '#22c55e' },
  go: { Icon: FileCode, hue: '#22d3ee' },
  rs: { Icon: FileCode, hue: '#fb923c' },
  java: { Icon: FileCode, hue: '#fb923c' },
  rb: { Icon: FileCode, hue: '#ef4444' },
  sh: { Icon: Terminal, hue: '#94a3b8' },
  bash: { Icon: Terminal, hue: '#94a3b8' },
  zsh: { Icon: Terminal, hue: '#94a3b8' },
  env: { Icon: Cog, hue: '#a3a3a3' },
  png: { Icon: Image, hue: '#a78bfa' },
  jpg: { Icon: Image, hue: '#a78bfa' },
  jpeg: { Icon: Image, hue: '#a78bfa' },
  gif: { Icon: Image, hue: '#a78bfa' },
  svg: { Icon: Image, hue: '#22d3ee' },
  webp: { Icon: Image, hue: '#a78bfa' },
  csv: { Icon: Hash, hue: '#94a3b8' },
  lock: { Icon: FileType, hue: '#71717a' },
};

const SPECIAL: Record<string, IconSpec> = {
  'package.json': { Icon: FileJson, hue: '#ef4444' },
  'tsconfig.json': { Icon: FileJson, hue: '#3b82f6' },
  'package-lock.json': { Icon: FileType, hue: '#71717a' },
  'README.md': { Icon: FileText, hue: '#e4e4e7' },
  '.gitignore': { Icon: Cog, hue: '#71717a' },
  '.env': { Icon: Cog, hue: '#a3a3a3' },
};

export function iconFor(filename: string): IconSpec {
  if (SPECIAL[filename]) return SPECIAL[filename];
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MAP[ext] ?? { Icon: File };
}
