// ETF recommendation engine.
//
// For each ETF in the curated universe it gathers daily candles (technical
// engine) plus finapi insights when an ISIN resolves (fundamental engine), runs
// the ~50 indicators from etfIndicators, aggregates them per category into a
// composite score and a Strong Buy…Strong Sell verdict with a confidence %.
//
// Everything reuses existing infrastructure: fetchHistorical (candles),
// loadMfInsights (finapi via the mfProxy bridge), and mapWithConcurrency
// (throttled fan-out). Results are cached in memory for 6h.

import { fetchHistorical } from './kiteApi';
import { loadMfInsights } from './mfInsights';
import { resolveEtfIsin } from './etfIsin';
import { mapWithConcurrency } from './mfApi';
import { computeTechnicalIndicators, computeFundamentalIndicators } from './etfIndicators';
import { ETF_WATCHLIST_SECTIONS } from './etfWatchlistData';

const HISTORY_DAYS = 600; // ~410 trading days — covers SMA200 + 12M momentum
const CONCURRENCY = 4; // be gentle on Kite / finapi
const TTL_MS = 6 * 60 * 60 * 1000;

const CATEGORY_WEIGHTS = {
  trend: 0.30,
  momentum: 0.28,
  volatility: 0.15,
  volume: 0.12,
  fundamental: 0.15,
};

export const VERDICTS = {
  STRONG_BUY: { id: 'strong_buy', label: 'Strong Buy', tone: 'up', min: 60 },
  BUY: { id: 'buy', label: 'Buy', tone: 'up', min: 25 },
  HOLD: { id: 'hold', label: 'Hold', tone: 'flat', min: -25 },
  SELL: { id: 'sell', label: 'Sell', tone: 'down', min: -60 },
  STRONG_SELL: { id: 'strong_sell', label: 'Strong Sell', tone: 'down', min: -Infinity },
};

// Map the curated watchlist section labels to display buckets.
const SECTION_TO_BUCKET = {
  'Gold': 'Gold',
  'Silver': 'Silver',
  'Liquid / 1D': 'Liquid',
  'G-Sec / Bond / Gilt': 'Bond',
  'Equity / Index / Thematic': 'Equity / Index',
};

const cache = new Map(); // symbol -> { at, result }
let universe = null;

/** Flatten the curated ETF sections into a de-duplicated universe with buckets. */
export function getEtfUniverse() {
  if (universe) return universe;
  const seen = new Set();
  const list = [];
  for (const section of ETF_WATCHLIST_SECTIONS) {
    const bucket = SECTION_TO_BUCKET[section.label] || section.label;
    for (const item of section.items || []) {
      const symbol = String(item.tradingsymbol || '').trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      list.push({ ...item, tradingsymbol: symbol, bucket });
    }
  }
  universe = list;
  return list;
}

export const ETF_BUCKETS = ['Gold', 'Silver', 'Bond', 'Equity / Index', 'Liquid'];

function verdictFor(score) {
  if (score >= VERDICTS.STRONG_BUY.min) return VERDICTS.STRONG_BUY;
  if (score >= VERDICTS.BUY.min) return VERDICTS.BUY;
  if (score >= VERDICTS.HOLD.min) return VERDICTS.HOLD;
  if (score >= VERDICTS.SELL.min) return VERDICTS.SELL;
  return VERDICTS.STRONG_SELL;
}

/** Aggregate indicator signals into per-category scores + composite + verdict. */
export function aggregate(indicators) {
  const groups = {};
  for (const ind of indicators) {
    if (ind.signal == null) continue;
    (groups[ind.category] ||= []).push(ind.signal);
  }

  const categoryScores = {};
  let weightSum = 0;
  let weighted = 0;
  for (const [cat, signals] of Object.entries(groups)) {
    if (!signals.length) continue;
    const mean = signals.reduce((a, b) => a + b, 0) / signals.length;
    const score = mean * 100; // -100..100
    categoryScores[cat] = { score, count: signals.length };
    const w = CATEGORY_WEIGHTS[cat] ?? 0;
    weighted += score * w;
    weightSum += w;
  }
  const composite = weightSum ? weighted / weightSum : 0;
  const verdict = verdictFor(composite);

  const valid = indicators.filter((i) => i.signal != null);
  const bull = valid.filter((i) => i.signal > 0).length;
  const bear = valid.filter((i) => i.signal < 0).length;
  const total = valid.length || 1;
  const dir = composite > 0 ? bull : composite < 0 ? bear : (total - bull - bear);
  const confidence = Math.round((dir / total) * 100);

  return {
    composite: Math.round(composite),
    verdict,
    confidence,
    categoryScores,
    counts: { bull, bear, neutral: total - bull - bear, total },
  };
}

async function computeOne(entry, { signal, force = false } = {}) {
  const symbol = entry.tradingsymbol;
  const cached = cache.get(symbol);
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.result;

  const token = Number(entry.instrument_token || entry.token);
  let technical = [];
  let candles = [];
  if (Number.isFinite(token) && token > 0) {
    try {
      candles = await fetchHistorical(token, { interval: 'day', days: HISTORY_DAYS }, signal);
      technical = computeTechnicalIndicators(candles);
    } catch {
      technical = [];
    }
  }

  let fundamental = [];
  let isin = null;
  try {
    isin = await resolveEtfIsin(entry);
    if (isin) {
      const insights = await loadMfInsights(isin, { signal });
      fundamental = computeFundamentalIndicators(insights);
    }
  } catch {
    fundamental = [];
  }

  const indicators = [...technical, ...fundamental];
  const lastClose = candles.length ? Number(candles[candles.length - 1]?.[4]) : null;
  const prevClose = candles.length > 1 ? Number(candles[candles.length - 2]?.[4]) : null;
  const dayChange = lastClose != null && prevClose ? ((lastClose - prevClose) / prevClose) * 100 : null;

  const agg = indicators.length ? aggregate(indicators) : null;
  const result = {
    tradingsymbol: symbol,
    name: entry.name || '',
    bucket: entry.bucket,
    instrument_token: token,
    isin,
    lastPrice: lastClose,
    dayChange,
    indicatorCount: indicators.length,
    indicators,
    hasFundamental: fundamental.length > 0,
    ...(agg || { composite: 0, verdict: VERDICTS.HOLD, confidence: 0, categoryScores: {}, counts: { bull: 0, bear: 0, neutral: 0, total: 0 } }),
  };

  cache.set(symbol, { at: Date.now(), result });
  return result;
}

/**
 * Compute recommendations for the ETF universe (optionally a single bucket).
 * onProgress(resultsSoFar) is called incrementally as ETFs resolve.
 */
export async function computeEtfRecommendations({ bucket = null, signal, force = false, onProgress } = {}) {
  const all = getEtfUniverse().filter((e) => !bucket || e.bucket === bucket);
  const results = [];

  await mapWithConcurrency(all, CONCURRENCY, async (entry) => {
    if (signal?.aborted) return null;
    const res = await computeOne(entry, { signal, force });
    results.push(res);
    if (onProgress) {
      try { onProgress(finalizeVerdicts([...results].sort(sortByScore))); } catch { /* ignore */ }
    }
    return res;
  }, { signal });

  return finalizeVerdicts(results.sort(sortByScore));
}

export function sortByScore(a, b) {
  if (b.composite !== a.composite) return b.composite - a.composite;
  return (b.confidence || 0) - (a.confidence || 0);
}

// Strong Buy is intentionally exclusive: an ETF must clear a high composite
// floor AND show strong signal agreement AND rank within the top slice of the
// whole universe. This keeps "Strong Buy" to a handful of names even when a
// broad rally pushes many composites above the numeric threshold.
const STRONG_BUY_FLOOR = 60;
const STRONG_BUY_MIN_CONFIDENCE = 72;
const STRONG_BUY_MAX_FRACTION = 0.05; // at most ~5% of the universe

/**
 * Re-derive each result's verdict from its composite, then demote all but the
 * strongest, highest-conviction, top-ranked names out of Strong Buy so the tier
 * stays rare. Idempotent — safe to call on partial and final result sets.
 */
export function finalizeVerdicts(results) {
  for (const r of results) r.verdict = verdictFor(r.composite);

  const eligible = results
    .filter((r) => r.composite >= STRONG_BUY_FLOOR && (r.confidence || 0) >= STRONG_BUY_MIN_CONFIDENCE)
    .sort(sortByScore);
  const cap = Math.max(2, Math.round((results.length || 0) * STRONG_BUY_MAX_FRACTION));
  const keep = new Set(eligible.slice(0, cap).map((r) => r.tradingsymbol));

  for (const r of results) {
    if (r.verdict.id === VERDICTS.STRONG_BUY.id && !keep.has(r.tradingsymbol)) {
      r.verdict = VERDICTS.BUY;
    }
  }
  return results;
}

/** Best-ranked ETF per bucket, from a computed results array. */
export function bestPerBucket(results) {
  const best = {};
  for (const r of results) {
    if (!best[r.bucket] || sortByScore(r, best[r.bucket]) < 0) best[r.bucket] = r;
  }
  return best;
}

export function clearEtfRecommendationsCache() {
  cache.clear();
}
