// ETF indicator engine.
//
// Computes ~42 technical signals from Kite daily candles (via the proven
// `technicalindicators` library — established formulas, not hand-rolled) plus
// ~13 fundamental / risk signals from the existing finapi insights payload.
//
// Each indicator is normalized to a signal: +1 bullish, 0 neutral, -1 bearish,
// with a human-readable value/note so the recommendation is fully auditable.

import {
  SMA, EMA, WMA, MACD, RSI, Stochastic, StochasticRSI, ADX, ATR, ROC, PSAR,
  WilliamsR, CCI, AwesomeOscillator, MFI, OBV, ADL, ForceIndex, BollingerBands,
  KeltnerChannels, IchimokuCloud, TRIX, KST, SD, HeikinAshi,
} from 'technicalindicators';

export const INDICATOR_CATEGORIES = ['trend', 'momentum', 'volatility', 'volume', 'fundamental'];

const BULL = 1;
const BEAR = -1;
const NEUTRAL = 0;

function last(arr) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined;
}
function prev(arr, back = 1) {
  return Array.isArray(arr) && arr.length > back ? arr[arr.length - 1 - back] : undefined;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function sig(value, note, signal, category, key, label) {
  return { key, label, category, value: value == null ? '—' : value, note, signal };
}
function cmpSignal(a, b, eps = 0) {
  if (a == null || b == null) return null;
  if (a > b * (1 + eps)) return BULL;
  if (a < b * (1 - eps)) return BEAR;
  return NEUTRAL;
}

/** Extract OHLCV column arrays from raw Kite candles ([t,o,h,l,c,v] ascending). */
function toSeries(rawCandles) {
  const open = []; const high = []; const low = []; const close = []; const volume = [];
  for (const c of rawCandles || []) {
    const o = num(c?.[1]); const h = num(c?.[2]); const l = num(c?.[3]);
    const cl = num(c?.[4]); const v = num(c?.[5]);
    if (cl == null) continue;
    open.push(o == null ? cl : o);
    high.push(h == null ? cl : h);
    low.push(l == null ? cl : l);
    close.push(cl);
    volume.push(v == null ? 0 : v);
  }
  return { open, high, low, close, volume };
}

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}
function fmt(v, digits = 2, suffix = '') {
  return v == null ? '—' : `${Number(v).toFixed(digits)}${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Technical engine                                                    */
/* ------------------------------------------------------------------ */

export function computeTechnicalIndicators(rawCandles) {
  const { open, high, low, close, volume } = toSeries(rawCandles);
  const out = [];
  const price = last(close);
  if (price == null || close.length < 30) return out;

  const safe = (fn) => { try { return fn(); } catch { return null; } };

  // --- Trend ---
  for (const period of [20, 50, 100, 200]) {
    if (close.length >= period) {
      const sma = last(safe(() => SMA.calculate({ period, values: close })));
      out.push(sig(fmt(sma), `LTP ${fmt(price)} vs SMA${period}`, cmpSignal(price, sma), 'trend', `sma${period}`, `Price vs SMA${period}`));
    }
  }
  if (close.length >= 200) {
    const sma50 = safe(() => SMA.calculate({ period: 50, values: close }));
    const sma200 = safe(() => SMA.calculate({ period: 200, values: close }));
    out.push(sig(`${fmt(last(sma50))}/${fmt(last(sma200))}`, 'SMA50 vs SMA200 (golden/death cross)', cmpSignal(last(sma50), last(sma200)), 'trend', 'goldencross', 'Golden/Death Cross'));
  }
  if (close.length >= 26) {
    const ema20 = last(safe(() => EMA.calculate({ period: 20, values: close })));
    out.push(sig(fmt(ema20), `LTP vs EMA20`, cmpSignal(price, ema20), 'trend', 'ema20', 'Price vs EMA20'));
    const ema12 = last(safe(() => EMA.calculate({ period: 12, values: close })));
    const ema26 = last(safe(() => EMA.calculate({ period: 26, values: close })));
    out.push(sig(`${fmt(ema12)}/${fmt(ema26)}`, 'EMA12 vs EMA26', cmpSignal(ema12, ema26), 'trend', 'emacross', 'EMA12 vs EMA26'));
  }
  const wma20 = last(safe(() => WMA.calculate({ period: 20, values: close })));
  if (wma20 != null) out.push(sig(fmt(wma20), 'LTP vs WMA20', cmpSignal(price, wma20), 'trend', 'wma20', 'Price vs WMA20'));

  const macd = safe(() => MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }));
  const macdLast = last(macd);
  if (macdLast) {
    out.push(sig(fmt(macdLast.MACD, 3), 'MACD line vs signal', cmpSignal(macdLast.MACD, macdLast.signal), 'trend', 'macd', 'MACD vs Signal'));
    const h0 = macdLast.histogram; const h1 = prev(macd)?.histogram;
    out.push(sig(fmt(h0, 3), 'MACD histogram slope', h0 == null || h1 == null ? null : (h0 > h1 ? BULL : h0 < h1 ? BEAR : NEUTRAL), 'trend', 'macdhist', 'MACD Histogram'));
  }
  const adx = safe(() => ADX.calculate({ high, low, close, period: 14 }));
  const adxLast = last(adx);
  if (adxLast) {
    let s = NEUTRAL;
    if (adxLast.adx >= 20) s = adxLast.pdi > adxLast.mdi ? BULL : BEAR;
    out.push(sig(fmt(adxLast.adx), `ADX ${fmt(adxLast.adx)} (+DI ${fmt(adxLast.pdi)}/-DI ${fmt(adxLast.mdi)})`, s, 'trend', 'adx', 'ADX Directional'));
  }
  const psar = safe(() => PSAR.calculate({ high, low, step: 0.02, max: 0.2 }));
  const psarLast = last(psar);
  if (psarLast != null) out.push(sig(fmt(psarLast), 'Parabolic SAR vs price', price > psarLast ? BULL : price < psarLast ? BEAR : NEUTRAL, 'trend', 'psar', 'Parabolic SAR'));

  const ichi = safe(() => IchimokuCloud.calculate({ high, low, conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 }));
  const ichiLast = last(ichi);
  if (ichiLast && ichiLast.spanA != null && ichiLast.spanB != null) {
    const top = Math.max(ichiLast.spanA, ichiLast.spanB);
    const bot = Math.min(ichiLast.spanA, ichiLast.spanB);
    out.push(sig(`${fmt(bot)}–${fmt(top)}`, 'Price vs Ichimoku cloud', price > top ? BULL : price < bot ? BEAR : NEUTRAL, 'trend', 'ichimoku', 'Ichimoku Cloud'));
  }
  const trix = safe(() => TRIX.calculate({ values: close, period: 15 }));
  const trixLast = last(trix);
  if (trixLast != null) out.push(sig(fmt(trixLast, 4), 'TRIX vs zero line', trixLast > 0 ? BULL : trixLast < 0 ? BEAR : NEUTRAL, 'trend', 'trix', 'TRIX'));

  const ha = safe(() => HeikinAshi.calculate({ open, high, low, close }));
  if (ha && Array.isArray(ha.close) && ha.close.length) {
    const hc = last(ha.close); const ho = last(ha.open);
    out.push(sig(hc > ho ? 'green' : 'red', 'Heikin-Ashi candle', hc > ho ? BULL : hc < ho ? BEAR : NEUTRAL, 'trend', 'heikin', 'Heikin-Ashi Trend'));
  }

  // --- Momentum ---
  const rsi = safe(() => RSI.calculate({ period: 14, values: close }));
  const rsiLast = last(rsi);
  if (rsiLast != null) {
    out.push(sig(fmt(rsiLast), 'RSI(14) level', rsiLast >= 55 ? BULL : rsiLast <= 45 ? BEAR : NEUTRAL, 'momentum', 'rsi', 'RSI Level'));
    const r1 = prev(rsi);
    out.push(sig(fmt(rsiLast), 'RSI slope', r1 == null ? null : (rsiLast > r1 ? BULL : rsiLast < r1 ? BEAR : NEUTRAL), 'momentum', 'rsislope', 'RSI Slope'));
  }
  const stoch = safe(() => Stochastic.calculate({ high, low, close, period: 14, signalPeriod: 3 }));
  const stochLast = last(stoch);
  if (stochLast) {
    let s = cmpSignal(stochLast.k, stochLast.d);
    if (stochLast.k > 80) s = BEAR; else if (stochLast.k < 20) s = BULL;
    out.push(sig(`${fmt(stochLast.k)}/${fmt(stochLast.d)}`, 'Stochastic %K/%D', s, 'momentum', 'stoch', 'Stochastic'));
  }
  const srsi = safe(() => StochasticRSI.calculate({ values: close, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 }));
  const srsiLast = last(srsi);
  if (srsiLast && srsiLast.k != null) {
    let s = NEUTRAL;
    if (srsiLast.k < 20) s = BULL; else if (srsiLast.k > 80) s = BEAR; else s = cmpSignal(srsiLast.k, srsiLast.d);
    out.push(sig(fmt(srsiLast.k), 'Stochastic RSI', s, 'momentum', 'stochrsi', 'Stochastic RSI'));
  }
  for (const [lbl, key, period] of [['1M', 'roc21', 21], ['3M', 'roc63', 63], ['6M', 'roc126', 126], ['12M', 'roc252', 252]]) {
    if (close.length > period) {
      const roc = last(safe(() => ROC.calculate({ period, values: close })));
      out.push(sig(fmt(roc, 2, '%'), `${lbl} rate of change`, roc == null ? null : (roc > 1 ? BULL : roc < -1 ? BEAR : NEUTRAL), 'momentum', key, `Momentum ${lbl}`));
    }
  }
  const willr = last(safe(() => WilliamsR.calculate({ high, low, close, period: 14 })));
  if (willr != null) out.push(sig(fmt(willr), 'Williams %R', willr > -20 ? BEAR : willr < -80 ? BULL : NEUTRAL, 'momentum', 'willr', 'Williams %R'));
  const cci = last(safe(() => CCI.calculate({ high, low, close, period: 20 })));
  if (cci != null) out.push(sig(fmt(cci), 'CCI(20)', cci > 100 ? BULL : cci < -100 ? BEAR : NEUTRAL, 'momentum', 'cci', 'CCI'));
  const ao = safe(() => AwesomeOscillator.calculate({ high, low, fastPeriod: 5, slowPeriod: 34 }));
  const aoLast = last(ao);
  if (aoLast != null) out.push(sig(fmt(aoLast, 3), 'Awesome Oscillator', aoLast > 0 ? BULL : aoLast < 0 ? BEAR : NEUTRAL, 'momentum', 'ao', 'Awesome Oscillator'));
  const kst = safe(() => KST.calculate({ values: close, ROCPer1: 10, ROCPer2: 15, ROCPer3: 20, ROCPer4: 30, SMAROCPer1: 10, SMAROCPer2: 10, SMAROCPer3: 10, SMAROCPer4: 15, signalPeriod: 9 }));
  const kstLast = last(kst);
  if (kstLast && kstLast.kst != null) out.push(sig(fmt(kstLast.kst, 2), 'KST vs signal', cmpSignal(kstLast.kst, kstLast.signal), 'momentum', 'kst', 'KST'));
  const mfi = last(safe(() => MFI.calculate({ high, low, close, volume, period: 14 })));
  if (mfi != null) out.push(sig(fmt(mfi), 'Money Flow Index', mfi < 20 ? BULL : mfi > 80 ? BEAR : (mfi >= 50 ? BULL : BEAR), 'momentum', 'mfi', 'Money Flow Index'));

  // --- Volatility / mean reversion ---
  const bb = safe(() => BollingerBands.calculate({ period: 20, values: close, stdDev: 2 }));
  const bbLast = last(bb);
  if (bbLast) {
    const range = bbLast.upper - bbLast.lower;
    const pb = range ? (price - bbLast.lower) / range : 0.5;
    out.push(sig(fmt(pb * 100, 0, '%'), 'Bollinger %B position', pb > 1 ? BEAR : pb < 0 ? BULL : (pb > 0.5 ? BULL : BEAR), 'volatility', 'bbpb', 'Bollinger %B'));
    const bw = bbLast.middle ? range / bbLast.middle : null;
    const bwPrev = (() => { const p = prev(bb); return p && p.middle ? (p.upper - p.lower) / p.middle : null; })();
    out.push(sig(fmt(bw == null ? null : bw * 100, 1, '%'), 'Bollinger bandwidth (vol expansion)', bw == null || bwPrev == null ? NEUTRAL : NEUTRAL, 'volatility', 'bbw', 'Bollinger Bandwidth'));
  }
  const atr = safe(() => ATR.calculate({ high, low, close, period: 14 }));
  const atrLast = last(atr);
  if (atrLast != null) {
    const atrPrev = prev(atr);
    out.push(sig(fmt(atrLast), 'ATR trend (rising = risk)', atrLast == null || atrPrev == null ? NEUTRAL : (atrLast < atrPrev ? BULL : atrLast > atrPrev ? BEAR : NEUTRAL), 'volatility', 'atr', 'ATR Trend'));
  }
  const kc = safe(() => KeltnerChannels.calculate({ high, low, close, maPeriod: 20, atrPeriod: 10, multiplier: 2, useSMA: false }));
  const kcLast = last(kc);
  if (kcLast) out.push(sig(`${fmt(kcLast.lower)}–${fmt(kcLast.upper)}`, 'Keltner channel position', price > kcLast.upper ? BULL : price < kcLast.lower ? BEAR : NEUTRAL, 'volatility', 'keltner', 'Keltner Channel'));

  // Historical-volatility percentile (lower vol = mild positive for ETFs).
  const rets = [];
  for (let i = 1; i < close.length; i += 1) rets.push((close[i] - close[i - 1]) / close[i - 1]);
  if (rets.length >= 60) {
    const window = rets.slice(-20);
    const sd20 = last(safe(() => SD.calculate({ period: 20, values: rets })));
    const allSd = safe(() => SD.calculate({ period: 20, values: rets })) || [];
    const sorted = [...allSd].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const rank = sorted.length ? sorted.filter((x) => x <= sd20).length / sorted.length : 0.5;
    void window;
    out.push(sig(fmt(rank * 100, 0, '%'), 'Historical-volatility percentile', rank <= 0.4 ? BULL : rank >= 0.8 ? BEAR : NEUTRAL, 'volatility', 'hvpct', 'HV Percentile'));
  }

  // 52W high drawdown & 52W low distance.
  const lookback = close.slice(-252);
  if (lookback.length) {
    const hi = Math.max(...lookback); const lo = Math.min(...lookback);
    const ddHigh = pct(price, hi);
    out.push(sig(fmt(ddHigh, 1, '%'), '52W-high drawdown', ddHigh == null ? null : (ddHigh > -3 ? BULL : ddHigh < -20 ? BEAR : NEUTRAL), 'volatility', 'dd52high', '52W High Proximity'));
    const upLow = pct(price, lo);
    out.push(sig(fmt(upLow, 1, '%'), 'Distance above 52W low', upLow == null ? null : (upLow < 5 ? BEAR : upLow > 40 ? BULL : NEUTRAL), 'volatility', 'dist52low', '52W Low Distance'));
  }

  // --- Volume ---
  const obv = safe(() => OBV.calculate({ close, volume }));
  if (obv && obv.length > 20) {
    const o0 = last(obv); const o1 = obv[obv.length - 21];
    out.push(sig(o0 > o1 ? 'rising' : 'falling', 'OBV 20d trend', o0 > o1 ? BULL : o0 < o1 ? BEAR : NEUTRAL, 'volume', 'obv', 'OBV Trend'));
  }
  if (volume.length >= 20) {
    const avg20 = volume.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const relVol = avg20 ? last(volume) / avg20 : null;
    const up = last(close) >= (prev(close) ?? last(close));
    out.push(sig(fmt(relVol, 2, 'x'), 'Relative volume vs 20d avg', relVol == null ? null : (relVol > 1.2 ? (up ? BULL : BEAR) : NEUTRAL), 'volume', 'relvol', 'Relative Volume'));
  }
  const adl = safe(() => ADL.calculate({ high, low, close, volume }));
  if (adl && adl.length > 20) {
    const a0 = last(adl); const a1 = adl[adl.length - 21];
    out.push(sig(a0 > a1 ? 'rising' : 'falling', 'Accumulation/Distribution 20d', a0 > a1 ? BULL : a0 < a1 ? BEAR : NEUTRAL, 'volume', 'adl', 'A/D Line'));
  }
  const fi = last(safe(() => ForceIndex.calculate({ close, volume, period: 13 })));
  if (fi != null) out.push(sig(fmt(fi, 0), 'Force Index(13)', fi > 0 ? BULL : fi < 0 ? BEAR : NEUTRAL, 'volume', 'forceindex', 'Force Index'));
  // Rolling VWAP relation (20d typical-price VWAP).
  if (close.length >= 20) {
    let pv = 0; let vv = 0;
    for (let i = close.length - 20; i < close.length; i += 1) {
      const tp = (high[i] + low[i] + close[i]) / 3;
      pv += tp * volume[i]; vv += volume[i];
    }
    const vwap = vv ? pv / vv : null;
    out.push(sig(fmt(vwap), 'Price vs 20d VWAP', cmpSignal(price, vwap), 'volume', 'vwap', 'VWAP Relation'));
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Fundamental / risk engine (finapi insights — existing ratings)      */
/* ------------------------------------------------------------------ */

function conclusionSignal(text) {
  const t = String(text || '').toLowerCase();
  if (!t || t === 'none') return null;
  if (/above average|good|low volatility|out ?perform/.test(t)) return BULL;
  if (/below average|poor|high volatility|under ?perform/.test(t)) return BEAR;
  return NEUTRAL;
}
function findTf(metric, tf) {
  const arr = metric?.timeframes;
  if (!Array.isArray(arr)) return null;
  return arr.find((x) => String(x?.timeframe).toLowerCase() === tf) || null;
}

export function computeFundamentalIndicators(insights) {
  const out = [];
  if (!insights) return out;
  const rm = insights.riskMetrics || {};

  for (const tf of ['1y', '3y', '5y']) {
    const r = findTf(rm.returns, tf);
    if (r) {
      const val = num(r.value); const avg = num(r.categoryAverage);
      out.push(sig(fmt(val, 1, '%'), `${tf.toUpperCase()} return vs category avg ${fmt(avg, 1, '%')} — ${r.conclusion || ''}`.trim(), val != null && avg != null ? cmpSignal(val, avg) : conclusionSignal(r.conclusion), 'fundamental', `ret${tf}`, `Return vs Category ${tf.toUpperCase()}`));
    }
  }
  for (const tf of ['1y', '3y']) {
    const s = findTf(rm.sharpRatio, tf);
    if (s) out.push(sig(fmt(num(s.value), 2), `Sharpe ${tf.toUpperCase()} — ${s.conclusion || ''}`.trim(), conclusionSignal(s.conclusion), 'fundamental', `sharpe${tf}`, `Sharpe ${tf.toUpperCase()}`));
    const so = findTf(rm.sortinoRatio, tf);
    if (so) out.push(sig(fmt(num(so.value), 2), `Sortino ${tf.toUpperCase()} — ${so.conclusion || ''}`.trim(), conclusionSignal(so.conclusion), 'fundamental', `sortino${tf}`, `Sortino ${tf.toUpperCase()}`));
  }
  const sd = findTf(rm.riskStandardDeviation, '3y');
  if (sd) out.push(sig(fmt(num(sd.value), 2), `Volatility 3Y — ${sd.conclusion || ''}`.trim(), conclusionSignal(sd.conclusion), 'fundamental', 'std3y', 'Volatility (Std Dev)'));

  // Rolling-return consistency (1Y window).
  const roll1y = Array.isArray(insights.rollingReturns) ? insights.rollingReturns.find((x) => String(x?.timeframe).toUpperCase() === '1Y') : null;
  if (roll1y) {
    const cs = num(roll1y.consistencyScore);
    out.push(sig(fmt(cs, 1), '1Y rolling consistency score', cs == null ? null : (cs > 10 ? BULL : cs < 0 ? BEAR : NEUTRAL), 'fundamental', 'consistency', 'Rolling Consistency'));
    const pr = num(roll1y.positiveRatio);
    out.push(sig(fmt(pr, 0, '%'), '1Y rolling positive-period ratio', pr == null ? null : (pr >= 65 ? BULL : pr <= 45 ? BEAR : NEUTRAL), 'fundamental', 'posratio', 'Positive-Period Ratio'));
  }

  const exp = num(insights.expenseRatio);
  if (exp != null) out.push(sig(fmt(exp, 2, '%'), 'Expense ratio (lower better)', exp <= 0.5 ? BULL : exp >= 1 ? BEAR : NEUTRAL, 'fundamental', 'expense', 'Expense Ratio'));
  const aum = num(insights.aum);
  if (aum != null) out.push(sig(fmt(aum, 0), 'AUM (size / liquidity)', aum >= 500 ? BULL : aum < 50 ? BEAR : NEUTRAL, 'fundamental', 'aum', 'AUM'));
  const beta = findTf(rm.beta, '3y');
  if (beta && num(beta.value) != null) out.push(sig(fmt(num(beta.value), 2), 'Beta vs peers (3Y)', num(beta.value) <= 1 ? BULL : BEAR, 'fundamental', 'beta', 'Beta vs Peers'));

  return out;
}
