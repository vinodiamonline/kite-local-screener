// Weighted-score engine: turns a candle series into a Buy/Hold/Sell verdict plus
// the price levels shown on hover.
//
// - Score: weighted average of every strategy vote in [-1, +1]; contrarian
//   strategies are down-weighted as the trend strengthens (CONTRARIAN_DAMPING).
// - Category: fixed thresholds (see registry SCORE_THRESHOLDS).
// - Levels: derived from the band/structure indicators, blended with the score:
//     buy  → upper entry cap (nearest resistance / upper Bollinger / swing high)
//     sell → lower exit floor (nearest support / lower Bollinger / swing low)
//     hold → the support–resistance band

import {
  sma, ema, rsi, macd, atr, bollinger, donchian, keltner, adx, stochastic,
  williamsR, cci, roc, obv, mfi, vwapRolling, adLine, vpt, psar, ichimoku,
  pivotPoints, supportResistance, last,
} from './indicators';
import {
  STRATEGIES, SCORE_THRESHOLDS, STRATEGY_CATEGORY_BY_ID, CONTRARIAN_DAMPING, EXTREME_LEVELS,
} from './registry';

const MIN_CANDLES = 60;

// Candles are Kite [time, open, high, low, close, volume] arrays.
function toColumns(candles) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  for (const c of candles) {
    const o = Number(c[1]);
    const h = Number(c[2]);
    const l = Number(c[3]);
    const cl = Number(c[4]);
    const v = Number(c[5]) || 0;
    if (!Number.isFinite(cl)) continue;
    opens.push(Number.isFinite(o) ? o : cl);
    highs.push(Number.isFinite(h) ? h : cl);
    lows.push(Number.isFinite(l) ? l : cl);
    closes.push(cl);
    volumes.push(v);
  }
  return { opens, highs, lows, closes, volumes };
}

function buildIndicators({ highs, lows, closes, volumes }) {
  const boll = bollinger(closes, 20, 2);
  const stdev20 = closes.map((_, i) => (
    boll.upper[i] != null && boll.mid[i] != null ? (boll.upper[i] - boll.mid[i]) / 2 : null
  ));
  const n = closes.length;
  const pivots = n >= 2
    ? pivotPoints(highs[n - 2], lows[n - 2], closes[n - 2])
    : null;

  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema9: ema(closes, 9),
    ema12: ema(closes, 12),
    ema21: ema(closes, 21),
    ema26: ema(closes, 26),
    ema50: ema(closes, 50),
    macd: macd(closes),
    adx: adx(highs, lows, closes),
    rsi: rsi(closes),
    stoch: stochastic(highs, lows, closes),
    williams: williamsR(highs, lows, closes),
    cci: cci(highs, lows, closes),
    roc: roc(closes, 10),
    mfi: mfi(highs, lows, closes, volumes),
    boll,
    stdev20,
    keltner: keltner(highs, lows, closes),
    donchian: donchian(highs, lows, 20),
    atr: atr(highs, lows, closes),
    sr: supportResistance(highs, lows, closes, 60, 3),
    pivots,
    vwap: vwapRolling(highs, lows, closes, volumes, 20),
    obv: obv(closes, volumes),
    ad: adLine(highs, lows, closes, volumes),
    vpt: vpt(closes, volumes),
    volSma20: sma(volumes, 20),
    ichimoku: ichimoku(highs, lows, closes),
    psar: psar(highs, lows),
  };
}

// 'overbought' | 'oversold' | null, from RSI or price outside the Bollinger bands.
function extremeOf(price, ind) {
  const { rsiHigh, rsiLow, pctBHigh, pctBLow } = EXTREME_LEVELS;
  const rsiV = last(ind.rsi);
  const u = last(ind.boll.upper);
  const l = last(ind.boll.lower);
  const pctB = u != null && l != null && u !== l ? (price - l) / (u - l) : null;
  if ((rsiV != null && rsiV >= rsiHigh) || (pctB != null && pctB >= pctBHigh)) return 'overbought';
  if ((rsiV != null && rsiV <= rsiLow) || (pctB != null && pctB <= pctBLow)) return 'oversold';
  return null;
}

// Raw indicator values at the last candle, for the detailed "values" table.
// Kept small (plain numbers) because it is cached per symbol in localStorage.
function pctChange(arr, lookback) {
  const cur = last(arr);
  const past = Array.isArray(arr) ? arr[arr.length - 1 - lookback] : null;
  if (cur == null || past == null || past === 0) return null;
  return ((cur - past) / Math.abs(past)) * 100;
}

function snapshotReadings(ctx) {
  const { price, closes, volumes, ind } = ctx;
  const u = last(ind.boll.upper);
  const l = last(ind.boll.lower);
  const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
  const r = {
    price,
    sma20: last(ind.sma20), sma50: last(ind.sma50), sma200: last(ind.sma200),
    ema9: last(ind.ema9), ema12: last(ind.ema12), ema21: last(ind.ema21),
    ema26: last(ind.ema26), ema50: last(ind.ema50), ema50Slope: pctChange(ind.ema50, 20),
    macd: last(ind.macd.macd), macdSignal: last(ind.macd.signal), macdHist: last(ind.macd.hist),
    adx: last(ind.adx.adx), plusDI: last(ind.adx.plusDI), minusDI: last(ind.adx.minusDI),
    psar: last(ind.psar),
    ichiSpanA: last(ind.ichimoku.spanA), ichiSpanB: last(ind.ichimoku.spanB),
    tenkan: last(ind.ichimoku.tenkan), kijun: last(ind.ichimoku.kijun),
    rsi: last(ind.rsi), stochK: last(ind.stoch.k), stochD: last(ind.stoch.d),
    williams: last(ind.williams), cci: last(ind.cci), roc: last(ind.roc), mfi: last(ind.mfi),
    bollUpper: u, bollLower: l, pctB: u != null && l != null && u !== l ? (price - l) / (u - l) : null,
    keltnerUpper: last(ind.keltner.upper), keltnerLower: last(ind.keltner.lower),
    donchianUpper: last(ind.donchian.upper), donchianLower: last(ind.donchian.lower),
    atr: last(ind.atr), change15: pctChange(closes, 14),
    swingHigh: ind.sr.swingHigh, swingLow: ind.sr.swingLow,
    support: ind.sr.nearestSupport, resistance: ind.sr.nearestResistance,
    pivot: ind.pivots?.p ?? null,
    zScore: last(ind.stdev20) ? (price - last(ind.sma20)) / last(ind.stdev20) : null,
    vwap: last(ind.vwap),
    obvChange: pctChange(ind.obv, 20), adChange: pctChange(ind.ad, 20), vptChange: pctChange(ind.vpt, 20),
    volRatio: last(ind.volSma20) ? last(volumes) / last(ind.volSma20) : null,
  };
  for (const k of Object.keys(r)) r[k] = round(r[k], k === 'pctB' || k === 'zScore' || k === 'volRatio' ? 3 : 2);
  return r;
}

function categoryFor(score) {
  if (score >= SCORE_THRESHOLDS.strongBuy) return 'strong-buy';
  if (score >= SCORE_THRESHOLDS.buy) return 'buy';
  if (score < SCORE_THRESHOLDS.sell) return 'sell';
  return 'hold';
}

// Pick the closest candidate level and remember where it came from, then keep
// it within a sane ATR-based distance (falling back to a volatility estimate).
function pickLevel(candidates, { price, atrV, above }) {
  const valid = candidates.filter(({ value }) => value != null && (above ? value > price : value < price));
  let best = valid.length
    ? valid.reduce((a, b) => (above ? (b.value < a.value ? b : a) : (b.value > a.value ? b : a)))
    : { value: price + (above ? 3 : -3) * atrV, source: 'volatility' };
  const far = price + (above ? 8 : -8) * atrV;
  const near = price + (above ? 0.5 : -0.5) * atrV;
  const clamped = above
    ? Math.max(Math.min(best.value, far), near)
    : Math.min(Math.max(best.value, far), near);
  if (clamped !== best.value) best = { value: clamped, source: 'volatility' };
  return best;
}

function deriveLevels({ price, ind }) {
  const atrV = last(ind.atr) || price * 0.02;
  const { nearestResistance, nearestSupport, swingHigh, swingLow } = ind.sr;

  // Buy cap: closest meaningful ceiling above price.
  const cap = pickLevel([
    { value: nearestResistance, source: 'resistance' },
    { value: last(ind.boll.upper), source: 'upper-band' },
    { value: swingHigh, source: 'recent-high' },
  ], { price, atrV, above: true });

  // Sell floor: closest meaningful support below price.
  const floor = pickLevel([
    { value: nearestSupport, source: 'support' },
    { value: last(ind.boll.lower), source: 'lower-band' },
    { value: swingLow, source: 'recent-low' },
  ], { price, atrV, above: false });

  const hasSupport = nearestSupport != null && nearestSupport < price;
  const hasResistance = nearestResistance != null && nearestResistance > price;

  return {
    price,
    atr: atrV,
    sma20: last(ind.sma20),
    sma50: last(ind.sma50),
    buyCap: cap.value,
    buyCapSource: cap.source,
    sellFloor: floor.value,
    sellFloorSource: floor.source,
    holdLow: hasSupport ? nearestSupport : floor.value,
    holdLowSource: hasSupport ? 'support' : floor.source,
    holdHigh: hasResistance ? nearestResistance : cap.value,
    holdHighSource: hasResistance ? 'resistance' : cap.source,
  };
}

/**
 * Score a candle series. Returns null when there isn't enough history.
 * @returns {{score:number, category:'strong-buy'|'buy'|'hold'|'sell', levels:object,
 *            extreme:'overbought'|'oversold'|null, capped:boolean,
 *            contributions:Array, evaluated:number}}
 */
export function scoreSeries(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const cols = toColumns(candles);
  if (cols.closes.length < MIN_CANDLES) return null;

  const ind = buildIndicators(cols);
  const price = last(cols.closes);
  const ctx = { ...cols, price, ind };

  // 0 in a range (ADX ≤ adxFrom) → 1 in a strong trend (ADX ≥ adxFull).
  // No trimming at an extreme: then overbought/oversold readings count fully.
  const { adxFrom, adxFull, maxCut } = CONTRARIAN_DAMPING;
  const extreme = extremeOf(price, ind);
  const adxNow = last(ind.adx.adx);
  const trendStrength = adxNow == null || extreme
    ? 0
    : Math.max(0, Math.min(1, (adxNow - adxFrom) / (adxFull - adxFrom)));
  const contrarianFactor = 1 - maxCut * trendStrength;

  let weighted = 0;
  let totalWeight = 0;
  const contributions = [];
  for (const strat of STRATEGIES) {
    let vote = null;
    try {
      vote = strat.evaluate(ctx);
    } catch {
      vote = null;
    }
    if (vote == null || Number.isNaN(vote)) continue;
    const v = Math.max(-1, Math.min(1, vote));
    const weight = strat.contrarian ? strat.weight * contrarianFactor : strat.weight;
    weighted += v * weight;
    totalWeight += weight;
    contributions.push({
      id: strat.id,
      label: strat.label,
      category: STRATEGY_CATEGORY_BY_ID[strat.id] || 'other',
      vote: v,
      weight,
    });
  }

  const score = totalWeight ? weighted / totalWeight : 0;
  let category = categoryFor(score);
  // Don't call a stretched stock a Strong Buy: buy-on-dip territory at best.
  const capped = extreme === 'overbought' && category === 'strong-buy';
  if (capped) category = 'buy';
  return {
    score,
    category,
    extreme,
    capped,
    readings: snapshotReadings(ctx),
    levels: deriveLevels({ price, ind }),
    contributions,
    evaluated: contributions.length,
  };
}

export { MIN_CANDLES };
