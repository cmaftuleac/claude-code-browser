import { useCallback, useEffect, useRef, useState } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { useTasksStore } from '../stores/tasks-store';

/* ── Voice-mode conversation engine ─────────────────────────────────────────
 *
 * A hands-free, half-duplex voice loop layered on top of the normal agent send
 * flow. A *local Silero VAD* (@ricky0123/vad-web — ONNX in a WASM AudioWorklet,
 * assets self-hosted under /vad/) owns turn detection; the browser Web Speech
 * API does the actual speech-to-text and text-to-speech. Claude stays the brain,
 * reached through the existing tasks-store `send()` — no backend changes.
 *
 * Turn loop (state machine):
 *   listening ──VAD speechStart──▶ userSpeaking ──VAD speechEnd──▶ thinking
 *   thinking ──agent turn ends──▶ speaking (TTS) ──utterance end──▶ listening
 *   speaking ──VAD speechStart (barge-in)──▶ userSpeaking (cancel TTS)
 *
 * The VAD is the authority for *when* a turn starts/ends; SpeechRecognition is
 * started/stopped by the VAD and only supplies the transcript text.
 *
 * Params (positiveSpeechThreshold 0.5, ~800ms redemption/silence-hold,
 * minSpeech ~150ms) are ported from the voice_ai bridge's Silero config.
 *
 * STT caveat: webkitSpeechRecognition needs Google's Speech API key, which
 * Electron's Chromium does not ship — so STT typically only works in the web
 * build (real Chrome). speechSynthesis (TTS) works in both. When STT is
 * unavailable we surface `error` instead of failing silently. */

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'userSpeaking'
  | 'thinking'
  | 'speaking'
  | 'error';

/* Minimal Web Speech API typings — not in the default DOM lib. */
interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: Event) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/* Where the self-hosted VAD assets (worklet, silero_vad_v5.onnx) and the ORT
 * WASM live. Derived from Vite's BASE_URL so it resolves under both the web
 * build (served at "/") and the packaged Electron renderer (loaded over file://
 * with a relative "./" base). Always ends in "/". */
const VAD_BASE = `${import.meta.env.BASE_URL}vad/`;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceConversation {
  state: VoiceState;
  active: boolean;
  /** Live (interim) transcript of the current utterance, for display. */
  interim: string;
  /** Non-null when something went wrong (e.g. STT unavailable in Electron). */
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceConversation(taskId: string): VoiceConversation {
  const [state, setState] = useState<VoiceState>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Refs mirror state for use inside event callbacks (which close over stale state).
  const stateRef = useRef<VoiceState>('idle');
  const setVoiceState = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const vadRef = useRef<MicVAD | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recognizingRef = useRef(false);
  const utteranceRef = useRef(''); // final text accumulated for the current utterance
  const uttObjRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** assistant-block count captured at commit time, so we can detect the reply. */
  const replyBaselineRef = useRef(0);
  const awaitingReplyRef = useRef(false);

  /* ── Speech-to-text (Web Speech API) ─────────────────────────────────── */

  const startRecognition = useCallback(() => {
    const rec = recRef.current;
    if (!rec || recognizingRef.current) return;
    utteranceRef.current = '';
    setInterim('');
    try {
      rec.start();
      recognizingRef.current = true;
    } catch {
      /* start() throws if already started — ignore. */
    }
  }, []);

  const stopRecognition = useCallback(() => {
    const rec = recRef.current;
    if (!rec || !recognizingRef.current) return;
    try { rec.stop(); } catch { /* no-op */ }
  }, []);

  /* ── Text-to-speech (Web Speech API) ─────────────────────────────────── */

  const cancelSpeak = useCallback(() => {
    const u = uttObjRef.current;
    if (u) u.onend = null; // prevent the cancel from firing our end handler
    uttObjRef.current = null;
    try { window.speechSynthesis.cancel(); } catch { /* no-op */ }
  }, []);

  const speak = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) { setVoiceState('listening'); return; }
    cancelSpeak();
    setVoiceState('speaking');
    const utt = new SpeechSynthesisUtterance(clean);
    utt.onend = () => {
      if (uttObjRef.current !== utt) return; // superseded / cancelled
      uttObjRef.current = null;
      if (stateRef.current !== 'idle') setVoiceState('listening');
    };
    uttObjRef.current = utt;
    try { window.speechSynthesis.speak(utt); }
    catch { uttObjRef.current = null; setVoiceState('listening'); }
  }, [cancelSpeak, setVoiceState]);

  /* ── Send the committed transcript to Claude ──────────────────────────── */

  const send = useTasksStore((s) => s.send);

  const commit = useCallback((text: string) => {
    const msg = text.trim();
    if (!msg) { setVoiceState('listening'); return; }
    const blocks = useTasksStore.getState().tasks.find((t) => t.id === taskId)?.blocks ?? [];
    replyBaselineRef.current = blocks.filter((b) => b.kind === 'assistant').length;
    awaitingReplyRef.current = true;
    setInterim('');
    setVoiceState('thinking');
    send({ taskId, message: msg });
  }, [send, taskId, setVoiceState]);

  /* When the agent turn finishes, speak the new assistant reply. We watch only
   * the task's `running` flag (true→false) and read the blocks on the transition
   * via getState() — selecting the (always-new) filtered array here would
   * re-render the composer on every store update. */
  const running = useTasksStore((s) => s.tasks.find((t) => t.id === taskId)?.running ?? false);
  const prevRunningRef = useRef(running);

  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;
    if (stateRef.current === 'idle') return;
    if (!awaitingReplyRef.current) return;
    if (wasRunning && !running) {
      const blocks = useTasksStore.getState().tasks.find((t) => t.id === taskId)?.blocks ?? [];
      const assistant = blocks.filter((b) => b.kind === 'assistant');
      // Turn finished and a new assistant block landed since we sent.
      if (assistant.length > replyBaselineRef.current) {
        awaitingReplyRef.current = false;
        const last = assistant[assistant.length - 1];
        speak(last && last.kind === 'assistant' ? last.content : '');
      }
    }
  }, [running, taskId, speak]);

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  const teardown = useCallback(() => {
    awaitingReplyRef.current = false;
    recognizingRef.current = false;
    const rec = recRef.current;
    if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; try { rec.abort(); } catch { /* */ } }
    recRef.current = null;
    cancelSpeak();
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) { void vad.destroy(); }
  }, [cancelSpeak]);

  const stop = useCallback(() => {
    teardown();
    setInterim('');
    setVoiceState('idle');
  }, [teardown, setVoiceState]);

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    setError(null);

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Speech recognition is unavailable in this app (try the browser build).');
      setVoiceState('error');
      return;
    }

    // Speech-to-text — VAD drives start/stop; we only collect the transcript.
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0]?.transcript ?? '';
        if (r.isFinal) utteranceRef.current += txt;
        else interimText += txt;
      }
      setInterim(interimText);
    };
    rec.onend = () => {
      recognizingRef.current = false;
      if (stateRef.current === 'idle') return;
      // Recognition ended (we stopped it on VAD speech-end). Commit if we got text.
      if (utteranceRef.current.trim()) commit(utteranceRef.current);
      else if (stateRef.current === 'userSpeaking') setVoiceState('listening');
    };
    rec.onerror = () => { recognizingRef.current = false; };
    recRef.current = rec;

    // Local Silero VAD — the turn/endpoint detector (+ barge-in).
    try {
      const vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: VAD_BASE,
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        redemptionMs: 800,   // silence held before a turn is considered over
        minSpeechMs: 150,    // ignore sub-150ms blips (misfire)
        preSpeechPadMs: 300,
        getStream: () => navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
        onSpeechStart: () => {
          const s = stateRef.current;
          if (s === 'speaking') cancelSpeak(); // barge-in over Claude's voice
          if (s === 'listening' || s === 'speaking') {
            setVoiceState('userSpeaking');
            startRecognition();
          }
        },
        onSpeechEnd: () => {
          if (stateRef.current === 'userSpeaking') stopRecognition();
        },
        onVADMisfire: () => {
          if (stateRef.current === 'userSpeaking') { stopRecognition(); setVoiceState('listening'); }
        },
      });
      if (recRef.current !== rec) { void vad.destroy(); return; } // stopped during init
      vadRef.current = vad;
      vad.start();
      setVoiceState('listening');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not access the microphone.');
      teardown();
      setVoiceState('error');
    }
  }, [cancelSpeak, commit, setVoiceState, startRecognition, stopRecognition, teardown]);

  // Tear everything down if the component using the hook unmounts.
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    active: state !== 'idle' && state !== 'error',
    interim,
    error,
    start,
    stop,
  };
}
