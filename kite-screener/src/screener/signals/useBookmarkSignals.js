// React hook: compute a Buy/Hold/Sell signal for each bookmarked instrument.
//
// For the active bookmark list it resolves instrument tokens, pulls ~2y of daily
// candles from Kite (concurrency-limited), and runs the weighted score engine.
// Results are cached per token in memory + localStorage (small footprint: only
// the verdict/levels are stored, not the raw candles) with a TTL so revisiting
// the view is instant and we don't hammer the historical endpoint.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchHistorical } from '../kiteApi';
import { resolveInstrumentToken } from '../bookmarks';
import { bookmarkKey } from '../bookmarks';
import { parseInstrumentToken } from '../instrumentToken';
import { mapWithConcurrency } from '../mfApi';
import { scoreSeries } from './scoreEngine';

const LOOKBACK_DAYS = 730;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const STORAGE_KEY = 'kite-screener-signal-cache-v9';
const CONCURRENCY = 4;

const memCache = new Map(); // token -> { at, result }
let storeMemo = null; // parsed localStorage cache, loaded once per page

export function isIndexEntry(entry) {
  const seg = String(entry?.segment || '').toUpperCase();
  const exch = String(entry?.exchange || '').toUpperCase();
  return seg === 'INDICES' || exch === 'INDICES';
}

/** True when the list has at least one entry that can get a signal. */
export function hasSignalEntries(entries) {
  return (entries || []).some((e) => e && e.type !== 'separator' && (e.tradingsymbol || e.symbol) && !isIndexEntry(e));
}

function loadStore() {
  if (storeMemo) return storeMemo;
  try {
    // Drop caches from older scoring versions; they are never read again.
    for (let v = 1; v < 9; v += 1) localStorage.removeItem(`kite-screener-signal-cache-v${v}`);
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    storeMemo = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    storeMemo = {};
  }
  return storeMemo;
}

function saveStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // storage full / unavailable — in-memory cache still applies for the session
  }
}

function readCache(token) {
  const mem = memCache.get(token);
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.result;
  const store = loadStore();
  const hit = store[token];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    memCache.set(token, { at: hit.at, result: hit.result });
    return hit.result;
  }
  return null;
}

function writeCache(token, result) {
  const at = Date.now();
  memCache.set(token, { at, result });
  const store = loadStore();
  store[token] = { at, result };
  saveStore(store);
}

/**
 * @param {Array} entries bookmark entries (may include separators)
 * @param {{ enabled?: boolean, refreshKey?: any, fetchMissing?: boolean, concurrency?: number }} options
 *   fetchMissing=false only shows already-cached results (no network requests).
 * @returns {{ signals: Object, loading: boolean, ready: boolean, progress: {done:number,total:number} }}
 *          signals keyed by bookmarkKey -> { category, score, levels, contributions } | { status:'pending'|'error' }
 */
export function useBookmarkSignals(entries, {
  enabled = true,
  refreshKey,
  fetchMissing = true,
  concurrency = CONCURRENCY,
} = {}) {
  const [signals, setSignals] = useState({});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const genRef = useRef(0);
  const forceKeyRef = useRef(refreshKey);

  // Indices are not tradable, so they get no Buy/Hold/Sell signal.
  const stockEntries = useMemo(
    () => (entries || []).filter((e) => e && e.type !== 'separator' && (e.tradingsymbol || e.symbol)
      && !isIndexEntry(e)),
    [entries],
  );
  const entriesKey = stockEntries.map((e) => bookmarkKey(e)).join(',');

  useEffect(() => {
    if (!enabled || stockEntries.length === 0) {
      setSignals({});
      setLoading(false);
      setProgress({ done: 0, total: 0 });
      return undefined;
    }

    const gen = genRef.current + 1;
    genRef.current = gen;
    const controller = new AbortController();
    const force = fetchMissing && refreshKey !== forceKeyRef.current;
    forceKeyRef.current = refreshKey;

    // Cache-only pass: show whatever is already computed, no network. Uses the
    // token stored on the entry so no lookup requests are made either.
    if (!fetchMissing) {
      const next = {};
      for (const entry of stockEntries) {
        const token = parseInstrumentToken(entry.instrument_token);
        const cached = token ? readCache(token) : null;
        if (cached) next[bookmarkKey(entry)] = cached;
      }
      setSignals(next);
      setLoading(false);
      setProgress({ done: 0, total: 0 });
      return undefined;
    }

    setLoading(true);
    let done = 0;
    setProgress({ done: 0, total: stockEntries.length });

    (async () => {
      const next = {};
      await mapWithConcurrency(stockEntries, concurrency, async (entry) => {
        const key = bookmarkKey(entry);
        try {
          const token = await resolveInstrumentToken(entry, controller.signal);
          if (!token) { next[key] = { status: 'error' }; return; }

          if (!force) {
            const cached = readCache(token);
            if (cached) { next[key] = cached; return; }
          }

          const candles = await fetchHistorical(
            token,
            { interval: 'day', days: LOOKBACK_DAYS },
            controller.signal,
          );
          const result = scoreSeries(candles);
          if (!result) { next[key] = { status: 'error' }; return; }

          const payload = {
            category: result.category,
            score: result.score,
            extreme: result.extreme,
            capped: result.capped,
            readings: result.readings,
            levels: result.levels,
            contributions: result.contributions,
          };
          writeCache(token, payload);
          next[key] = payload;
        } catch {
          next[key] = { status: 'error' };
        } finally {
          done += 1;
          if (gen === genRef.current) setProgress({ done, total: stockEntries.length });
        }
      }, { signal: controller.signal });

      if (gen === genRef.current) {
        setSignals(next);
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      genRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, entriesKey, refreshKey, fetchMissing]);

  return { signals, loading, progress, ready: !loading && Object.keys(signals).length > 0 };
}
