/**
 * Slash-command discovery — ported from apps/host/src/host.ts so the desktop
 * chat input shows the same /commands and /skills as the extension.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export function scanSlashCommands(): Array<{ name: string; description: string; hint?: string }> {
  const commands: Array<{ name: string; description: string; hint?: string }> = [];
  const seen = new Set<string>();

  const dirs = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.claude', 'commands'),
    join(process.cwd(), '.claude', 'skills'),
    join(process.cwd(), '.claude', 'commands'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) {
            const parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
            const name = parsed.name || entry.name;
            if (!seen.has(name)) {
              seen.add(name);
              commands.push({ name: `/${name}`, description: parsed.description || '', hint: parsed.argumentHint });
            }
          }
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const name = basename(entry.name, '.md');
          if (!seen.has(name)) {
            seen.add(name);
            const content = readFileSync(join(dir, entry.name), 'utf-8');
            const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('---'))?.trim() || '';
            commands.push({ name: `/${name}`, description: firstLine.slice(0, 80) });
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  const builtins = [
    { name: '/clear', description: 'Clear the conversation' },
    { name: '/compact', description: 'Compact conversation context' },
    { name: '/cost', description: 'Show token usage and cost' },
    { name: '/help', description: 'Show available commands' },
  ];
  for (const cmd of builtins) {
    if (!seen.has(cmd.name.slice(1))) commands.push(cmd);
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string; argumentHint?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const get = (key: string) => yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return { name: get('name'), description: get('description'), argumentHint: get('argument-hint') };
}
