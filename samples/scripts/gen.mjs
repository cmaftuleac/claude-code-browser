#!/usr/bin/env node
/**
 * Regenerates the binary fixture files under samples/.
 * Run from anywhere:  node samples/scripts/gen.mjs
 *
 * Pure Node — no npm install required. Each generator is self-contained;
 * one failure does not abort the others.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // → samples/

function out(rel) {
  const full = join(ROOT, rel);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

function write(rel, buf, label) {
  const full = out(rel);
  writeFileSync(full, buf);
  console.log(`  ✓ ${label.padEnd(28)} ${rel}  (${buf.length} B)`);
}

function safe(label, fn) {
  try { fn(); }
  catch (err) { console.warn(`  ✗ ${label.padEnd(28)} skipped: ${err.message}`); }
}

// ── PNG ───────────────────────────────────────────────────────────────
// Hand-rolled tiny PNG encoder so we don't need a deps install.
function crc32(buf) {
  let c, crcTable = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA pixel grid as PNG (8-bit, color type 6). */
function encodePng(width, height, rgbaPixels /* Uint8Array length = w*h*4 */) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 6;        // color type RGBA
  ihdr[10] = 0;       // compression
  ihdr[11] = 0;       // filter
  ihdr[12] = 0;       // interlace
  const ihdrChunk = pngChunk('IHDR', ihdr);

  // Add filter byte (0) at the start of each scanline.
  const rowBytes = width * 4;
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (rowBytes + 1)] = 0;
    filtered.set(rgbaPixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const idatRaw = deflateRawSync(filtered, { level: 9 });
  // PNG zlib stream needs a zlib header; we used raw deflate, so wrap it.
  // Easier: use zlib.deflate (with header). But we want 'zlib' format = deflate with adler32.
  // Use zlib.deflateSync which gives a zlib-wrapped stream.
  const { deflateSync } = require('node:zlib');
  const idatData = deflateSync(filtered);
  const idatChunk = pngChunk('IDAT', idatData);
  const iendChunk = pngChunk('IEND', Buffer.alloc(0));
  void idatRaw; // not used; keep for clarity
  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}
// require() is available because gen.mjs is run as an ES module that loads
// CommonJS via `createRequire`. Set it up at top:
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── PNG: 64×48 horizontal gradient ────────────────────────────────────
safe('PNG gradient', () => {
  const w = 64, h = 48;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i + 0] = Math.round((x / (w - 1)) * 217);              // R
      px[i + 1] = Math.round((y / (h - 1)) * 119) + 80;          // G
      px[i + 2] = 87;                                            // B (warm coral background-ish)
      px[i + 3] = 255;                                           // A
    }
  }
  const buf = encodePng(w, h, px);
  write('media/images/gradient.png', buf, 'PNG');
});

// ── PNG: 128×128 checkerboard ─────────────────────────────────────────
safe('PNG checkerboard', () => {
  const w = 128, h = 128, cell = 16;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dark = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0;
      const i = (y * w + x) * 4;
      px[i + 0] = dark ? 42 : 241;
      px[i + 1] = dark ? 33 : 234;
      px[i + 2] = dark ? 24 : 220;
      px[i + 3] = 255;
    }
  }
  write('media/images/checkerboard.png', encodePng(w, h, px), 'PNG');
});

// ── WAV: 1 second 440 Hz sine wave, 22.05 kHz, mono, 16-bit ───────────
safe('WAV sine', () => {
  const sampleRate = 22050;
  const seconds = 1;
  const freq = 440;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;       // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  // fmt chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);               // chunk size
  buf.writeUInt16LE(1, 20);                // PCM
  buf.writeUInt16LE(1, 22);                // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);   // byte rate
  buf.writeUInt16LE(2, 32);                // block align
  buf.writeUInt16LE(16, 34);               // bits per sample
  // data chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  // Envelope so it doesn't click on start/end.
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 50) * Math.min(1, (seconds - t) * 50);
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * env * 0.3 * 32767);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  write('media/audio/sine-440hz.wav', buf, 'WAV');
});

// ── PDF: minimal valid one-page "Hello, PDF" ──────────────────────────
safe('PDF hello', () => {
  const objects = [];
  // 1. Catalog
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  // 2. Pages
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  // 3. Page
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  // 4. Content stream
  const stream = 'BT /F1 36 Tf 90 700 Td (Hello, PDF) Tj ET\nBT /F1 16 Tf 90 660 Td (This is a tiny one-page sample.) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  // 5. Font
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let body = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  write('documents/hello.pdf', Buffer.from(body, 'binary'), 'PDF');
});

// ── ICO: 16×16 coral square (good for testing image kind with .ico) ───
safe('ICO icon', () => {
  const size = 16;
  const numPixels = size * size;
  const dibHeaderSize = 40;
  const imageDataSize = numPixels * 4 + (size * size / 8); // pixels + AND mask

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);             // reserved
  header.writeUInt16LE(1, 2);             // type 1 = ICO
  header.writeUInt16LE(1, 4);             // 1 image

  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(size, 0);
  dirEntry.writeUInt8(size, 1);
  dirEntry.writeUInt8(0, 2);              // color palette
  dirEntry.writeUInt8(0, 3);              // reserved
  dirEntry.writeUInt16LE(1, 4);           // color planes
  dirEntry.writeUInt16LE(32, 6);          // bits per pixel
  dirEntry.writeUInt32LE(dibHeaderSize + imageDataSize, 8); // image size
  dirEntry.writeUInt32LE(6 + 16, 12);     // offset to image data

  const bmp = Buffer.alloc(dibHeaderSize + imageDataSize);
  bmp.writeUInt32LE(dibHeaderSize, 0);
  bmp.writeInt32LE(size, 4);
  bmp.writeInt32LE(size * 2, 8);          // height = 2× because of AND mask
  bmp.writeUInt16LE(1, 12);
  bmp.writeUInt16LE(32, 14);
  // remaining DIB fields default 0 — fine for BI_RGB

  // BGRA pixel data, bottom-up.
  let p = dibHeaderSize;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bmp[p++] = 87;   // B
      bmp[p++] = 119;  // G
      bmp[p++] = 217;  // R — coral #d97757
      bmp[p++] = 255;  // A
    }
  }
  // AND mask zero-filled (all opaque) is already correct.
  write('media/images/coral.ico', Buffer.concat([header, dirEntry, bmp]), 'ICO');
});

// ── Apache Arrow IPC file (optional — needs apache-arrow installed) ───
safe('Arrow table', () => {
  const arrowMod = require('apache-arrow');
  const { tableFromArrays, tableToIPC } = arrowMod;
  const table = tableFromArrays({
    id: Int32Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    label: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
    value: Float64Array.from([1.5, 2.5, 3.0, 4.25, 5.5, 6.125, 7.0, 8.75]),
  });
  const u8 = tableToIPC(table, 'file');
  write('data/sample.arrow', Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength), 'Arrow');
});

// ── Unknown extension: a tiny binary blob ─────────────────────────────
safe('Unknown blob', () => {
  const buf = Buffer.alloc(256);
  for (let i = 0; i < buf.length; i++) buf[i] = i;
  // Add some text in the middle so the hex view shows ASCII on the right side.
  buf.write('MYSTERY-FORMAT-v1', 64, 'ascii');
  write('unknown/mystery.xyz', buf, 'Unknown');
});

// ── Placeholder for video folder ──────────────────────────────────────
safe('Video readme', () => {
  const txt = `Drop your own video files here (mp4, webm, mov, mkv, avi…).
This folder is intentionally not pre-populated — we don't have a tiny
synthesizable video generator in pure Node, and shipping a real video
would bloat the repo. The VideoView in apps/desktop handles HTTP Range
seeking so even multi-GB files play instantly.
`;
  write('media/video/README.txt', Buffer.from(txt, 'utf8'), 'Video README');
});

console.log('\nDone.');
