/** Scratch (in-memory, not-yet-on-disk) file buffers use a synthetic path with
 *  this scheme. They flow through the normal file-tab machinery as `file:` tabs
 *  whose path happens to be `untitled:<n>`; saving promotes them to a real path.
 *  Anything writing to disk must special-case these (the path is not real). */
export const UNTITLED_PREFIX = 'untitled:';

export function isUntitledPath(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX);
}

/** Display name for an untitled scratch file, e.g. `untitled:3` → `Untitled-3`. */
export function untitledName(path: string): string {
  return `Untitled-${path.slice(UNTITLED_PREFIX.length)}`;
}
