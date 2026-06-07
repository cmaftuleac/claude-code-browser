import { useEffect, useRef, useState } from 'react';
import { Loader2, Hash } from 'lucide-react';
import { pdfjs } from '../lib/pdf-setup';
import { mediaUrl } from '../lib/media-url';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useFileContextMenu, copyText } from '../hooks/useFileContextMenu';
import type { CtxItem } from './ContextMenu';

/** PDF viewer: pdf.js renders each page to a `<canvas>`. Pages render lazily
 *  via IntersectionObserver — only those near the viewport get drawn, so a
 *  500-page PDF doesn't melt the CPU on open. */
export function PdfView({ path }: { path: string }) {
  const rev = useWorkspaceStore((s) => s.fileRevs[path] ?? 0);
  const url = mediaUrl(path, rev);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<Array<{ width: number; height: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  const { open, menu } = useFileContextMenu(path);

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const extras: CtxItem[] = [];
    const pageEl = (e.target as Element | null)?.closest('.pdf-view__page') as HTMLElement | null;
    const pg = pageEl?.dataset.page;
    if (pg != null) {
      extras.push({ kind: 'item', label: `Copy Page Number (${pg})`, icon: <Hash size={13} strokeWidth={1.75} />, onActivate: () => copyText(pg) });
    }
    open(e, extras);
  };

  // Open document — get page count + intrinsic page sizes for layout.
  useEffect(() => {
    let cancelled = false;
    let activeDoc: { destroy: () => Promise<void> } | null = null;
    setPages([]); setError(null); setPdfDoc(null);
    (async () => {
      try {
        const doc = await pdfjs.getDocument({ url, disableRange: false }).promise;
        if (cancelled) { void doc.destroy(); return; }
        activeDoc = doc;
        const sizes: Array<{ width: number; height: number }> = [];
        const max = Math.min(doc.numPages, 1000);
        for (let i = 1; i <= max; i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
          // Eagerly release the page reference; we'll re-fetch when rendering.
        }
        if (cancelled) { void doc.destroy(); return; }
        setPdfDoc(doc);
        setPages(sizes);
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message ?? err));
      }
    })();
    // Destroy the loaded document on url change / unmount so pdf.js frees its
    // worker buffers and rendered page data instead of leaking until GC.
    return () => { cancelled = true; if (activeDoc) void activeDoc.destroy(); };
  }, [url]);

  if (error) {
    return (
      <div className="pdf-view__error">
        <div className="pdf-view__error-title">Couldn't render PDF</div>
        <div className="pdf-view__error-msg">{error}</div>
      </div>
    );
  }
  if (!pdfDoc || pages.length === 0) {
    return <div className="pdf-view__loading"><Loader2 size={16} strokeWidth={2} className="spin" /> Reading PDF…</div>;
  }

  return (
    <div className="pdf-view" ref={containerRef} onContextMenu={onContextMenu}>
      <div className="pdf-view__inner">
        {pages.map((p, i) => (
          <PdfPage key={i} pdfDoc={pdfDoc} pageIndex={i} width={p.width} height={p.height} />
        ))}
      </div>
      <div className="pdf-view__foot">{pages.length} page{pages.length === 1 ? '' : 's'}</div>
      {menu}
    </div>
  );
}

const RENDER_SCALE = 1.5;

function PdfPage({
  pdfDoc, pageIndex, width, height,
}: {
  pdfDoc: import('pdfjs-dist').PDFDocumentProxy;
  pageIndex: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);

  // Track viewport visibility so we only render when nearby.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) { setVisible(true); io.disconnect(); return; }
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || rendered) return;
    let cancelled = false;
    let renderTask: import('pdfjs-dist').RenderTask | null = null;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageIndex + 1);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = ref.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        renderTask = page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]);
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch {
        // Page failed to render — leave the placeholder visible.
      }
    })();
    return () => { cancelled = true; try { renderTask?.cancel(); } catch { /* ignore */ } };
  }, [visible, rendered, pdfDoc, pageIndex]);

  // Aspect ratio at scale=1; CSS scales to fit.
  const ratio = height / width;
  return (
    <div className="pdf-view__page" style={{ aspectRatio: `${width} / ${height}` }} data-page={pageIndex + 1}>
      <canvas ref={ref} className="pdf-view__canvas" />
      {!rendered && <div className="pdf-view__page-label">Page {pageIndex + 1}</div>}
      {/* prevent unused var */}
      <span style={{ display: 'none' }}>{ratio}</span>
    </div>
  );
}
