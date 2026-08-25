// Strategy registry + fixed weights/thresholds.
//
// Each strategy exposes `evaluate(ctx) -> vote` where `vote` is in [-1, +1]
// (+1 = strong buy, -1 = strong sell, 0 / null = neutral or insufficient data).
// The score engine aggregates these into a single weighted score. Adding a new
// strategy is a one-line push here — nothing else in the app needs to change.
//
// `ctx` is prepared by scoreEngine.js and carries the raw OHLCV arrays plus a
// bundle of pre-computed indicators (`ctx.ind.*`), so strategies stay cheap.

import { last } from './indicators';

// --- Score → category thresholds (tunable in one place) ---------------------
export const SCORE_THRESHOLDS = { strongBuy: 0.40, buy: 0.20, sell: -0.10 };

function clamp(x, lo = -1, hi = 1) {
  if (x == null || Number.isNaN(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

// Oscillator helper: low value = oversold = buy (+1), high value = sell (-1).
function oscVote(value, low, high) {
  if (value == null) return null;
  const mid = (low + high) / 2;
  return clamp((mid - value) / (mid - low));
}

// Slope of a series over `lookback` bars, normalised to a bounded vote.
function slopeVote(arr, lookback = 20) {
  if (!Array.isArray(arr)) return null;
  const cur = last(arr);
  const past = arr[arr.length - 1 - lookback];
  if (cur == null || past == null) return null;
  if (past === 0) return cur > 0 ? 1 : cur < 0 ? -1 : 0;
  return clamp(((cur - past) / Math.abs(past)) * 4);
}

export const STRATEGIES = [
  // --- Trend / moving averages ---------------------------------------------
  {
    id: 'sma-strategy',
    label: 'SMA Strategy',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const s20 = last(ind.sma20);
      const s50 = last(ind.sma50);
      if (s20 == null || s50 == null) return null;
      let v = 0;
      v += price > s20 ? 0.5 : -0.5;
      v += s20 > s50 ? 0.5 : -0.5;
      return v;
    },
  },
  {
    id: 'ema-crossover',
    label: 'EMA Crossover',
    weight: 1.2,
    evaluate: ({ ind }) => {
      const f = last(ind.ema12);
      const s = last(ind.ema26);
      if (f == null || s == null || s === 0) return null;
      return clamp(((f - s) / s) * 25);
    },
  },
  {
    id: 'ma-crossover',
    label: 'MA Crossover (50/200)',
    weight: 1.3,
    evaluate: ({ ind }) => {
      const s50 = last(ind.sma50);
      const s200 = last(ind.sma200);
      if (s50 == null || s200 == null || s200 === 0) return null;
      return clamp(((s50 - s200) / s200) * 12);
    },
  },
  {
    id: 'ema-ribbon',
    label: 'EMA Ribbon (9/21)',
    weight: 0.8,
    evaluate: ({ ind }) => {
      const f = last(ind.ema9);
      const s = last(ind.ema21);
      if (f == null || s == null || s === 0) return null;
      return clamp(((f - s) / s) * 30);
    },
  },
  {
    id: 'trend-following',
    label: 'Trend Following (EMA50 slope)',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const e50 = last(ind.ema50);
      const slope = slopeVote(ind.ema50, 20);
      if (e50 == null || slope == null) return null;
      const posBias = price > e50 ? 0.4 : -0.4;
      return clamp(slope * 0.6 + posBias);
    },
  },
  {
    id: 'long-term-trend',
    label: 'Long-Term Trend (vs SMA200)',
    weight: 0.9,
    evaluate: ({ price, ind }) => {
      const s200 = last(ind.sma200);
      if (s200 == null || s200 === 0) return null;
      return clamp(((price - s200) / s200) * 6);
    },
  },
  {
    id: 'macd',
    label: 'MACD',
    weight: 1.2,
    evaluate: ({ ind }) => {
      const hist = last(ind.macd.hist);
      const m = last(ind.macd.macd);
      const sig = last(ind.macd.signal);
      if (hist == null || m == null || sig == null) return null;
      const cross = m > sig ? 0.5 : -0.5;
      const mom = clamp(slopeVote(ind.macd.hist, 5) ?? 0) * 0.5;
      return clamp(cross + mom);
    },
  },
  {
    id: 'adx-trend',
    label: 'ADX / DI',
    weight: 1.1,
    evaluate: ({ ind }) => {
      const adxV = last(ind.adx.adx);
      const pdi = last(ind.adx.plusDI);
      const mdi = last(ind.adx.minusDI);
      if (adxV == null || pdi == null || mdi == null) return null;
      const strength = clamp((adxV - 15) / 25, 0, 1);
      const dir = pdi > mdi ? 1 : -1;
      return clamp(dir * strength);
    },
  },
  {
    id: 'parabolic-sar',
    label: 'Parabolic SAR',
    weight: 0.9,
    evaluate: ({ price, ind }) => {
      const s = last(ind.psar);
      if (s == null) return null;
      return price > s ? 0.8 : -0.8;
    },
  },
  {
    id: 'ichimoku',
    label: 'Ichimoku Cloud',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const a = last(ind.ichimoku.spanA);
      const b = last(ind.ichimoku.spanB);
      const tenkan = last(ind.ichimoku.tenkan);
      const kijun = last(ind.ichimoku.kijun);
      if (a == null || b == null) return null;
      const cloudTop = Math.max(a, b);
      const cloudBottom = Math.min(a, b);
      let v = 0;
      if (price > cloudTop) v += 0.6;
      else if (price < cloudBottom) v -= 0.6;
      if (tenkan != null && kijun != null) v += tenkan > kijun ? 0.4 : -0.4;
      return clamp(v);
    },
  },

  // --- Momentum / oscillators ----------------------------------------------
  {
    id: 'rsi',
    label: 'RSI',
    weight: 1.1,
    evaluate: ({ ind }) => oscVote(last(ind.rsi), 30, 70),
  },
  {
    id: 'stochastic',
    label: 'Stochastic Oscillator',
    weight: 0.9,
    evaluate: ({ ind }) => {
      const k = last(ind.stoch.k);
      const d = last(ind.stoch.d);
      if (k == null) return null;
      const level = oscVote(k, 20, 80) ?? 0;
      const cross = d != null ? (k > d ? 0.2 : -0.2) : 0;
      return clamp(level * 0.8 + cross);
    },
  },
  {
    id: 'williams-r',
    label: 'Williams %R',
    weight: 0.8,
    evaluate: ({ ind }) => oscVote(last(ind.williams), -80, -20),
  },
  {
    id: 'cci',
    label: 'CCI',
    weight: 0.8,
    evaluate: ({ ind }) => {
      const v = last(ind.cci);
      if (v == null) return null;
      return clamp(-v / 150);
    },
  },
  {
    id: 'momentum',
    label: 'Momentum (ROC)',
    weight: 1,
    evaluate: ({ ind }) => {
      const v = last(ind.roc);
      if (v == null) return null;
      return clamp(v / 12);
    },
  },
  {
    id: 'mfi',
    label: 'Money Flow Index',
    weight: 0.9,
    evaluate: ({ ind }) => oscVote(last(ind.mfi), 20, 80),
  },

  // --- Volatility / bands ---------------------------------------------------
  {
    id: 'bollinger',
    label: 'Bollinger Bands',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const u = last(ind.boll.upper);
      const l = last(ind.boll.lower);
      if (u == null || l == null || u === l) return null;
      const pctB = (price - l) / (u - l); // 0 = lower band, 1 = upper band
      return clamp((0.5 - pctB) * 2.2); // near lower = buy, near upper = sell
    },
  },
  {
    id: 'keltner',
    label: 'Keltner Channels',
    weight: 0.8,
    evaluate: ({ price, ind }) => {
      const u = last(ind.keltner.upper);
      const l = last(ind.keltner.lower);
      const m = last(ind.keltner.mid);
      if (u == null || l == null || m == null) return null;
      if (price > u) return -0.5; // extended above
      if (price < l) return 0.5; // extended below
      return clamp((price - m) / (u - m) * 0.5);
    },
  },
  {
    id: 'donchian-breakout',
    label: 'Donchian Channels',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const u = last(ind.donchian.upper);
      const l = last(ind.donchian.lower);
      const m = last(ind.donchian.mid);
      if (u == null || l == null || m == null || u === l) return null;
      if (price >= u) return 0.9; // breakout up
      if (price <= l) return -0.9; // breakdown
      return clamp((price - m) / (u - m));
    },
  },
  {
    id: 'atr-trend',
    label: 'ATR-Based Trend',
    weight: 0.7,
    evaluate: ({ closes, ind }) => {
      const a = last(ind.atr);
      const cur = last(closes);
      const past = closes[closes.length - 15];
      if (a == null || a === 0 || cur == null || past == null) return null;
      return clamp((cur - past) / (a * 3));
    },
  },

  // --- Structure ------------------------------------------------------------
  {
    id: 'breakout',
    label: 'Breakout Strategy',
    weight: 1,
    evaluate: ({ price, ind }) => {
      const hi = ind.sr.swingHigh;
      const lo = ind.sr.swingLow;
      if (hi == null || lo == null) return null;
      if (price >= hi) return 1;
      if (price <= lo) return -1;
      return 0;
    },
  },
  {
    id: 'support-resistance',
    label: 'Support / Resistance',
    weight: 0.9,
    evaluate: ({ price, ind }) => {
      const r = ind.sr.nearestResistance;
      const s = ind.sr.nearestSupport;
      if (r == null || s == null || r === s) return null;
      const pos = (price - s) / (r - s); // 0 = at support, 1 = at resistance
      return clamp((0.5 - pos) * 1.6);
    },
  },
  {
    id: 'pivot',
    label: 'Pivot Points',
    weight: 0.7,
    evaluate: ({ price, ind }) => {
      const p = ind.pivots?.p;
      if (p == null || p === 0) return null;
      return clamp(((price - p) / p) * 20);
    },
  },
  {
    id: 'mean-reversion',
    label: 'Mean Reversion',
    weight: 0.9,
    evaluate: ({ price, ind }) => {
      const m = last(ind.sma20);
      const sd = last(ind.stdev20);
      if (m == null || sd == null || sd === 0) return null;
      const z = (price - m) / sd;
      return clamp(-z / 2); // stretched above mean = sell, below = buy
    },
  },

  // --- Volume ---------------------------------------------------------------
  {
    id: 'vwap',
    label: 'VWAP',
    weight: 0.9,
    evaluate: ({ price, ind }) => {
      const v = last(ind.vwap);
      if (v == null || v === 0) return null;
      return clamp(((price - v) / v) * 20);
    },
  },
  {
    id: 'obv',
    label: 'On-Balance Volume',
    weight: 0.8,
    evaluate: ({ ind }) => slopeVote(ind.obv, 20),
  },
  {
    id: 'accumulation-distribution',
    label: 'Accumulation / Distribution',
    weight: 0.8,
    evaluate: ({ ind }) => slopeVote(ind.ad, 20),
  },
  {
    id: 'volume-price-trend',
    label: 'Volume-Price Trend',
    weight: 0.7,
    evaluate: ({ ind }) => slopeVote(ind.vpt, 20),
  },
  {
    id: 'volume-momentum',
    label: 'Volume Momentum',
    weight: 0.6,
    evaluate: ({ closes, volumes, ind }) => {
      const avgVol = last(ind.volSma20);
      const curVol = last(volumes);
      const cur = last(closes);
      const prev = closes[closes.length - 2];
      if (avgVol == null || avgVol === 0 || curVol == null || cur == null || prev == null) return null;
      const surge = clamp((curVol / avgVol - 1), -1, 1);
      const dir = cur >= prev ? 1 : -1;
      return clamp(dir * surge * 0.8);
    },
  },
];

// --- Strategy grouping (for the "how we reached this score" breakdown) -------
// Human-readable category labels, ordered for display.
export const STRATEGY_CATEGORIES = {
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  structure: 'Structure',
  volume: 'Volume',
};

// Maps each strategy id to its category. Kept alongside STRATEGIES so a new
// strategy just needs one extra line here to show up grouped in the tooltip.
export const STRATEGY_CATEGORY_BY_ID = {
  'sma-strategy': 'trend',
  'ema-crossover': 'trend',
  'ma-crossover': 'trend',
  'ema-ribbon': 'trend',
  'trend-following': 'trend',
  'long-term-trend': 'trend',
  macd: 'trend',
  'adx-trend': 'trend',
  'parabolic-sar': 'trend',
  ichimoku: 'trend',
  rsi: 'momentum',
  stochastic: 'momentum',
  'williams-r': 'momentum',
  cci: 'momentum',
  momentum: 'momentum',
  mfi: 'momentum',
  bollinger: 'volatility',
  keltner: 'volatility',
  'donchian-breakout': 'volatility',
  'atr-trend': 'volatility',
  breakout: 'structure',
  'support-resistance': 'structure',
  pivot: 'structure',
  'mean-reversion': 'structure',
  vwap: 'volume',
  obv: 'volume',
  'accumulation-distribution': 'volume',
  'volume-price-trend': 'volume',
  'volume-momentum': 'volume',
};
