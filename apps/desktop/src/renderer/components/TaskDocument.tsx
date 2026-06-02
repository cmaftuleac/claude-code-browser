import { useEffect, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useTasksStore, EMPTY_BLOCKS } from '../stores/tasks-store';
import { MessageBlock } from './MessageBlock';

export function TaskDocument({ taskId }: { taskId: string }) {
  const blocks = useTasksStore((s) => s.tasks.find((t) => t.id === taskId)?.blocks ?? EMPTY_BLOCKS);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [blocks.length]);

  if (blocks.length === 0) {
    return (
      <div className="task-document">
        <div className="task-empty-doc">
          Start a task — ask Claude to read code, browse a page, or draft something.
        </div>
      </div>
    );
  }

  return (
    <div className="task-document">
      <div className="task-document__inner">
        <AnimatePresence initial={false}>
          {blocks.map((b) => <MessageBlock key={b.id} block={b} />)}
        </AnimatePresence>
        <div ref={endRef} />
      </div>
    </div>
  );
}
