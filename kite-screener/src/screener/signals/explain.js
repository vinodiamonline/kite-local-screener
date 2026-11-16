// Turns a raw signal (score + per-indicator votes + levels) into plain-English
// pieces for the hover card: a summary, vote counts, gauge position, group
// readings, price levels with % distance, and warnings when groups disagree.

import { SCORE_THRESHOLDS, STRATEGY_CATEGORIES } from './registry';

// A single indicator vote beyond this counts as Buy / Sell rather than Neutral.
const VOTE_CUTOFF = 0.15;
// A group's net lean (as a share of its max possible) beyond this is a clear lean.
const LEAN_CUTOFF = 0.25;

// Gauge display range; real scores are averages, so they rarely reach ±1.
const GAUGE_MIN = -0.5;
const GAUGE_MAX = 0.7;

export const CATEGORY_LABEL = { 'strong-buy': 'Strong Buy', buy: 'Buy', hold: 'Hold', sell: 'Sell' };

// Plain names + what a positive / negative / neutral lean means for each group.
const GROUP_INFO = {
  trend: {
    label: 'Direction',
    hint: 'Moving averages, MACD, ADX…',
    up: 'uptrend',
    down: 'downtrend',
    flat: 'no clear trend',
  },
  momentum: {
    label: 'Overbought / oversold',
    hint: 'RSI, Stochastic, MFI…',
    up: 'oversold, room to rise',
    down: 'overbought, looks stretched',
    flat: 'neither overbought nor oversold',
  },
  volatility: {
    label: 'Price vs normal range',
    hint: 'Bollinger, Keltner, Donchian…',
    up: 'bands favour buying',
    down: 'bands favour selling',
    flat: 'within its normal range',
  },
  structure: {
    label: 'Support & resistance',
    hint: 'Breakouts, pivots, swing levels…',
    up: 'at the cheaper end of its range',
    down: 'at the pricier end, near resistance',
    flat: 'mid-range between levels',
  },
  volume: {
    label: 'Buying pressure',
    hint: 'OBV, VWAP, volume flow…',
    up: 'buyers in control',
    down: 'sellers in control',
    flat: 'no clear pressure',
  },
};

const SOURCE_LABEL = {
  resistance: 'resistance',
  support: 'support',
  'upper-band': 'upper Bollinger band',
  'lower-band': 'lower Bollinger band',
  'recent-high': 'recent swing high',
  'recent-low': 'recent swing low',
  volatility: 'typical daily range',
  '20-day-avg': '20-day average',
  '50-day-avg': '50-day average',
};

function fmtPrice(value) {
  return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pctFrom(price, level) {
  if (!Number.isFinite(price) || !Number.isFinite(level) || price === 0) return null;
  return ((level - price) / price) * 100;
}

function fmtPct(pct) {
  if (pct == null) return '';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function leanOf(ratio) {
  if (ratio > LEAN_CUTOFF) return 'up';
  if (ratio < -LEAN_CUTOFF) return 'down';
  return 'flat';
}

export function countVotes(contributions = []) {
  let buy = 0;
  let sell = 0;
  let neutral = 0;
  for (const c of contributions) {
    if (c.vote > VOTE_CUTOFF) buy += 1;
    else if (c.vote < -VOTE_CUTOFF) sell += 1;
    else neutral += 1;
  }
  return { buy, sell, neutral, total: contributions.length };
}

/** Net lean per group as a ratio in [-1, +1] of what that group could contribute. */
export function groupLeans(contributions = []) {
  const byCat = {};
  for (const c of contributions) {
    const key = c.category || 'other';
    if (!byCat[key]) byCat[key] = { net: 0, weight: 0 };
    byCat[key].net += c.vote * (c.weight || 0);
    byCat[key].weight += c.weight || 0;
  }
  const out = {};
  for (const [key, g] of Object.entries(byCat)) {
    const ratio = g.weight ? g.net / g.weight : 0;
    const info = GROUP_INFO[key];
    const lean = leanOf(ratio);
    out[key] = {
      key,
      ratio,
      lean,
      label: info?.label || STRATEGY_CATEGORIES[key] || 'Other',
      hint: info?.hint || '',
      reading: info ? info[lean] : lean === 'up' ? 'positive' : lean === 'down' ? 'negative' : 'neutral',
    };
  }
  return out;
}

export function gaugeInfo(score) {
  const span = GAUGE_MAX - GAUGE_MIN;
  const at = (v) => ((Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, v)) - GAUGE_MIN) / span) * 100;
  const sellEnd = at(SCORE_THRESHOLDS.sell);
  const holdEnd = at(SCORE_THRESHOLDS.buy);
  const buyEnd = at(SCORE_THRESHOLDS.strongBuy);
  return {
    marker: at(Number(score) || 0),
    zones: [
      { id: 'sell', label: 'Sell', width: sellEnd },
      { id: 'hold', label: 'Hold', width: holdEnd - sellEnd },
      { id: 'buy', label: 'Buy', width: buyEnd - holdEnd },
      { id: 'strong-buy', label: 'Strong', width: 100 - buyEnd },
    ],
  };
}

export function findConflicts(groups) {
  const lean = (k) => groups[k]?.lean;
  const out = [];
  if (lean('trend') === 'up' && lean('momentum') === 'down') {
    out.push('Uptrend, but overbought: better to buy on a dip than chase.');
  }
  if (lean('trend') === 'down' && lean('momentum') === 'up') {
    out.push('Oversold, so a bounce is possible, but the main trend is still down.');
  }
  if (lean('trend') === 'up' && lean('volume') === 'down') {
    out.push('Price is rising but volume is weak, so the move may lack conviction.');
  }
  if (lean('trend') === 'down' && lean('volume') === 'up') {
    out.push('Buyers are stepping in despite the downtrend; watch for a reversal.');
  }
  if (lean('trend') === 'up' && lean('structure') === 'down') {
    out.push('Uptrend, but price is at the pricier end of its range, near resistance.');
  }
  return out;
}

function levelRow(label, value, source, price) {
  if (!Number.isFinite(value)) return null;
  const pct = pctFrom(price, value);
  return {
    label,
    value: fmtPrice(value),
    pct: fmtPct(pct),
    pctSign: pct == null ? 0 : Math.sign(pct),
    source: SOURCE_LABEL[source] || '',
  };
}

// Pullback entry for a "Buy on dip", fixed at the time of the signal (so it
// doesn't slide down with the live price): the nearest of support / 20-day
// average that is a real pullback (≥ 0.5 ATR) but no deeper than 2 ATR.
function dipTarget(levels) {
  if (!levels || !Number.isFinite(levels.price)) return null;
  const p = levels.price;
  const atrV = Number.isFinite(levels.atr) && levels.atr > 0 ? levels.atr : p * 0.02;
  const candidates = [
    { value: levels.holdLow, source: levels.holdLowSource },
    { value: levels.sma20, source: '20-day-avg' },
  ].filter(({ value }) => Number.isFinite(value) && value <= p - 0.5 * atrV && value >= p - 2 * atrV);
  if (candidates.length) return candidates.reduce((a, b) => (b.value > a.value ? b : a));
  return { value: p - 1.5 * atrV, source: 'volatility' };
}

// Below this the pullback has turned into a breakdown: stop-loss, or the 50-day
// average when that sits under the dip target (trend no longer intact).
function dipFloor(levels, target) {
  const floors = [levels.sellFloor];
  if (Number.isFinite(levels.sma50) && levels.sma50 < target.value) floors.push(levels.sma50);
  const valid = floors.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

/**
 * Live dip state for a "Buy on dip" signal:
 *   waiting – still above the dip target
 *   reached – pulled back into the dip zone with the uptrend intact
 *   broken  – fell through the stop-loss / 50-day average
 */
export function dipState(signal, groups, livePrice) {
  const reason = dipReason(signal, groups);
  const levels = signal?.levels;
  const target = reason ? dipTarget(levels) : null;
  if (!target) return null;
  const live = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : levels.price;
  const floor = dipFloor(levels, target);
  let state = 'waiting';
  if (floor != null && live <= floor) state = 'broken';
  else if (live <= target.value) state = 'reached';
  return { state, reason, target, floor };
}

export function describeLevels(category, levels, price, dip = null) {
  if (!levels) return [];
  if (dip && (category === 'buy' || category === 'strong-buy')) {
    const { target, floor, state } = dip;
    const floorSource = floor === levels.sma50 ? '50-day-avg' : levels.sellFloorSource;
    if (state === 'broken') {
      return [floor != null && levelRow('Broke below', floor, floorSource, price)].filter(Boolean);
    }
    const rows = [levelRow(state === 'reached' ? 'Dip zone below' : 'Buy on a dip toward', target.value, target.source, price)];
    if (floor != null && floor < target.value * 0.995) {
      rows.push(levelRow('Stop-loss below', floor, floorSource, price));
    }
    return rows.filter(Boolean);
  }
  const rows = category === 'buy' || category === 'strong-buy'
    ? [
      levelRow('Buy up to', levels.buyCap, levels.buyCapSource, price),
      levelRow('Stop-loss below', levels.sellFloor, levels.sellFloorSource, price),
    ]
    : category === 'sell'
      ? [
        levelRow('Could fall to', levels.sellFloor, levels.sellFloorSource, price),
        levelRow('Turns positive above', levels.holdHigh, levels.holdHighSource, price),
      ]
      : [
        levelRow('Breakout above', levels.holdHigh, levels.holdHighSource, price),
        levelRow('Breakdown below', levels.holdLow, levels.holdLowSource, price),
      ];
  return rows.filter(Boolean);
}

function cap(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function buildSummary(category, groups, levels, price, extreme = null, dip = null) {
  const lead = {
    'strong-buy': 'Most indicators are positive.',
    buy: 'Indicators lean positive.',
    hold: 'Indicators are mixed, with no clear edge.',
    sell: 'Indicators lean negative.',
  }[category] || '';

  const parts = [groups.trend?.reading, groups.momentum?.reading].filter(Boolean);
  // After a dip the momentum reading (from the last candle) is stale; keep only the trend.
  const afterDip = dip && dip.state !== 'waiting';
  const detail = afterDip
    ? (dip.state === 'reached' && groups.trend?.reading ? `${cap(groups.trend.reading)}.` : '')
    : parts.length ? `${cap(parts.join('; '))}.` : '';

  const isBuy = category === 'buy' || category === 'strong-buy';
  let action = '';
  if (levels) {
    if (isBuy && dip?.state === 'reached') {
      action = `Dip reached: price has pulled back to ${fmtPrice(dip.target.value)} or below while the uptrend holds, a better entry.${dip.floor != null ? ` Exit if it closes below ${fmtPrice(dip.floor)}.` : ''}`;
    } else if (isBuy && dip?.state === 'broken') {
      action = `The pullback went too deep (below ${fmtPrice(dip.floor)}), so the uptrend may be breaking. Don't buy yet; wait for the signal to refresh.`;
    } else if (isBuy && dip) {
      action = `Good stock to own, but ${dip.reason}: wait for a dip toward ${fmtPrice(dip.target.value)} before buying.`;
    } else if (isBuy) {
      action = `Reasonable to buy up to ${fmtPrice(levels.buyCap)}; exit if it closes below ${fmtPrice(levels.sellFloor)}.`;
    } else if (category === 'sell' && extreme === 'oversold') {
      action = `Already oversold, so a bounce is likely; avoid selling into panic. Next support is around ${fmtPrice(levels.sellFloor)}.`;
    } else if (category === 'sell') {
      action = `Consider reducing; next support is around ${fmtPrice(levels.sellFloor)}.`;
    } else {
      action = `Wait for a move above ${fmtPrice(levels.holdHigh)} or below ${fmtPrice(levels.holdLow)}.`;
    }
  }
  return [lead, detail, action].filter(Boolean).join(' ');
}

/**
 * Why a Buy is a poor entry at today's price, or null. Matches the
 * "overbought" / "near resistance" warnings so the label never contradicts them.
 */
export function dipReason(signal, groups = groupLeans(signal?.contributions)) {
  const { category, extreme } = signal || {};
  if (category !== 'buy' && category !== 'strong-buy') return null;
  if (extreme === 'overbought') return 'it is at an extreme high right now';
  const overbought = groups.momentum?.lean === 'down';
  const nearResistance = groups.structure?.lean === 'down';
  if (overbought && nearResistance) return 'it looks overbought and is near resistance';
  if (overbought) return 'it looks overbought';
  if (nearResistance) return 'it is near resistance';
  return null;
}

const DIP_VIEW = {
  waiting: { label: 'Buy on dip', tone: 'buy' },
  reached: { label: 'Dip reached', tone: 'strong-buy' },
  broken: { label: 'Dip too deep', tone: 'hold' },
};

/** Badge text + colour, reflecting the live dip state for "Buy on dip" signals. */
export function signalView(signal, groups, livePrice) {
  const dip = dipState(signal, groups ?? groupLeans(signal?.contributions), livePrice);
  if (dip) return { ...DIP_VIEW[dip.state], dip };
  return { label: CATEGORY_LABEL[signal?.category] || signal?.category, tone: signal?.category, dip: null };
}

export function signalLabel(signal, groups, livePrice) {
  return signalView(signal, groups, livePrice).label;
}

function extremeWarning(signal) {
  const isBuy = signal.category === 'buy' || signal.category === 'strong-buy';
  if (isBuy && signal.extreme === 'overbought') {
    return signal.capped
      ? 'Extended: trend is strong, but RSI or price is at an extreme high. Held back from Strong Buy; wait for a dip.'
      : 'Extended: RSI or price is at an extreme high. Wait for a dip rather than chasing.';
  }
  if (signal.extreme === 'oversold' && signal.category === 'sell') {
    return 'Oversold: RSI or price is at an extreme low, so a short-term bounce is likely.';
  }
  return null;
}

/** One-stop helper for the tooltip. */
export function explainSignal(signal, currentPrice) {
  const price = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : signal.levels?.price;
  const groups = groupLeans(signal.contributions);
  const view = signalView(signal, groups, price);
  const { dip } = view;
  const warning = extremeWarning(signal);
  // The extreme warning already says "overbought/oversold", so drop the generic one.
  // Once the dip is reached/broken the "don't chase" warnings no longer apply.
  const conflicts = (warning
    ? [warning, ...findConflicts(groups).filter((t) => !/overbought|Oversold/.test(t))]
    : findConflicts(groups)
  ).filter((t) => !dip || dip.state === 'waiting' || !/overbought|resistance|Extended/.test(t));
  return {
    label: view.label,
    tone: view.tone,
    summary: buildSummary(signal.category, groups, signal.levels, price, signal.extreme, dip),
    votes: countVotes(signal.contributions),
    gauge: gaugeInfo(signal.score),
    levels: describeLevels(signal.category, signal.levels, price, dip),
    conflicts,
    groups,
  };
}


// --- Detailed indicator table ----------------------------------------------
const n = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
const rs = (v) => (v == null || !Number.isFinite(v) ? '—' : fmtPrice(v));
const pc = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);

// What each strategy looked at, as a short human-readable string.
const READING_FORMAT = {
  'sma-strategy': (r) => `Price ${rs(r.price)} · SMA20 ${rs(r.sma20)} · SMA50 ${rs(r.sma50)}`,
  'ema-crossover': (r) => `EMA12 ${rs(r.ema12)} vs EMA26 ${rs(r.ema26)}`,
  'ma-crossover': (r) => `SMA50 ${rs(r.sma50)} vs SMA200 ${rs(r.sma200)}`,
  'ema-ribbon': (r) => `EMA9 ${rs(r.ema9)} vs EMA21 ${rs(r.ema21)}`,
  'trend-following': (r) => `EMA50 ${rs(r.ema50)}, 20-day slope ${pc(r.ema50Slope)}`,
  'long-term-trend': (r) => `Price vs SMA200 ${rs(r.sma200)}: ${pc(r.sma200 ? ((r.price - r.sma200) / r.sma200) * 100 : null)}`,
  macd: (r) => `MACD ${n(r.macd, 2)} · Signal ${n(r.macdSignal, 2)} · Hist ${n(r.macdHist, 2)}`,
  'adx-trend': (r) => `ADX ${n(r.adx)} · +DI ${n(r.plusDI)} · −DI ${n(r.minusDI)}`,
  'parabolic-sar': (r) => `SAR ${rs(r.psar)} (price ${r.psar != null && r.price > r.psar ? 'above' : 'below'})`,
  ichimoku: (r) => `Cloud ${rs(Math.min(r.ichiSpanA, r.ichiSpanB))}–${rs(Math.max(r.ichiSpanA, r.ichiSpanB))} · Tenkan ${rs(r.tenkan)} / Kijun ${rs(r.kijun)}`,
  rsi: (r) => `RSI ${n(r.rsi)} (30 oversold · 70 overbought)`,
  stochastic: (r) => `%K ${n(r.stochK)} · %D ${n(r.stochD)} (20 / 80)`,
  'williams-r': (r) => `%R ${n(r.williams)} (−80 / −20)`,
  cci: (r) => `CCI ${n(r.cci, 0)} (±100 extreme)`,
  momentum: (r) => `10-day ROC ${pc(r.roc)}`,
  mfi: (r) => `MFI ${n(r.mfi)} (20 / 80)`,
  bollinger: (r) => `%B ${n(r.pctB, 2)} · band ${rs(r.bollLower)}–${rs(r.bollUpper)}`,
  keltner: (r) => `Channel ${rs(r.keltnerLower)}–${rs(r.keltnerUpper)}`,
  'donchian-breakout': (r) => `20-day range ${rs(r.donchianLower)}–${rs(r.donchianUpper)}`,
  'atr-trend': (r) => `15-day move ${pc(r.change15)} · ATR ${rs(r.atr)}`,
  breakout: (r) => `Swing low ${rs(r.swingLow)} · high ${rs(r.swingHigh)}`,
  'support-resistance': (r) => `Support ${rs(r.support)} · Resistance ${rs(r.resistance)}`,
  pivot: (r) => `Pivot ${rs(r.pivot)}`,
  'mean-reversion': (r) => `${n(r.zScore, 2)} std-dev from SMA20 ${rs(r.sma20)}`,
  vwap: (r) => `20-day VWAP ${rs(r.vwap)}`,
  obv: (r) => `OBV 20-day change ${pc(r.obvChange)}`,
  'accumulation-distribution': (r) => `A/D 20-day change ${pc(r.adChange)}`,
  'volume-price-trend': (r) => `VPT 20-day change ${pc(r.vptChange)}`,
  'volume-momentum': (r) => `Volume ${n(r.volRatio, 2)}× its 20-day average`,
};

/**
 * Per-indicator rows: what it read, how it voted, its weight, and its share of
 * the final score. Sorted by group, then by impact.
 */
export function indicatorRows(signal) {
  const list = signal?.contributions || [];
  const total = list.reduce((s, c) => s + (c.weight || 0), 0) || 1;
  const order = Object.keys(STRATEGY_CATEGORIES);
  return list
    .map((c) => {
      const fmt = READING_FORMAT[c.id];
      let reading = '—';
      try { reading = signal.readings && fmt ? fmt(signal.readings) : '—'; } catch { reading = '—'; }
      return {
        id: c.id,
        label: c.label,
        group: GROUP_INFO[c.category]?.label || STRATEGY_CATEGORIES[c.category] || 'Other',
        groupKey: c.category,
        reading,
        vote: c.vote,
        verdict: c.vote > VOTE_CUTOFF ? 'Buy' : c.vote < -VOTE_CUTOFF ? 'Sell' : 'Neutral',
        weight: c.weight,
        impact: (c.vote * (c.weight || 0)) / total,
      };
    })
    .sort((a, b) => (order.indexOf(a.groupKey) - order.indexOf(b.groupKey)) || (Math.abs(b.impact) - Math.abs(a.impact)));
}