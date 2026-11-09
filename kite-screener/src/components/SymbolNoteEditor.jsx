import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closeNoteEditor,
  getSymbolNote,
  setSymbolNote,
  useNoteEditor,
} from '../screener/symbolNotes';

// Single app-wide editor, opened from any symbol's right-click menu.
export default function SymbolNoteEditor() {
  const editing = useNoteEditor();
  const symbol = editing?.symbol;
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!symbol) return;
    setText(getSymbolNote(symbol));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [symbol]);

  if (!symbol) return null;

  const existing = getSymbolNote(symbol);
  const save = () => {
    setSymbolNote(symbol, text);
    closeNoteEditor();
  };
  const remove = () => {
    setSymbolNote(symbol, '');
    closeNoteEditor();
  };

  return createPortal(
    <div
      className="note-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Note for ${symbol}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeNoteEditor();
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save();
      }}
    >
      <div className="note-editor-backdrop" onClick={closeNoteEditor} />
      <div className="note-editor-panel">
        <div className="note-editor-head">
          <span className="note-editor-title">Note · {symbol}</span>
          <button type="button" className="note-editor-close" onClick={closeNoteEditor} aria-label="Close">×</button>
        </div>
        <textarea
          ref={inputRef}
          className="note-editor-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Write a note for this stock…"
          rows={5}
        />
        <div className="note-editor-actions">
          {existing && (
            <button type="button" className="note-editor-btn note-editor-delete" onClick={remove}>Delete</button>
          )}
          <span className="note-editor-hint">Ctrl+Enter to save</span>
          <button type="button" className="note-editor-btn" onClick={closeNoteEditor}>Cancel</button>
          <button type="button" className="note-editor-btn note-editor-save" onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
