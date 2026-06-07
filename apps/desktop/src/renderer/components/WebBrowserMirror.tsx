/**
 * Web-mode browser mirror.
 *
 * The page runs on a remote host (the cloud server, or a user's Electron
 * machine). We mirror it here and forward input:
 *  - PRIMARY: direct P2P WebRTC — the host publishes a video track straight to
 *    this client (media never touches the backend); rendered into <video>.
 *  - FALLBACK: JPEG frames over the single control WS, drawn onto <canvas>,
 *    used when WebRTC can't establish or the host has no publisher.
 *
 * The host tells us which transport to use via `browser:config`. Input (mouse/
 * wheel/keyboard) is always forwarded over the control WS's `browser` channel,
 * mapped from on-screen coords into the remote viewport.
 */
import { useEffect, useRef, useState } from 'react';
import type { BrowserInputEvent } from '@fineguide-tesseract/shared';

type Transport = 'frames' | 'webrtc';

// *** WS JPEG-frame fallback DISABLED FOR NOW. *** The mirror uses direct P2P
// WebRTC only. The fallback code (frame subscription + <canvas> rendering) is
// kept intact behind this flag — set it true (here AND in the server's
// WS_FRAME_FALLBACK in apps/server/src/index.ts) to re-enable the degraded path.
// Typed `boolean` (not the literal `false`) so the gated blocks aren't flagged
// as statically-unreachable.
const WS_FRAME_FALLBACK: boolean = false;

export function WebBrowserMirror({ browserId, url }: { browserId: string; url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ width: 1280, height: 800 });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  // Start on 'webrtc' so we never flash an empty fallback canvas while the
  // fallback is disabled.
  const [transport, setTransport] = useState<Transport>(WS_FRAME_FALLBACK ? 'frames' : 'webrtc');

  useEffect(() => {
    const ccb = window.ccb;
    let disposed = false;
    let iceResolve: ((servers: RTCIceServer[]) => void) | null = null;

    const send = (msg: unknown): void => ccb.browser.send(browserId, msg);

    // ── WebRTC (primary) ──────────────────────────────────────────────────
    const getIceServers = (): Promise<RTCIceServer[]> =>
      new Promise((resolve) => { iceResolve = resolve; ccb.signal.send(browserId, { type: 'signal:get-ice' }); });

    const startWebRTC = async (): Promise<void> => {
      if (pcRef.current) return;
      const iceServers = await getIceServers().catch(() => [] as RTCIceServer[]);
      if (disposed) return;
      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (e) => {
        const v = videoRef.current;
        if (v && e.streams[0]) { v.srcObject = e.streams[0]; void v.play().catch(() => {}); setTransport('webrtc'); }
      };
      pc.onicecandidate = (e) => { if (e.candidate) ccb.signal.send(browserId, { type: 'signal:ice', candidate: e.candidate.toJSON() }); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ccb.signal.send(browserId, { type: 'signal:offer', sdp: offer.sdp });
    };

    const offSignal = ccb.signal.on((msg, bid) => {
      if (bid && bid !== browserId) return;
      const m = msg as { type?: string; sdp?: string; candidate?: RTCIceCandidateInit; iceServers?: RTCIceServer[] };
      const pc = pcRef.current;
      if (m.type === 'signal:ready' && iceResolve) { iceResolve(m.iceServers ?? []); iceResolve = null; }
      else if (m.type === 'signal:answer' && pc && m.sdp) void pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      else if (m.type === 'signal:ice' && pc && m.candidate) void pc.addIceCandidate(m.candidate).catch(() => {});
    });

    // ── Frames (fallback) — DISABLED via WS_FRAME_FALLBACK ────────────────
    // Only subscribe to the binary frame stream when the fallback is enabled;
    // otherwise this is inert and the canvas below stays hidden.
    const offFrame = WS_FRAME_FALLBACK
      ? ccb.browser.onFrame((buf) => {
          const dv = new DataView(buf);
          const u8 = new Uint8Array(buf);
          const idLen = dv.getUint8(2);
          const id = new TextDecoder().decode(u8.subarray(3, 3 + idLen));
          if (id !== browserId) return;
          const payload = u8.subarray(3 + idLen + 4);
          void createImageBitmap(new Blob([payload], { type: 'image/jpeg' })).then((bmp) => {
            if (disposed) { bmp.close(); return; }
            const c = canvasRef.current;
            if (!c) { bmp.close(); return; }
            if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
            sizeRef.current = { width: bmp.width, height: bmp.height };
            c.getContext('2d')?.drawImage(bmp, 0, 0);
            bmp.close();
          }).catch(() => {});
        })
      : () => { /* fallback disabled — no frame subscription */ };

    // ── Control / config ──────────────────────────────────────────────────
    const offMsg = ccb.browser.on((msg, bid) => {
      if (bid && bid !== browserId) return;
      const m = msg as { type?: string; transport?: Transport; width?: number; height?: number };
      if (m.type === 'browser:config') {
        sizeRef.current = { width: m.width ?? 1280, height: m.height ?? 800 };
        // Fallback disabled → always negotiate WebRTC, even if a 'frames'
        // transport is advertised. Re-enabling honors the advertised transport.
        if (!WS_FRAME_FALLBACK || m.transport === 'webrtc') void startWebRTC();
        else setTransport('frames');
      }
    });

    // Begin mirroring this surface. Attach is once per browserId; URL changes are
    // driven by the separate nav effect below, so we don't tear down + reattach
    // the stream (and renegotiate WebRTC) on every navigation. (Review B10.)
    send({ type: 'browser:attach' });

    return () => {
      disposed = true;
      offFrame(); offMsg(); offSignal();
      if (pcRef.current) { try { pcRef.current.close(); } catch { /* ignore */ } pcRef.current = null; }
      send({ type: 'browser:detach' });
    };
  }, [browserId]);

  // Navigate the mirrored page when the bound URL changes (attach stays put).
  useEffect(() => {
    if (!url) return;
    window.ccb.browser.send(browserId, { type: 'browser:nav', action: 'goto', url });
  }, [browserId, url]);

  // ── Input forwarding (map on-screen → remote viewport coords) ────────────
  const toRemote = (clientX: number, clientY: number): { x: number; y: number } => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const rect = surface.getBoundingClientRect();
    const sx = sizeRef.current.width / Math.max(1, rect.width);
    const sy = sizeRef.current.height / Math.max(1, rect.height);
    return { x: Math.round((clientX - rect.left) * sx), y: Math.round((clientY - rect.top) * sy) };
  };
  const input = (event: BrowserInputEvent): void => window.ccb.browser.send(browserId, { type: 'browser:input', event });

  return (
    <div
      ref={surfaceRef}
      className="canvas__webview"
      tabIndex={0}
      style={{ position: 'relative', outline: 'none', overflow: 'hidden', background: '#fff', cursor: 'default' }}
      onMouseMove={(e) => { const p = toRemote(e.clientX, e.clientY); input({ kind: 'mouse', action: 'move', x: p.x, y: p.y, buttons: e.buttons }); }}
      onMouseDown={(e) => { const p = toRemote(e.clientX, e.clientY); input({ kind: 'mouse', action: 'down', x: p.x, y: p.y, button: e.button }); }}
      onMouseUp={(e) => { const p = toRemote(e.clientX, e.clientY); input({ kind: 'mouse', action: 'up', x: p.x, y: p.y, button: e.button }); }}
      onWheel={(e) => { const p = toRemote(e.clientX, e.clientY); input({ kind: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY }); }}
      onKeyDown={(e) => {
        // Printable char (no Ctrl/Meta/Alt) → send as text (robust for unicode/
        // shifted keys). Special keys (Enter, Backspace, arrows, …) → down/up.
        const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (printable) { e.preventDefault(); input({ kind: 'key', action: 'char', key: e.key, text: e.key }); return; }
        // Don't trap local shortcuts (devtools, copy/paste) — only suppress the
        // page-scrolling defaults of plain special keys.
        if (!e.metaKey && !e.ctrlKey) e.preventDefault();
        input({ kind: 'key', action: 'down', key: e.key, code: e.code });
      }}
      onKeyUp={(e) => {
        const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (!printable) input({ kind: 'key', action: 'up', key: e.key, code: e.code });
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: transport === 'webrtc' ? 'block' : 'none' }}
      />
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: transport === 'frames' ? 'block' : 'none' }}
      />
    </div>
  );
}
