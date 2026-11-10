import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'kite-screener-symbol-notes';

// Notes are keyed by tradingsymbol only, so the same note follows a stock
// across NSE/BSE and every list (bookmarks, watchlists, screeners, holdings).
export function noteKey(entry) {
  const symbol = typeof entry === 'string' ? entry : entry?.tradingsymbol || entry?.symbol;
  return String(symbol || '').trim().toUpperCase();
}

function loadNotes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let notes = loadNotes();
let editing = null;
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Keep multiple open tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    notes = loadNotes();
    emit();
  });
}

export function getSymbolNote(entry) {
  return notes[noteKey(entry)] || '';
}

export function setSymbolNote(entry, text) {
  const key = noteKey(entry);
  if (!key) return;
  const value = String(text || '').trim();
  const next = { ...notes };
  if (value) next[key] = value;
  else delete next[key];
  notes = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // ignore storage failures
  }
  emit();
}

/** Subscribe to the notes map; re-renders whenever any note changes. */
export function useSymbolNotes() {
  return useSyncExternalStore(subscribe, () => notes);
}

export function openNoteEditor(entry, { label } = {}) {
  const key = noteKey(entry);
  if (!key) return;
  editing = { symbol: key, label: label || '' };
  emit();
}

export function closeNoteEditor() {
  editing = null;
  emit();
}

export function useNoteEditor() {
  return useSyncExternalStore(subscribe, () => editing);
}
