import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { pdfjs } from '../lib/pdf-setup';
import { mediaUrl } from '../lib/media-url';

/** PDF viewer: pdf.js renders each page to a `<canvas>`. Pages render lazily
 *  via IntersectionObserver — only those near the viewport get drawn, so a
 *  500-page PDF doesn't melt the CPU on open. */
export function PdfView({ path }: { path: string }) {
  const url = mediaUrl(path);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<Array<{ width: number; height: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pdfDoc, setPdfDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null);

  // Open document — get page count + intrinsic page sizes for layout.
  useEffect(() => {
    let cancelled = false;
    setPages([]); setError(null); setPdfDoc(null);
    (async () => {
      try {
        const doc = await pdfjs.getDocument({ url, disableRange: false }).promise;
        if (cancelled) { void doc.destroy(); return; }
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
    return () => { cancelled = true; };
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
    <div className="pdf-view" ref={containerRef}>
      <div className="pdf-view__inner">
        {pages.map((p, i) => (
          <PdfPage key={i} pdfDoc={pdfDoc} pageIndex={i} width={p.width} height={p.height} />
        ))}
      </div>
      <div className="pdf-view__foot">{pages.length} page{pages.length === 1 ? '' : 's'}</div>
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
    <div className="pdf-view__page" style={{ aspectRatio: `${width} / ${height}` }}>
      <canvas ref={ref} className="pdf-view__canvas" />
      {!rendered && <div className="pdf-view__page-label">Page {pageIndex + 1}</div>}
      {/* prevent unused var */}
      <span style={{ display: 'none' }}>{ratio}</span>
    </div>
  );
}
