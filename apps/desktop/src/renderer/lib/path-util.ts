/** Parent directory of an absolute path, handling both POSIX (`/`) and Windows
 *  (`\`) separators. Returns '' when there is no parent segment (e.g. a bare
 *  root). Matches the old `p.slice(0, p.lastIndexOf('/'))` behavior on POSIX. */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '';
}

/** Join a directory and a child name using the directory's own separator, so a
 *  Windows root (`C:\proj`) doesn't end up with a mixed `C:\proj/child` path. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
