import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useWorkspaceStore } from '../stores/workspace-store';
import { fileKind } from '../lib/file-kind';
import { parseCsv } from '../lib/csv-parse';
import { createRemoteAsyncBuffer } from '../lib/remote-async-buffer';

const ROW_H = 28;
const OVERSCAN_ROWS = 12;
const HEADER_H = 32;
const COL_W = 160;
const MAX_PARQUET_ROWS = 10_000;
const MAX_VIRTUAL_HEIGHT = 30_000_000;
/** Caps for chunk-prefix loaders. parquet stays unlimited (truly partial). */
const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const MAX_ARROW_BYTES = 64 * 1024 * 1024;
const MAX_DATA_ROWS = 50_000;

type DataSource = 'csv' | 'parquet' | 'arrow' | 'jsonl';

interface Loaded {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  totalRows: number;
  source: DataSource;
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; data: Loaded }
  | { status: 'error'; error: string };

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

async function readTextPrefix(path: string, byteLength: number, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const want = Math.min(byteLength, maxBytes);
  const buffer = createRemoteAsyncBuffer(path, byteLength);
  const ab = await buffer.slice(0, want);
  // Don't trust the final partial UTF-8 sequence at the truncation boundary;
  // TextDecoder({ fatal: false }) replaces with U+FFFD — fine for preview.
  const text = new TextDecoder('utf-8').decode(new Uint8Array(ab));
  return { text, truncated: byteLength > want };
}

/**
 * Virtualized read-only grid for tabular files.
 *
 * Chunk-readable formats (truly partial):
 *   - parquet  → hyparquet via AsyncBuffer over fs:readChunk
 *   - arrow / feather / ipc → first N MB via fs:readChunk + apache-arrow
 *   - jsonl / ndjson → first N MB via fs:readChunk + per-line JSON.parse
 *   - csv (binary > text-limit) → first N MB via fs:readChunk
 *
 * Small CSVs (text buffer) decode from the in-memory text content directly.
 */
export function DataGridView({ path }: { path: string }) {
  const buf = useWorkspaceStore((s) => s.fileBuffers[path]);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Attach measurement via a callback ref so we wire it the moment the
  // scroll container is *actually* mounted — which happens AFTER state
  // transitions from `loading` to `ready`. Using a useLayoutEffect with
  // empty deps measured during the loading render (ref was null) and never
  // re-ran when the real container appeared, so the grid stayed at 0×0.
  const roRef = useRef<ResizeObserver | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!el) return;
    const measure = (): void => { setViewportH(el.clientHeight); setViewportW(el.clientWidth); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => { roRef.current?.disconnect(); }, []);

  useEffect(() => {
    if (!buf) return;
    let cancelled = false;
    setState({ status: 'loading' });

    const kind = fileKind(path);
    const ext = path.split('.').pop()?.toLowerCase() ?? '';

    function ready(data: Loaded): void {
      if (!cancelled) setState({ status: 'ready', data });
    }
    function fail(err: string): void {
      if (!cancelled) setState({ status: 'error', error: err });
    }

    async function loadCsvFromText(text: string, truncated = false): Promise<void> {
      const parsed = parseCsv(text);
      ready({
        columns: parsed.columns,
        rows: parsed.rows as unknown[][],
        truncated: parsed.truncated || truncated,
        totalRows: parsed.totalLines,
        source: 'csv',
      });
    }

    async function loadCsvBinary(): Promise<void> {
      if (!buf || buf.kind !== 'binary') return;
      try {
        const { text, truncated } = await readTextPrefix(path, buf.size, MAX_CSV_BYTES);
        if (cancelled) return;
        await loadCsvFromText(text, truncated);
      } catch (err) {
        fail(String((err as Error)?.message ?? err));
      }
    }

    async function loadParquet(): Promise<void> {
      try {
        if (!buf || buf.kind !== 'binary') { fail('No buffer for this parquet file.'); return; }
        // Lazy AsyncBuffer over fs:readChunk — hyparquet pages in only the
        // footer + needed row groups, never the whole file.
        const file = createRemoteAsyncBuffer(path, buf.size);
        const { parquetReadObjects, parquetMetadataAsync, cachedAsyncBuffer } = await import('hyparquet');
        const cached = cachedAsyncBuffer(file);
        const meta = await parquetMetadataAsync(cached);
        if (cancelled) return;
        const totalRows = Number(meta.num_rows ?? 0);
        const rowObjs = await parquetReadObjects({
          file: cached,
          rowEnd: Math.min(MAX_PARQUET_ROWS, totalRows || MAX_PARQUET_ROWS),
        }) as Array<Record<string, unknown>>;
        if (cancelled) return;
        const columns = rowObjs.length ? Object.keys(rowObjs[0]) : (meta.schema?.slice(1).map((s) => s.name) ?? []);
        const rows = rowObjs.map((r) => columns.map((c) => r[c]));
        ready({ columns, rows, truncated: totalRows > rows.length, totalRows: totalRows || rows.length, source: 'parquet' });
      } catch (err) {
        fail(String((err as Error)?.message ?? err));
      }
    }

    async function loadArrow(): Promise<void> {
      try {
        if (!buf || buf.kind !== 'binary') { fail('No buffer for this arrow file.'); return; }
        const want = Math.min(buf.size, MAX_ARROW_BYTES);
        const ab = await createRemoteAsyncBuffer(path, buf.size).slice(0, want);
        if (cancelled) return;
        const u8 = new Uint8Array(ab);
        const { tableFromIPC } = await import('apache-arrow');
        const table = tableFromIPC(u8);
        const columns = table.schema.fields.map((f) => f.name);
        const numRows = Math.min(Number(table.numRows), MAX_DATA_ROWS);
        const rows: unknown[][] = [];
        for (let r = 0; r < numRows; r++) {
          const row = table.get(r) as Record<string, unknown> | null;
          rows.push(columns.map((c) => row?.[c]));
        }
        ready({
          columns,
          rows,
          truncated: Number(table.numRows) > rows.length || want < buf.size,
          totalRows: Number(table.numRows),
          source: 'arrow',
        });
      } catch (err) {
        fail(String((err as Error)?.message ?? err));
      }
    }

    async function loadJsonLines(): Promise<void> {
      try {
        const size = buf!.kind === 'binary' ? buf!.size : (buf!.content.length);
        const { text, truncated } = buf!.kind === 'text'
          ? { text: buf!.content, truncated: false }
          : await readTextPrefix(path, size, MAX_JSONL_BYTES);
        if (cancelled) return;
        const lines = text.split('\n');
        // Drop the last line if we may have truncated mid-line.
        if (truncated && lines.length > 0) lines.pop();
        const rowObjs: Record<string, unknown>[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try { rowObjs.push(JSON.parse(line)); } catch { /* skip malformed */ }
          if (rowObjs.length >= MAX_DATA_ROWS) break;
        }
        // Derive columns from first 100 rows (sometimes fields differ across rows).
        const colSet = new Set<string>();
        for (let i = 0; i < Math.min(100, rowObjs.length); i++) {
          for (const k of Object.keys(rowObjs[i])) colSet.add(k);
        }
        const columns = [...colSet];
        const rows = rowObjs.map((r) => columns.map((c) => r[c]));
        ready({
          columns,
          rows,
          truncated: truncated || rowObjs.length >= MAX_DATA_ROWS,
          totalRows: rowObjs.length + (truncated ? 1 : 0),
          source: 'jsonl',
        });
      } catch (err) {
        fail(String((err as Error)?.message ?? err));
      }
    }

    if (kind === 'csv') {
      if (buf.kind === 'text') void loadCsvFromText(buf.content);
      else void loadCsvBinary();
    } else if (kind === 'data') {
      if (ext === 'parquet') void loadParquet();
      else if (ext === 'arrow' || ext === 'feather' || ext === 'ipc') void loadArrow();
      else if (ext === 'jsonl' || ext === 'ndjson') void loadJsonLines();
      else fail('Unsupported data format.');
    } else {
      fail('No grid renderer for this file type.');
    }

    return () => { cancelled = true; };
  }, [path, buf]);

  if (state.status === 'loading') {
    return (
      <div className="grid-loading">
        <Loader2 size={16} strokeWidth={2} className="spin" />
        Reading file…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="grid-error">
        <div className="grid-error__title">Couldn't render as a grid</div>
        <div className="grid-error__msg">{state.error}</div>
        <div className="grid-error__hint">Try the <b>Hex</b> or <b>Other…</b> view from the toolbar above.</div>
      </div>
    );
  }

  const { columns, rows, truncated, totalRows, source } = state.data;
  const numRows = rows.length;
  const naturalHeight = numRows * ROW_H;
  const compressed = naturalHeight > MAX_VIRTUAL_HEIGHT;
  // Always make the scrollable area at least as tall as the viewport so the
  // grid doesn't end mid-page when a file has only a handful of rows.
  const virtualHeight = compressed ? MAX_VIRTUAL_HEIGHT : Math.max(naturalHeight, viewportH);
  const visibleRowCount = Math.max(1, Math.ceil(viewportH / ROW_H));
  const maxScroll = Math.max(1, virtualHeight - viewportH);
  const maxTopRow = Math.max(0, numRows - visibleRowCount);
  const topRow = compressed ? Math.floor((scrollTop / maxScroll) * maxTopRow) : Math.floor(scrollTop / ROW_H);
  const firstRow = Math.max(0, topRow - OVERSCAN_ROWS);
  const lastRow = Math.min(numRows - 1, topRow + visibleRowCount + OVERSCAN_ROWS);
  // How many filler (empty) rows to draw beneath the data so the bottom of the
  // table doesn't show bare background when the dataset is short.
  const fillerStartRow = Math.max(numRows, firstRow);
  const fillerEndRow = compressed ? numRows - 1 : Math.max(numRows - 1, topRow + visibleRowCount + OVERSCAN_ROWS);

  const totalW = columns.length * COL_W + 80;
  // Stretch table to fill the viewport horizontally when columns are narrower
  // than the available width — otherwise the rows would visibly end mid-page.
  const rowW = Math.max(totalW, viewportW);
  const firstColIdx = Math.max(0, Math.floor(scrollLeft / COL_W) - 1);
  const lastColIdx = Math.min(columns.length - 1, Math.ceil((scrollLeft + viewportW) / COL_W) + 1);

  const renderedRows: React.ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const top = compressed ? (r - topRow) * ROW_H : r * ROW_H;
    const row = rows[r];
    const cells: React.ReactNode[] = [];
    for (let c = firstColIdx; c <= lastColIdx; c++) {
      cells.push(
        <div
          key={c}
          className="grid-cell"
          style={{ position: 'absolute', left: 80 + c * COL_W, width: COL_W, height: ROW_H, lineHeight: `${ROW_H}px` }}
          title={formatCell(row?.[c])}
        >
          {formatCell(row?.[c])}
        </div>,
      );
    }
    renderedRows.push(
      <div
        key={r}
        className={`grid-row ${r % 2 === 1 ? 'grid-row--zebra' : ''}`}
        style={{ position: 'absolute', top, height: ROW_H, left: 0, width: rowW }}
      >
        <div className="grid-rownum" style={{ position: 'absolute', left: 0, width: 80, height: ROW_H, lineHeight: `${ROW_H}px` }}>
          {r + 1}
        </div>
        {cells}
      </div>,
    );
  }
  // Empty zebra rows after the data, so the bottom of the visible viewport is
  // always covered by table-styled background (no awkward dead zone).
  for (let r = fillerStartRow; r <= fillerEndRow; r++) {
    const top = compressed ? (r - topRow) * ROW_H : r * ROW_H;
    if (top > viewportH + ROW_H * OVERSCAN_ROWS) break;
    renderedRows.push(
      <div
        key={`f${r}`}
        className={`grid-row grid-row--filler ${r % 2 === 1 ? 'grid-row--zebra' : ''}`}
        style={{ position: 'absolute', top, height: ROW_H, left: 0, width: rowW }}
        aria-hidden="true"
      />,
    );
  }

  return (
    <div className="grid-view">
      <div className="grid-view__head" style={{ width: Math.max(totalW, viewportW), transform: `translateX(${-scrollLeft}px)` }}>
        <div className="grid-rownum grid-rownum--head" style={{ position: 'absolute', left: 0, width: 80, height: HEADER_H, lineHeight: `${HEADER_H}px` }}>#</div>
        {columns.slice(firstColIdx, lastColIdx + 1).map((col, idx) => (
          <div
            key={firstColIdx + idx}
            className="grid-cell grid-cell--head"
            style={{ position: 'absolute', left: 80 + (firstColIdx + idx) * COL_W, width: COL_W, height: HEADER_H, lineHeight: `${HEADER_H}px` }}
            title={col}
          >
            {col}
          </div>
        ))}
      </div>
      <div
        ref={setContainerRef}
        className="grid-view__scroll"
        onScroll={(e) => {
          const el = e.target as HTMLDivElement;
          setScrollTop(el.scrollTop);
          setScrollLeft(el.scrollLeft);
        }}
      >
        <div
          className="grid-view__spacer"
          style={{ height: virtualHeight, width: Math.max(totalW, viewportW), position: 'relative' }}
        >
          {compressed ? (
            <div className="grid-view__sticky" style={{ position: 'sticky', top: 0, height: viewportH, overflow: 'hidden' }}>
              {renderedRows}
            </div>
          ) : (
            renderedRows
          )}
        </div>
      </div>
      <div className="grid-view__foot">
        {source.toUpperCase()} · {numRows.toLocaleString()} of {totalRows.toLocaleString()} rows{truncated ? ' · truncated' : ''} · {columns.length} columns
      </div>
    </div>
  );
}
