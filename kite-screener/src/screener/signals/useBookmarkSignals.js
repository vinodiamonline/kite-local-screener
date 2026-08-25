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
import { mapWithConcurrency } from '../mfApi';
import { scoreSeries } from './scoreEngine';

const LOOKBACK_DAYS = 730;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const STORAGE_KEY = 'kite-screener-signal-cache-v5';
const CONCURRENCY = 4;

const memCache = new Map(); // token -> { at, result }

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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
 * @param {{ enabled?: boolean, refreshKey?: any }} options
 * @returns {{ signals: Object, loading: boolean, ready: boolean }}
 *          signals keyed by bookmarkKey -> { category, score, levels, contributions } | { status:'pending'|'error' }
 */
export function useBookmarkSignals(entries, { enabled = true, refreshKey } = {}) {
  const [signals, setSignals] = useState({});
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);
  const forceKeyRef = useRef(refreshKey);

  const stockEntries = useMemo(
    () => (entries || []).filter((e) => e && e.type !== 'separator' && (e.tradingsymbol || e.symbol)),
    [entries],
  );
  const entriesKey = stockEntries.map((e) => bookmarkKey(e)).join(',');

  useEffect(() => {
    if (!enabled || stockEntries.length === 0) {
      setSignals({});
      setLoading(false);
      return undefined;
    }

    const gen = genRef.current + 1;
    genRef.current = gen;
    const controller = new AbortController();
    const force = refreshKey !== forceKeyRef.current;
    forceKeyRef.current = refreshKey;

    setLoading(true);

    (async () => {
      const next = {};
      await mapWithConcurrency(stockEntries, CONCURRENCY, async (entry) => {
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
            levels: result.levels,
            contributions: result.contributions,
          };
          writeCache(token, payload);
          next[key] = payload;
        } catch {
          next[key] = { status: 'error' };
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
  }, [enabled, entriesKey, refreshKey]);

  return { signals, loading, ready: !loading && Object.keys(signals).length > 0 };
}
