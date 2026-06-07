import { motion } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import type { VoiceState } from '../hooks/useVoiceConversation';

const ANIM = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

const LABELS: Record<VoiceState, string> = {
  idle: '',
  listening: 'Listening…',
  userSpeaking: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Voice unavailable',
};

/** The animated "orb" — three concentric pulsing rings whose tempo reflects the
 *  conversation state. A lightweight take on fineguide's VoiceOrb. */
function Orb({ state }: { state: VoiceState }) {
  const speaking = state === 'speaking';
  const hearing = state === 'listening' || state === 'userSpeaking';
  const active = state === 'userSpeaking';
  return (
    <div className="voice-orb" data-state={state}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="voice-orb__ring"
          animate={
            speaking
              ? { scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }
              : hearing
                ? { scale: [1, active ? 1.4 : 1.2, 1], opacity: [0.45, 0.1, 0.45] }
                : { scale: 1, opacity: 0.3 }
          }
          transition={{
            duration: speaking ? 1.1 : 1.6,
            ease: 'easeInOut',
            repeat: Infinity,
            delay: i * 0.22,
          }}
        />
      ))}
      <span className="voice-orb__core" />
    </div>
  );
}

/** Inline status strip shown above the composer while a voice conversation is
 *  active. Ending the call is done with the composer's own voice button (its
 *  pressed state), so this panel carries no hangup control of its own. */
export function VoicePanel({
  state,
  interim,
  error,
}: {
  state: VoiceState;
  interim: string;
  error: string | null;
}) {
  const isError = state === 'error';
  return (
    <motion.div
      className="voice-panel"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={ANIM}
    >
      <div className="voice-panel__inner">
        {isError ? (
          <AlertCircle size={18} strokeWidth={2} className="voice-panel__err-icon" />
        ) : (
          <Orb state={state} />
        )}
        <div className="voice-panel__body">
          <span className="voice-panel__label">{LABELS[state]}</span>
          {isError ? (
            <span className="voice-panel__sub">{error}</span>
          ) : (
            interim && <span className="voice-panel__sub">{interim}</span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
