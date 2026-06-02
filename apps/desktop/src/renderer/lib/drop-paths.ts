/**
 * Shared helpers for drag-and-drop in the desktop renderer.
 *
 * `extractDroppedPaths` reads absolute filesystem paths off a DataTransfer
 * object, distinguishing intra-tree drags (custom MIME) from external
 * Finder/Explorer drops (the OS-provided `Files` list).
 *
 * `readFileAsDataUrl` mirrors `apps/extension`'s helper so attachments use
 * the exact same base64-data-URL shape the host already understands.
 */

/** Custom MIME used by FileTreeNode for intra-tree drags. */
export const TREE_DRAG_MIME = 'application/x-ccb-tree-paths';

export interface ExtractedDrop {
  paths: string[];
  /** True iff the drop originated inside the tree (move semantics by default). */
  internal: boolean;
}

export function extractDroppedPaths(dt: DataTransfer): ExtractedDrop {
  const internalRaw = dt.getData(TREE_DRAG_MIME);
  if (internalRaw) {
    try {
      const parsed = JSON.parse(internalRaw);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return { paths: parsed, internal: true };
      }
    } catch { /* fall through to external */ }
  }
  if (dt.files && dt.files.length > 0 && window.ccb.isElectron) {
    const out: string[] = [];
    for (const f of Array.from(dt.files)) {
      const p = window.ccb.fs.getDroppedFilePath(f);
      if (p) out.push(p);
    }
    return { paths: out, internal: false };
  }
  return { paths: [], internal: false };
}

/** Convert a File (from <input>, paste, or drop) to a base64 data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
