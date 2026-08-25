// Weighted-score engine: turns a candle series into a Buy/Hold/Sell verdict plus
// the price levels shown on hover.
//
// - Score: weighted average of every strategy vote in [-1, +1].
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
import { STRATEGIES, SCORE_THRESHOLDS, STRATEGY_CATEGORY_BY_ID } from './registry';

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

function categoryFor(score) {
  if (score >= SCORE_THRESHOLDS.strongBuy) return 'strong-buy';
  if (score >= SCORE_THRESHOLDS.buy) return 'buy';
  if (score < SCORE_THRESHOLDS.sell) return 'sell';
  return 'hold';
}

function deriveLevels({ price, ind }) {
  const atrV = last(ind.atr) || price * 0.02;
  const { nearestResistance, nearestSupport, swingHigh, swingLow } = ind.sr;
  const bollUpper = last(ind.boll.upper);
  const bollLower = last(ind.boll.lower);

  // Buy cap: closest meaningful ceiling above price.
  const ceilings = [nearestResistance, bollUpper, swingHigh]
    .filter((v) => v != null && v > price);
  let buyCap = ceilings.length ? Math.min(...ceilings) : price + atrV * 3;
  buyCap = Math.min(buyCap, price + atrV * 8);
  buyCap = Math.max(buyCap, price + atrV * 0.5);

  // Sell floor: closest meaningful support below price.
  const floors = [nearestSupport, bollLower, swingLow]
    .filter((v) => v != null && v < price);
  let sellFloor = floors.length ? Math.max(...floors) : price - atrV * 3;
  sellFloor = Math.max(sellFloor, price - atrV * 8);
  sellFloor = Math.min(sellFloor, price - atrV * 0.5);

  return {
    price,
    atr: atrV,
    buyCap,
    sellFloor,
    holdLow: nearestSupport != null && nearestSupport < price ? nearestSupport : sellFloor,
    holdHigh: nearestResistance != null && nearestResistance > price ? nearestResistance : buyCap,
  };
}

/**
 * Score a candle series. Returns null when there isn't enough history.
 * @returns {{score:number, category:'strong-buy'|'buy'|'hold'|'sell', levels:object,
 *            contributions:Array, evaluated:number}}
 */
export function scoreSeries(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const cols = toColumns(candles);
  if (cols.closes.length < MIN_CANDLES) return null;

  const ind = buildIndicators(cols);
  const price = last(cols.closes);
  const ctx = { ...cols, price, ind };

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
    weighted += v * strat.weight;
    totalWeight += strat.weight;
    contributions.push({
      id: strat.id,
      label: strat.label,
      category: STRATEGY_CATEGORY_BY_ID[strat.id] || 'other',
      vote: v,
      weight: strat.weight,
    });
  }

  const score = totalWeight ? weighted / totalWeight : 0;
  return {
    score,
    category: categoryFor(score),
    levels: deriveLevels({ price, ind }),
    contributions,
    evaluated: contributions.length,
  };
}

export { MIN_CANDLES };
