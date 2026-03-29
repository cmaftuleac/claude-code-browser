import React, { useState, useRef } from 'react';
import { useChatStore } from '../stores/chat-store';
import type { QueuedMessage } from '../stores/chat-store';

export function MessageQueue() {
  const messageQueue = useChatStore((s) => s.messageQueue);
  const removeFromQueue = useChatStore((s) => s.removeFromQueue);
  const updateQueueItem = useChatStore((s) => s.updateQueueItem);
  const reorderQueue = useChatStore((s) => s.reorderQueue);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (messageQueue.length === 0) return null;

  const handleDragStart = (index: number) => {
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragIndex !== null && dragIndex !== index) {
      reorderQueue(dragIndex, index);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="message-queue">
      {messageQueue.map((item, index) => (
        <QueueItem
          key={item.id}
          item={item}
          index={index}
          isDragging={dragIndex === index}
          isDragOver={dragOverIndex === index}
          onRemove={() => removeFromQueue(item.id)}
          onUpdate={(content) => updateQueueItem(item.id, content)}
          onDragStart={() => handleDragStart(index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDrop={() => handleDrop(index)}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
  );
}

interface QueueItemProps {
  item: QueuedMessage;
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  onRemove: () => void;
  onUpdate: (content: string) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

function QueueItem({
  item, isDragging, isDragOver,
  onRemove, onUpdate,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: QueueItemProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const saveEdit = () => {
    const value = inputRef.current?.value.trim();
    if (value) {
      onUpdate(value);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { setEditing(false); }
  };

  const className = [
    'message-queue__item',
    isDragging && 'message-queue__item--dragging',
    isDragOver && 'message-queue__item--drag-over',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className="message-queue__drag-handle">{'\u2630'}</span>

      {editing ? (
        <input
          ref={inputRef}
          className="message-queue__edit-input"
          defaultValue={item.content}
          onBlur={saveEdit}
          onKeyDown={handleEditKeyDown}
        />
      ) : (
        <span className="message-queue__preview" title={item.content}>
          {item.content}
        </span>
      )}

      <button className="message-queue__btn" onClick={startEdit} title="Edit">
        {'\u270E'}
      </button>
      <button className="message-queue__btn message-queue__btn--remove" onClick={onRemove} title="Remove">
        {'\u2715'}
      </button>
    </div>
  );
}
