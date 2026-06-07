import { motion } from 'framer-motion';
import { ShieldQuestion, Check, Ban, ShieldCheck } from 'lucide-react';
import { useTasksStore, type Block } from '../stores/tasks-store';

const ANIM = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };

type PermissionBlock = Extract<Block, { kind: 'permission' }>;

/** Pull the most human-relevant line out of a tool's input for display (the
 *  Bash command, the file path, …) — falls back to compact JSON. */
function describeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'plan', 'file_path', 'path', 'pattern', 'url']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  try {
    const json = JSON.stringify(input);
    return json && json !== '{}' ? json : '';
  } catch {
    return '';
  }
}

/** In-chat tool-approval card — shown when the agent's canUseTool callback asks
 *  the user to approve a gated tool (Ask / Edit-automatically-for-commands / Plan
 *  / Auto). Interactive until `decided`. */
export function PermissionRequestCard({ block, taskId }: { block: PermissionBlock; taskId: string }) {
  const respond = useTasksStore((s) => s.respondPermission);
  const decided = block.decided;
  const headline = block.title || `Allow ${block.displayName || block.toolName}?`;
  const detail = describeInput(block.input);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={ANIM}
      className={`perm-card ${decided ? 'perm-card--decided' : ''}`}
    >
      <div className="perm-card__head">
        <span className="perm-card__icon">
          {decided === 'allow' ? <ShieldCheck size={14} strokeWidth={1.9} />
            : decided === 'deny' ? <Ban size={14} strokeWidth={1.9} />
            : <ShieldQuestion size={14} strokeWidth={1.9} />}
        </span>
        <span className="perm-card__title">{headline}</span>
      </div>

      {block.description && <div className="perm-card__desc">{block.description}</div>}
      {detail && <pre className="perm-card__detail">{detail}</pre>}

      {!decided ? (
        <div className="perm-card__actions">
          <button
            className="perm-card__btn perm-card__btn--allow"
            onClick={() => respond(taskId, block.requestId, { behavior: 'allow' })}
          >
            <Check size={13} strokeWidth={2.25} /> Allow
          </button>
          <button
            className="perm-card__btn"
            onClick={() => respond(taskId, block.requestId, { behavior: 'allow', persist: true })}
          >
            Allow &amp; don&apos;t ask again
          </button>
          <button
            className="perm-card__btn perm-card__btn--deny"
            onClick={() => respond(taskId, block.requestId, { behavior: 'deny' })}
          >
            <Ban size={13} strokeWidth={2.25} /> Deny
          </button>
        </div>
      ) : (
        <div className="perm-card__resolved">
          {decided === 'allow' ? 'Allowed' : decided === 'deny' ? 'Denied' : 'No longer needed'}
        </div>
      )}
    </motion.div>
  );
}
