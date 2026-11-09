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

export function describeLevels(category, levels, price) {
  if (!levels) return [];
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

export function buildSummary(category, groups, levels, price) {
  const lead = {
    'strong-buy': 'Most indicators are positive.',
    buy: 'Indicators lean positive.',
    hold: 'Indicators are mixed, with no clear edge.',
    sell: 'Indicators lean negative.',
  }[category] || '';

  const parts = [groups.trend?.reading, groups.momentum?.reading].filter(Boolean);
  const detail = parts.length ? `${cap(parts.join('; '))}.` : '';

  let action = '';
  if (levels) {
    if (category === 'buy' || category === 'strong-buy') {
      action = `Reasonable to buy up to ${fmtPrice(levels.buyCap)}; exit if it closes below ${fmtPrice(levels.sellFloor)}.`;
    } else if (category === 'sell') {
      action = `Consider reducing; next support is around ${fmtPrice(levels.sellFloor)}.`;
    } else {
      action = `Wait for a move above ${fmtPrice(levels.holdHigh)} or below ${fmtPrice(levels.holdLow)}.`;
    }
  }
  return [lead, detail, action].filter(Boolean).join(' ');
}

/** One-stop helper for the tooltip. */
export function explainSignal(signal, currentPrice) {
  const price = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : signal.levels?.price;
  const groups = groupLeans(signal.contributions);
  return {
    label: CATEGORY_LABEL[signal.category] || signal.category,
    summary: buildSummary(signal.category, groups, signal.levels, price),
    votes: countVotes(signal.contributions),
    gauge: gaugeInfo(signal.score),
    levels: describeLevels(signal.category, signal.levels, price),
    conflicts: findConflicts(groups),
    groups,
  };
}
