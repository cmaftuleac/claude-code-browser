import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/media-url';

/**
 * Image viewer with macOS-standard gestures:
 *  - Auto-fits to the viewport (preserves aspect ratio).
 *  - Trackpad pinch-to-zoom (Chromium reports it as wheel with ctrlKey).
 *  - Cmd/Ctrl + scroll wheel = zoom (mouse users).
 *  - Two-finger pan when zoomed in (wheel without modifier shifts offset).
 *  - Drag to pan when zoomed in. Double-click = reset to fit.
 *  - Hover/click anywhere on the image samples the underlying pixel for the
 *    color picker readout (works at any zoom level).
 */
export function ImageView({ path }: { path: string }) {
  const url = mediaUrl(path);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [ready, setReady] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [hoverRGB, setHoverRGB] = useState<{ r: number; g: number; b: number; a: number } | null>(null);
  const [hoverXY, setHoverXY] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);

  // Zoom is RELATIVE to the fit-to-stage scale: 1 = fit. Offsets are in CSS
  // pixels and only apply when zoomed in past fit.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; offX: number; offY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Compute the natural fit-to-stage scale (so a 4000px image fits in the panel).
  const fitScale = naturalSize && stageSize.w > 0 && stageSize.h > 0
    ? Math.min(stageSize.w / naturalSize.w, stageSize.h / naturalSize.h, 1)
    : 1;
  const effectiveScale = fitScale * scale;
  const displayW = naturalSize ? naturalSize.w * effectiveScale : 0;
  const displayH = naturalSize ? naturalSize.h * effectiveScale : 0;

  // Reset zoom + offsets whenever a new file is opened.
  useEffect(() => {
    setReady(false); setNaturalSize(null); setHoverRGB(null); setHoverXY(null);
    setScale(1); setOffset({ x: 0, y: 0 });
  }, [path]);

  // Track stage size for fit calculation + clamping the pan offset.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoad = (): void => {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    const cvs = canvasRef.current;
    if (!cvs) return;
    cvs.width = img.naturalWidth;
    cvs.height = img.naturalHeight;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    try { ctx.drawImage(img, 0, 0); setReady(true); }
    catch { setReady(false); }
  };

  const sampleAt = useCallback((clientX: number, clientY: number): void => {
    const img = imgRef.current;
    const cvs = canvasRef.current;
    if (!img || !cvs || !ready) return;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const relX = (clientX - rect.left) / rect.width;
    const relY = (clientY - rect.top) / rect.height;
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;
    const px = Math.min(cvs.width - 1, Math.max(0, Math.floor(relX * cvs.width)));
    const py = Math.min(cvs.height - 1, Math.max(0, Math.floor(relY * cvs.height)));
    try {
      const ctx = cvs.getContext('2d');
      if (!ctx) return;
      const d = ctx.getImageData(px, py, 1, 1).data;
      setHoverRGB({ r: d[0], g: d[1], b: d[2], a: d[3] });
      setHoverXY({ x: px, y: py });
    } catch { /* ignore */ }
  }, [ready]);

  // Wheel handler attached natively so we can preventDefault (React 17+ marks
  // synthetic wheel listeners as passive). Pinch-to-zoom on a Mac trackpad
  // arrives here as wheel with ctrlKey=true.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const zoomIntent = e.ctrlKey || e.metaKey;
      if (zoomIntent) {
        e.preventDefault();
        // Zoom anchored on the pointer position.
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left - rect.width / 2;
        const cy = e.clientY - rect.top - rect.height / 2;
        // deltaY > 0 → pinch close / scroll down → zoom out.
        const factor = Math.exp(-e.deltaY * 0.01);
        setScale((prev) => {
          const next = Math.max(1, Math.min(40, prev * factor));
          // Adjust offset so the cursor stays over the same image pixel.
          setOffset((o) => ({
            x: o.x - (cx - o.x) * (next / prev - 1),
            y: o.y - (cy - o.y) * (next / prev - 1),
          }));
          return next;
        });
      } else if (scale > 1) {
        // Pan with trackpad two-finger scroll when zoomed in.
        e.preventDefault();
        setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [scale]);

  // Clamp offset so the image stays roughly in view when zoomed.
  useEffect(() => {
    if (!naturalSize) return;
    const maxX = Math.max(0, (displayW - stageSize.w) / 2);
    const maxY = Math.max(0, (displayH - stageSize.h) / 2);
    setOffset((o) => ({
      x: Math.max(-maxX, Math.min(maxX, o.x)),
      y: Math.max(-maxY, Math.min(maxY, o.y)),
    }));
  }, [scale, naturalSize, displayW, displayH, stageSize.w, stageSize.h]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (scale <= 1) return;
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, offX: offset.x, offY: offset.y };
    e.preventDefault();
  };
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragging && dragRef.current) {
      const dr = dragRef.current;
      setOffset({ x: dr.offX + (e.clientX - dr.startX), y: dr.offY + (e.clientY - dr.startY) });
    } else {
      sampleAt(e.clientX, e.clientY);
    }
  };
  const onMouseUp = () => { setDragging(false); dragRef.current = null; };

  const onClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    // Suppress click-to-pick if this click was the end of a pan drag.
    if (dragRef.current) return;
    sampleAt(e.clientX, e.clientY);
    if (hoverRGB) {
      const hex = `#${hoverRGB.r.toString(16).padStart(2, '0')}${hoverRGB.g.toString(16).padStart(2, '0')}${hoverRGB.b.toString(16).padStart(2, '0')}`.toUpperCase();
      try { await navigator.clipboard.writeText(hex); setCopied(true); setTimeout(() => setCopied(false), 1100); }
      catch { /* clipboard may be blocked */ }
    }
  }, [hoverRGB, sampleAt]);

  const onDoubleClick = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  const hex = hoverRGB
    ? `#${hoverRGB.r.toString(16).padStart(2, '0')}${hoverRGB.g.toString(16).padStart(2, '0')}${hoverRGB.b.toString(16).padStart(2, '0')}`.toUpperCase()
    : '';

  const cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'crosshair';
  const zoomPct = Math.round(scale * 100);

  return (
    <div className="image-view">
      <div
        ref={stageRef}
        className="image-view__stage"
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { setHoverRGB(null); setDragging(false); }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        style={{ cursor }}
      >
        <img
          ref={imgRef}
          src={url}
          alt={path.split('/').pop()}
          className="image-view__img"
          crossOrigin="anonymous"
          draggable={false}
          onLoad={onLoad}
          style={{
            width: displayW || 'auto',
            height: displayH || 'auto',
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            transition: dragging ? 'none' : 'transform 60ms linear',
            imageRendering: scale > 4 ? 'pixelated' : 'auto',
          }}
        />
      </div>
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <div className="image-view__overlay">
        <div className="image-view__badge">
          {naturalSize ? `${naturalSize.w} × ${naturalSize.h} · ${zoomPct}%` : 'loading…'}
        </div>
        {hoverRGB && (
          <div className="image-view__picker">
            <div className="image-view__swatch" style={{ background: `rgb(${hoverRGB.r}, ${hoverRGB.g}, ${hoverRGB.b})` }} />
            <div className="image-view__readout">
              <div className="image-view__hex">{hex}{copied && <span className="image-view__copied"> · copied</span>}</div>
              <div className="image-view__rgb">rgb({hoverRGB.r}, {hoverRGB.g}, {hoverRGB.b})</div>
              {hoverXY && <div className="image-view__xy">({hoverXY.x}, {hoverXY.y})</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
