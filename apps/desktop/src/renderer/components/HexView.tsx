import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../stores/workspace-store';

const BYTES_PER_ROW = 16;
const ROW_H = 18;
/** 4 KB chunks = 256 hex rows. Small enough that loads are quick, big enough
 *  that scrolling rarely needs more than 1–2 in flight. */
const CHUNK_BYTES = 4096;
const OVERSCAN_ROWS = 32;
/** Chromium's element-height ceiling sits around 33.5M px. Cap the virtual
 *  scroll container under that. When the natural row count would exceed this,
 *  we compress the scroll mapping (1 scroll-px ≈ N rows). */
const MAX_VIRTUAL_HEIGHT = 30_000_000;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(n: number, w = 2): string {
  return n.toString(16).padStart(w, '0').toUpperCase();
}

function ascii(b: number): string {
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type ChunkState = Uint8Array | 'loading' | 'error';

/**
 * Virtualized DOS-style hex viewer with **arbitrary-size scroll**:
 *
 *  - For small files the scroll container's height matches `totalRows × ROW_H`
 *    (natural 1:1 mapping). Smooth scroll, no surprises.
 *
 *  - For huge files (>~1.8M rows, ~30 MB) we cap the scroll container at
 *    `MAX_VIRTUAL_HEIGHT` and compress the scroll mapping: scroll progress
 *    0…1 maps to row index 0…(totalRows − visibleRows). Rows render in a
 *    `position: sticky` overlay so they always paint at the viewport top.
 *    The browser scrollbar drives navigation; reads are still chunked.
 *
 * Reading is fully on-demand — chunks load only when the visible window
 * crosses them, so 4 GB files paginate as cheaply as 4 KB files.
 */
export function HexView({ path }: { path: string }) {
  const buf = useWorkspaceStore((s) => s.fileBuffers[path]);
  const isBinary = buf?.kind === 'binary';
  const size = isBinary ? buf.size : 0;

  const [chunks, setChunks] = useState<Record<number, ChunkState>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalRows = Math.max(1, Math.ceil(size / BYTES_PER_ROW));
  const naturalHeight = totalRows * ROW_H;
  const compressed = naturalHeight > MAX_VIRTUAL_HEIGHT;
  const virtualHeight = compressed ? MAX_VIRTUAL_HEIGHT : naturalHeight;
  const visibleRows = Math.max(1, Math.ceil(viewportH / ROW_H));
  const maxScroll = Math.max(1, virtualHeight - viewportH);
  const maxTopRow = Math.max(0, totalRows - visibleRows);

  // Map scrollTop → topRow. Natural mode is 1:1; compressed scales proportionally.
  const topRow = compressed
    ? Math.floor((scrollTop / maxScroll) * maxTopRow)
    : Math.floor(scrollTop / ROW_H);

  const firstRow = Math.max(0, topRow - OVERSCAN_ROWS);
  const lastRow = Math.min(totalRows - 1, topRow + visibleRows + OVERSCAN_ROWS);
  const firstChunk = Math.max(0, Math.floor((firstRow * BYTES_PER_ROW) / CHUNK_BYTES));
  const lastChunk = Math.max(0, Math.floor((lastRow * BYTES_PER_ROW) / CHUNK_BYTES));

  // Load any chunks intersecting the visible window we don't already have.
  useEffect(() => {
    if (!isBinary) return;
    for (let ci = firstChunk; ci <= lastChunk; ci++) {
      if (chunks[ci] !== undefined) continue;
      setChunks((c) => ({ ...c, [ci]: 'loading' }));
      const offset = ci * CHUNK_BYTES;
      void window.ccb.fs.readChunk(path, offset, CHUNK_BYTES).then((res) => {
        if (res.error || res.base64 == null) {
          setChunks((c) => ({ ...c, [ci]: 'error' }));
          return;
        }
        setChunks((c) => ({ ...c, [ci]: base64ToBytes(res.base64!) }));
      });
    }
  }, [firstChunk, lastChunk, path, isBinary, chunks]);

  if (!isBinary) return null;

  // Render visible rows. In natural mode they sit at row*ROW_H inside the
  // tall inner div. In compressed mode they sit in the sticky overlay at
  // (i - topRow)*ROW_H so they always paint at the viewport top.
  const rows: React.ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const byteStart = r * BYTES_PER_ROW;
    const ci = Math.floor(byteStart / CHUNK_BYTES);
    const off = byteStart % CHUNK_BYTES;
    const chunk = chunks[ci];
    let view: Uint8Array | null = null;
    if (chunk instanceof Uint8Array) view = chunk.subarray(off, Math.min(off + BYTES_PER_ROW, chunk.length));
    const isLoading = chunk === 'loading' || chunk === undefined;

    const hexCells: React.ReactNode[] = [];
    const asciiCells: React.ReactNode[] = [];
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      const idx = byteStart + i;
      if (idx >= size) {
        hexCells.push(<span key={i} className="hex-byte hex-byte--empty">  </span>);
        asciiCells.push(<span key={i} className="hex-byte--empty"> </span>);
      } else if (view && i < view.length) {
        const b = view[i];
        hexCells.push(<span key={i} className="hex-byte">{hex(b)}</span>);
        asciiCells.push(<span key={i} className={b >= 0x20 && b <= 0x7e ? 'hex-ascii' : 'hex-ascii--ctrl'}>{ascii(b)}</span>);
      } else {
        hexCells.push(<span key={i} className="hex-byte hex-byte--loading">··</span>);
        asciiCells.push(<span key={i} className="hex-ascii--ctrl">·</span>);
      }
    }

    const top = compressed ? (r - topRow) * ROW_H : r * ROW_H;
    rows.push(
      <div
        key={r}
        className="hex-row"
        style={{ position: 'absolute', top, height: ROW_H, left: 0, right: 0 }}
        data-loading={isLoading ? '1' : undefined}
      >
        <span className="hex-row__offset">{hex(byteStart, 10)}</span>
        <span className="hex-row__bytes">{hexCells}</span>
        <span className="hex-row__ascii">{asciiCells}</span>
      </div>,
    );
  }

  return (
    <div className="hex-view">
      <div className="hex-view__head">
        <span>OFFSET</span>
        <span>00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F</span>
        <span>ASCII</span>
      </div>
      <div
        ref={containerRef}
        className="hex-view__scroll"
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <div className="hex-view__spacer" style={{ height: virtualHeight, position: 'relative' }}>
          {compressed ? (
            // Sticky overlay: visible rows always pinned to the viewport top,
            // scrollbar still scales over the (compressed) total range.
            <div
              className="hex-view__sticky"
              style={{ position: 'sticky', top: 0, height: viewportH, overflow: 'hidden' }}
            >
              {rows}
            </div>
          ) : (
            // Natural 1:1 mapping — rows positioned at their row*ROW_H offset.
            rows
          )}
        </div>
      </div>
      <div className="hex-view__foot">
        {formatBytes(size)} · {totalRows.toLocaleString()} rows{compressed ? ' · scaled scroll' : ''}
      </div>
    </div>
  );
}
