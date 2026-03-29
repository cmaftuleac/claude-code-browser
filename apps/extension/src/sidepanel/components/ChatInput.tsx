import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { ClientMessage, ElementAnchor } from '@claude-code-browser/shared';
import { useChatStore } from '../stores/chat-store';
import { useElementPicker } from '../hooks/useElementPicker';
import { SlashCommandMenu } from './SlashCommandMenu';
import type { SlashCommand } from './SlashCommandMenu';

interface Props {
  send: (msg: ClientMessage) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

export function ChatInput({ send }: Props) {
  const [images, setImages] = useState<string[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { activatePicker } = useElementPicker();

  const pendingAnchors = useChatStore((s) => s.pendingAnchors);
  const clearAnchors = useChatStore((s) => s.clearAnchors);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const isAgentRunning = useChatStore((s) => s.isAgentRunning);
  const setAgentRunning = useChatStore((s) => s.setAgentRunning);

  // Load slash commands from host
  useEffect(() => {
    send({ type: 'commands:list' } as ClientMessage);
    const handler = (e: Event) => {
      setSlashCommands((e as CustomEvent).detail);
    };
    window.addEventListener('ccb:commands', handler);
    return () => window.removeEventListener('ccb:commands', handler);
  }, [send]);

  // Insert chip at cursor when new anchor arrives
  const lastAnchorCountRef = useRef(0);
  useEffect(() => {
    if (pendingAnchors.length > lastAnchorCountRef.current) {
      const anchor = pendingAnchors[pendingAnchors.length - 1];
      insertChipAtCursor(anchor);
    }
    lastAnchorCountRef.current = pendingAnchors.length;
  }, [pendingAnchors]);

  function insertChipAtCursor(anchor: ElementAnchor) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();

    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.className = 'inline-chip';
    chip.dataset.anchorIndex = String(pendingAnchors.length - 1);
    chip.title = anchor.domPath;
    chip.innerHTML = `<span class="inline-chip__icon">\u29BE</span><span class="inline-chip__label">&lt;${anchor.tagName}&gt;</span>`;

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (editor.contains(range.startContainer)) {
        range.deleteContents();
        range.insertNode(chip);
        range.setStartAfter(chip);
        range.setEndAfter(chip);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.appendChild(chip);
      }
    } else {
      editor.appendChild(chip);
    }

    const space = document.createTextNode('\u00A0');
    chip.after(space);
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(space);
      r.setEndAfter(space);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  function getEditorText(): string {
    const editor = editorRef.current;
    if (!editor) return '';
    let text = '';
    for (const node of Array.from(editor.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? '';
      } else if (node instanceof HTMLElement && node.classList.contains('inline-chip')) {
        const idx = node.dataset.anchorIndex;
        const anchor = idx !== undefined ? pendingAnchors[Number(idx)] : null;
        text += anchor ? `<${anchor.tagName}>` : node.textContent ?? '';
      } else {
        text += node.textContent ?? '';
      }
    }
    return text.replace(/\u00A0/g, ' ').trim();
  }

  const handleSend = useCallback(() => {
    const message = getEditorText();
    if (!message && pendingAnchors.length === 0 && images.length === 0) return;

    const anchors = pendingAnchors.length > 0 ? [...pendingAnchors] : undefined;
    const imgs = images.length > 0 ? [...images] : undefined;
    addUserMessage(message, anchors, imgs);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? '';
      send({
        type: 'chat:send',
        sessionId: activeSessionId ?? undefined,
        message,
        anchors,
        images: imgs,
        url,
      });
    });

    setAgentRunning(true);
    clearAnchors();
    setImages([]);
    lastAnchorCountRef.current = 0;
    if (editorRef.current) editorRef.current.innerHTML = '';
    setShowSlashMenu(false);
  }, [pendingAnchors, images, addUserMessage, send, activeSessionId, clearAnchors, setAgentRunning]);

  const handleStop = useCallback(() => {
    if (activeSessionId) {
      send({ type: 'agent:interrupt', sessionId: activeSessionId });
    }
    setAgentRunning(false);
  }, [activeSessionId, send, setAgentRunning]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showSlashMenu) return; // Let SlashCommandMenu handle keys
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Detect `/` typing for slash command autocomplete
  const handleInput = () => {
    const text = editorRef.current?.textContent ?? '';
    if (text.startsWith('/')) {
      setSlashFilter(text);
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  };

  const handleSlashSelect = (command: string) => {
    if (editorRef.current) {
      editorRef.current.textContent = command;
      // Move cursor to end
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.selectNodeContents(editorRef.current);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setShowSlashMenu(false);
    editorRef.current?.focus();
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const newImages: string[] = [];
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) newImages.push(await readFileAsDataUrl(file));
      }
      setImages((prev) => [...prev, ...newImages]);
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    const newImages: string[] = [];
    for (const file of files) newImages.push(await readFileAsDataUrl(file));
    setImages((prev) => [...prev, ...newImages]);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    const newImages: string[] = [];
    for (const file of files) newImages.push(await readFileAsDataUrl(file));
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = '';
  };

  return (
    <div className="chat-input" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      {/* Slash command menu (above input) */}
      {showSlashMenu && (
        <SlashCommandMenu
          commands={slashCommands}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashMenu(false)}
        />
      )}

      {/* Image previews */}
      {images.length > 0 && (
        <div className="chat-input__images">
          {images.map((src, i) => (
            <div key={i} className="chat-input__image-preview">
              <img src={src} alt="Attached" />
              <button className="chat-input__image-remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>x</button>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      <div
        ref={editorRef}
        className="chat-input__editor"
        contentEditable={!isAgentRunning}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onPaste={handlePaste}
        data-placeholder="Queue another message..."
        role="textbox"
        suppressContentEditableWarning
      />

      {/* Bottom toolbar */}
      <div className="chat-input__toolbar">
        <div className="chat-input__toolbar-left">
          <button
            className="chat-input__tool-btn chat-input__tool-btn--picker"
            onClick={activatePicker}
            disabled={isAgentRunning}
            title="Pick element"
          >
            {'\u2316'}
          </button>
          <button
            className="chat-input__tool-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={isAgentRunning}
            title="Attach file"
          >
            @
          </button>
          <button
            className="chat-input__tool-btn chat-input__tool-btn--slash"
            onClick={() => { setShowSlashMenu(!showSlashMenu); setSlashFilter('/'); }}
            disabled={isAgentRunning}
            title="Slash commands"
          >
            /
          </button>
        </div>

        <div className="chat-input__toolbar-right">
          {isAgentRunning ? (
            <button className="chat-input__stop-btn" onClick={handleStop} title="Stop">
              {'\u25A0'}
            </button>
          ) : (
            <button
              className="chat-input__send-btn"
              onClick={handleSend}
              disabled={!getEditorText() && pendingAnchors.length === 0 && images.length === 0}
              title="Send"
            >
              {'\u2191'}
            </button>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileUpload}
      />
    </div>
  );
}
