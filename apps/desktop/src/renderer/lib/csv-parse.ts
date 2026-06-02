/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, embedded commas,
 * escaped quotes (""), CR/LF line endings. Auto-detects tab vs comma delimiter
 * from the first line. Caps row count for sanity.
 */
export interface ParsedCsv {
  columns: string[];
  rows: string[][];
  truncated: boolean;
  totalLines: number;
}

const MAX_ROWS = 50_000;

export function parseCsv(text: string, opts?: { maxRows?: number }): ParsedCsv {
  const maxRows = opts?.maxRows ?? MAX_ROWS;
  if (!text) return { columns: [], rows: [], truncated: false, totalLines: 0 };

  // Sniff delimiter from the first non-empty line.
  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delim = tabs > commas ? '\t' : ',';

  const all = parseLines(text, delim);
  const columns = all.shift() ?? [];
  const rows = all.length > maxRows ? all.slice(0, maxRows) : all;
  return { columns, rows, truncated: all.length > rows.length, totalLines: all.length + 1 };
}

function parseLines(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"' && cur.length === 0) {
        inQ = true;
      } else if (c === delim) {
        row.push(cur); cur = '';
      } else if (c === '\r') {
        // Skip — \n handles the row break.
      } else if (c === '\n') {
        row.push(cur); cur = '';
        out.push(row); row = [];
      } else {
        cur += c;
      }
    }
  }
  // Trailing field / row.
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    out.push(row);
  }
  return out;
}
