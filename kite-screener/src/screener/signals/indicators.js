// Pure technical-indicator math over daily OHLCV candles.
//
// Every function is side-effect free and returns either a full-length array
// (aligned to the input, `null` during the warm-up window) or a small object of
// such arrays. Callers typically only need the most recent value — use
// `last(arr)` for that. Inputs are plain number arrays (closes/highs/…), which
// keeps these helpers trivial to unit-test against a fixed candle fixture.

export function last(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[arr.length - 1];
}

function toNums(values) {
  return (values || []).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) { sum = 0; count = 0; continue; }
    sum += v;
    count += 1;
    if (count > period) { sum -= values[i - period]; count -= 1; }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = null;
  let seed = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v;
      seedCount += 1;
      if (seedCount === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (used by RSI/ATR/ADX).
function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  let seed = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v;
      seedCount += 1;
      if (seedCount === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  const gains = new Array(closes.length).fill(null);
  const losses = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = Math.max(0, diff);
    losses[i] = Math.max(0, -diff);
  }
  const avgGain = wilder(gains.slice(1), period);
  const avgLoss = wilder(losses.slice(1), period);
  for (let i = 0; i < avgGain.length; i += 1) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g == null || l == null) continue;
    const rs = l === 0 ? Infinity : g / l;
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  ));
  const signalLine = ema(macdLine.map((v) => (v == null ? null : v)), signalPeriod);
  const hist = closes.map((_, i) => (
    macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null
  ));
  return { macd: macdLine, signal: signalLine, hist };
}

export function trueRange(highs, lows, closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    if (i === 0) { out[i] = highs[i] - lows[i]; continue; }
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    out[i] = Math.max(hl, hc, lc);
  }
  return out;
}

export function atr(highs, lows, closes, period = 14) {
  const tr = trueRange(highs, lows, closes);
  return wilder(tr, period);
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i += 1) {
    if (mid[i] == null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      variance += (closes[j] - mid[i]) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

export function donchian(highs, lows, period = 20) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(lows.length).fill(null);
  const mid = new Array(highs.length).fill(null);
  for (let i = period - 1; i < highs.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    upper[i] = hi;
    lower[i] = lo;
    mid[i] = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

export function keltner(highs, lows, closes, period = 20, mult = 2, atrPeriod = 10) {
  const mid = ema(closes, period);
  const a = atr(highs, lows, closes, atrPeriod);
  const upper = closes.map((_, i) => (mid[i] != null && a[i] != null ? mid[i] + mult * a[i] : null));
  const lower = closes.map((_, i) => (mid[i] != null && a[i] != null ? mid[i] - mult * a[i] : null));
  return { mid, upper, lower };
}

export function adx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const plusDM = new Array(len).fill(null);
  const minusDM = new Array(len).fill(null);
  for (let i = 1; i < len; i += 1) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(highs, lows, closes);
  const smTR = wilder(tr, period);
  const smPlus = wilder(plusDM.slice(1), period);
  const smMinus = wilder(minusDM.slice(1), period);
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = 0; i < smPlus.length; i += 1) {
    const idx = i + 1;
    const trv = smTR[idx];
    if (trv == null || trv === 0 || smPlus[i] == null || smMinus[i] == null) continue;
    const pdi = (smPlus[i] / trv) * 100;
    const mdi = (smMinus[i] / trv) * 100;
    plusDI[idx] = pdi;
    minusDI[idx] = mdi;
    const denom = pdi + mdi;
    dx[idx] = denom === 0 ? 0 : (Math.abs(pdi - mdi) / denom) * 100;
  }
  const firstDx = dx.findIndex((v) => v != null);
  const adxArr = wilder(dx.filter((v) => v != null), period);
  const adxFull = new Array(len).fill(null);
  if (firstDx >= 0) {
    for (let i = 0; i < adxArr.length; i += 1) {
      adxFull[firstDx + i] = adxArr[i];
    }
  }
  return { adx: adxFull, plusDI, minusDI };
}

export function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const k = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    const range = hi - lo;
    k[i] = range === 0 ? 50 : ((closes[i] - lo) / range) * 100;
  }
  const d = sma(k.map((v) => (v == null ? null : v)), dPeriod);
  return { k, d };
}

export function williamsR(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    const range = hi - lo;
    out[i] = range === 0 ? -50 : ((hi - closes[i]) / range) * -100;
  }
  return out;
}

export function cci(highs, lows, closes, period = 20) {
  const out = new Array(closes.length).fill(null);
  const tp = closes.map((_, i) => (highs[i] + lows[i] + closes[i]) / 3);
  const tpSma = sma(tp, period);
  for (let i = period - 1; i < closes.length; i += 1) {
    if (tpSma[i] == null) continue;
    let meanDev = 0;
    for (let j = i - period + 1; j <= i; j += 1) meanDev += Math.abs(tp[j] - tpSma[i]);
    meanDev /= period;
    out[i] = meanDev === 0 ? 0 : (tp[i] - tpSma[i]) / (0.015 * meanDev);
  }
  return out;
}

export function roc(closes, period = 10) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i += 1) {
    const base = closes[i - period];
    out[i] = base === 0 ? null : ((closes[i] - base) / base) * 100;
  }
  return out;
}

export function obv(closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let acc = 0;
  for (let i = 0; i < closes.length; i += 1) {
    if (i === 0) { out[i] = 0; continue; }
    if (closes[i] > closes[i - 1]) acc += volumes[i];
    else if (closes[i] < closes[i - 1]) acc -= volumes[i];
    out[i] = acc;
  }
  return out;
}

export function mfi(highs, lows, closes, volumes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const tp = closes.map((_, i) => (highs[i] + lows[i] + closes[i]) / 3);
  const posFlow = new Array(closes.length).fill(0);
  const negFlow = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i += 1) {
    const rawFlow = tp[i] * volumes[i];
    if (tp[i] > tp[i - 1]) posFlow[i] = rawFlow;
    else if (tp[i] < tp[i - 1]) negFlow[i] = rawFlow;
  }
  for (let i = period; i < closes.length; i += 1) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j += 1) { pos += posFlow[j]; neg += negFlow[j]; }
    if (neg === 0) { out[i] = 100; continue; }
    const ratio = pos / neg;
    out[i] = 100 - 100 / (1 + ratio);
  }
  return out;
}

// Rolling VWAP over `period` bars (typical price weighted by volume).
export function vwapRolling(highs, lows, closes, volumes, period = 20) {
  const out = new Array(closes.length).fill(null);
  const tp = closes.map((_, i) => (highs[i] + lows[i] + closes[i]) / 3);
  for (let i = period - 1; i < closes.length; i += 1) {
    let pv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j += 1) { pv += tp[j] * volumes[j]; vol += volumes[j]; }
    out[i] = vol === 0 ? null : pv / vol;
  }
  return out;
}

// Accumulation/Distribution line.
export function adLine(highs, lows, closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let acc = 0;
  for (let i = 0; i < closes.length; i += 1) {
    const range = highs[i] - lows[i];
    const mfm = range === 0 ? 0 : ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range;
    acc += mfm * volumes[i];
    out[i] = acc;
  }
  return out;
}

// Volume-Price Trend.
export function vpt(closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev !== 0) acc += volumes[i] * ((closes[i] - prev) / prev);
    out[i] = acc;
  }
  return out;
}

// Parabolic SAR.
export function psar(highs, lows, step = 0.02, maxStep = 0.2) {
  const len = highs.length;
  const out = new Array(len).fill(null);
  if (len < 2) return out;
  let bull = true;
  let af = step;
  let ep = highs[0];
  let sar = lows[0];
  out[0] = sar;
  for (let i = 1; i < len; i += 1) {
    sar += af * (ep - sar);
    if (bull) {
      if (lows[i] < sar) {
        bull = false;
        sar = ep;
        ep = lows[i];
        af = step;
      } else {
        if (highs[i] > ep) { ep = highs[i]; af = Math.min(maxStep, af + step); }
        sar = Math.min(sar, lows[i - 1], lows[Math.max(0, i - 2)]);
      }
    } else {
      if (highs[i] > sar) {
        bull = true;
        sar = ep;
        ep = highs[i];
        af = step;
      } else {
        if (lows[i] < ep) { ep = lows[i]; af = Math.min(maxStep, af + step); }
        sar = Math.max(sar, highs[i - 1], highs[Math.max(0, i - 2)]);
      }
    }
    out[i] = sar;
  }
  return out;
}

// Ichimoku cloud components. Spans are NOT shifted forward — we compare price to
// the current cloud, which is the standard convention for a snapshot signal.
export function ichimoku(highs, lows, closes, conv = 9, base = 26, spanB = 52) {
  const donchianMid = (period) => {
    const out = new Array(highs.length).fill(null);
    for (let i = period - 1; i < highs.length; i += 1) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - period + 1; j <= i; j += 1) {
        if (highs[j] > hi) hi = highs[j];
        if (lows[j] < lo) lo = lows[j];
      }
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const tenkan = donchianMid(conv);
  const kijun = donchianMid(base);
  const spanA = closes.map((_, i) => (tenkan[i] != null && kijun[i] != null ? (tenkan[i] + kijun[i]) / 2 : null));
  const spanBArr = donchianMid(spanB);
  return { tenkan, kijun, spanA, spanB: spanBArr };
}

// Classic pivot points from the previous bar's H/L/C.
export function pivotPoints(prevHigh, prevLow, prevClose) {
  const p = (prevHigh + prevLow + prevClose) / 3;
  return {
    p,
    r1: 2 * p - prevLow,
    s1: 2 * p - prevHigh,
    r2: p + (prevHigh - prevLow),
    s2: p - (prevHigh - prevLow),
  };
}

// Fractal-style swing pivots over the last `lookback` bars. Returns nearest
// support/resistance relative to the current close plus overall swing hi/lo.
export function supportResistance(highs, lows, closes, lookback = 60, wing = 3) {
  const start = Math.max(wing, highs.length - lookback);
  const price = closes[closes.length - 1];
  const resistances = [];
  const supports = [];
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let i = start; i < highs.length - wing; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j += 1) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isHigh = false;
      if (lows[j] <= lows[i]) isLow = false;
    }
    if (isHigh) resistances.push(highs[i]);
    if (isLow) supports.push(lows[i]);
  }
  for (let i = start; i < highs.length; i += 1) {
    if (highs[i] > swingHigh) swingHigh = highs[i];
    if (lows[i] < swingLow) swingLow = lows[i];
  }
  const nearestResistance = resistances.filter((v) => v > price).sort((a, b) => a - b)[0]
    ?? (Number.isFinite(swingHigh) ? swingHigh : null);
  const nearestSupport = supports.filter((v) => v < price).sort((a, b) => b - a)[0]
    ?? (Number.isFinite(swingLow) ? swingLow : null);
  return {
    nearestResistance,
    nearestSupport,
    swingHigh: Number.isFinite(swingHigh) ? swingHigh : null,
    swingLow: Number.isFinite(swingLow) ? swingLow : null,
  };
}

export { toNums };
