import { useSyncExternalStore } from 'react';

// Per-fund NAV alerts, keyed by ISIN: { [isin]: { above?: number, below?: number } }.
// Alerts are checked against the latest NAV whenever the holdings view loads,
// so they work without any background polling.
const STORAGE_KEY = 'kite-screener-mf-nav-alerts';

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let alerts = load();
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    alerts = load();
    emit();
  });
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function setMfAlert(isin, { above, below } = {}) {
  const key = String(isin || '').trim().toUpperCase();
  if (!key) return;
  const next = { ...alerts };
  const entry = {};
  const a = positive(above);
  const b = positive(below);
  if (a != null) entry.above = a;
  if (b != null) entry.below = b;
  if (Object.keys(entry).length) next[key] = entry;
  else delete next[key];
  alerts = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch {
    // ignore storage failures
  }
  emit();
}

export function useMfAlerts() {
  return useSyncExternalStore(subscribe, () => alerts);
}

/** Returns the triggered side ('above' | 'below') or null. */
export function checkMfAlert(alert, nav) {
  if (!alert || !Number.isFinite(nav) || nav <= 0) return null;
  if (alert.above != null && nav >= alert.above) return 'above';
  if (alert.below != null && nav <= alert.below) return 'below';
  return null;
}
