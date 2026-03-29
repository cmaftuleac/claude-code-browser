import React, { useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import type { QueuedMessage } from '../stores/chat-store';

export function MessageQueue() {
  const messageQueue = useChatStore((s) => s.messageQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const reorderQueue = useChatStore((s) => s.reorderQueue);
  const setEditingQueueId = useChatStore((s) => s.setEditingQueueId);
  const editingQueueId = useChatStore((s) => s.editingQueueId);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (messageQueue.length === 0) return null;

  const handleDragStart = (index: number) => setDragIndex(index);
  const handleDragOver = (e: React.DragEvent, index: number) => { e.preventDefault(); setDragOverIndex(index); };
  const handleDrop = (index: number) => {
    if (dragIndex !== null && dragIndex !== index) reorderQueue(dragIndex, index);
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const handleDragEnd = () => { setDragIndex(null); setDragOverIndex(null); };

  const handleEdit = (item: QueuedMessage) => {
    // Set editing state — ChatInput listens and fills the editor
    setEditingQueueId(item.id);
  };

  return (
    <div className="message-queue">
      {messageQueue.map((item, index) => (
        <div
          key={item.id}
          className={[
            'message-queue__item',
            dragIndex === index && 'message-queue__item--dragging',
            dragOverIndex === index && 'message-queue__item--drag-over',
            editingQueueId === item.id && 'message-queue__item--editing',
          ].filter(Boolean).join(' ')}
          draggable
          onDragStart={() => handleDragStart(index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDrop={() => handleDrop(index)}
          onDragEnd={handleDragEnd}
        >
          <span className="message-queue__drag-handle">{'\u2630'}</span>
          <span className="message-queue__preview" title={item.content}>
            {item.content}
          </span>
          <button className="message-queue__btn" onClick={() => handleEdit(item)} title="Edit">
            {'\u270E'}
          </button>
          <button className="message-queue__btn message-queue__btn--remove" onClick={() => removeFromQueue(item.id)} title="Remove">
            {'\u2715'}
          </button>
        </div>
      ))}
    </div>
  );
}
