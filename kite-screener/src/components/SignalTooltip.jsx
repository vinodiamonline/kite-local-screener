import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { STRATEGY_CATEGORIES } from '../screener/signals/registry';

const CAT_LABEL = { 'strong-buy': 'STRONG BUY', buy: 'BUY', hold: 'HOLD', sell: 'SELL' };
const MARGIN = 8;

function fmt(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtScore(value) {
  const score = Number(value) * 100;
  if (!Number.isFinite(score)) return '—';
  return `${score > 0 ? '+' : ''}${score.toFixed(0)}`;
}

function fmtMaxScore(value) {
  const score = Math.abs(Number(value) * 100);
  return Number.isFinite(score) ? score.toFixed(0) : '—';
}

// Renders the hover card describing the signal + the actionable price level(s).
export default function SignalTooltip({ anchor, symbol, currentPrice, signal }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const valid = Boolean(anchor && signal && !signal.status && signal.levels);

  // After render, measure the card and keep it inside the viewport: prefer below
  // the badge, flip above when it would overrun the bottom, then clamp so the
  // card is always fully visible (matters for rows near the bottom of the list).
  useLayoutEffect(() => {
    if (!valid) return;
    const el = ref.current;
    if (!el) return;
    const { height, width } = el.getBoundingClientRect();

    let top = anchor.bottom + 6;
    if (top + height + MARGIN > window.innerHeight) {
      const above = anchor.top - height - 6;
      top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - height - MARGIN);
    }

    let left = Math.min(anchor.left, window.innerWidth - width - MARGIN);
    left = Math.max(MARGIN, left);

    setPos({ top, left });
  }, [valid, anchor, signal]);

  if (!valid) return null;
  const { category, score, levels, contributions } = signal;

  let headline = null;
  if (category === 'buy' || category === 'strong-buy') {
    headline = <><span className="signal-tt-key">Buy up to</span> <strong>{fmt(levels.buyCap)}</strong></>;
  } else if (category === 'sell') {
    headline = <><span className="signal-tt-key">Sell down to</span> <strong>{fmt(levels.sellFloor)}</strong></>;
  } else {
    headline = <><span className="signal-tt-key">Hold range</span> <strong>{fmt(levels.holdLow)} – {fmt(levels.holdHigh)}</strong></>;
  }

  const groups = groupContributions(contributions);

  // Until measured, render at the naive spot but hidden to avoid a flash in the
  // wrong place; the layout effect fills in `pos` synchronously before paint.
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { top: anchor.bottom + 6, left: Math.min(anchor.left, window.innerWidth - 280), visibility: 'hidden' };

  return createPortal(
    <div ref={ref} className={`signal-tooltip signal-tooltip-${category}`} style={style} role="tooltip">
      <div className="signal-tt-head">
        <span className="signal-tt-symbol">{symbol}</span>
        <span className={`signal-badge signal-${category}`}>{CAT_LABEL[category]}</span>
      </div>
      <div className="signal-tt-row">
        <span className="signal-tt-key">Current</span>
        <span>{fmt(currentPrice ?? levels.price)}</span>
      </div>
      <div className="signal-tt-row signal-tt-headline">{headline}</div>
      <div className="signal-tt-row signal-tt-score">
        <span className="signal-tt-key">Score</span>
        <span>{`${score > 0 ? '+' : ''}${(score * 100).toFixed(0)}`} <span className="signal-tt-scale">(−100…+100)</span></span>
      </div>
      {groups.length > 0 && (
        <div className="signal-tt-drivers">
          <div className="signal-tt-drivers-head">
            <span className="signal-tt-key">How we got here</span>
            <span className="signal-tt-scale">{contributions.length} signals</span>
          </div>
          {groups.map((g) => (
            <div key={g.key} className="signal-tt-group">
              <div className="signal-tt-group-head">
                <span className="signal-tt-group-label">{g.label}</span>
                <span className="signal-tt-driver-bar">
                  <span
                    className={`signal-tt-driver-fill ${g.net >= 0 ? 'is-buy' : 'is-sell'}`}
                    style={{ width: `${Math.min(100, Math.abs(g.net) * 100)}%` }}
                  />
                </span>
                <span className={`signal-tt-driver-val ${g.net >= 0 ? 'is-buy' : 'is-sell'}`}>
                  {fmtScore(g.net)}
                  <span className="signal-tt-scale"> / ±{fmtMaxScore(g.max)}</span>
                </span>
              </div>
              {g.items.map((d) => (
                <div key={d.id} className="signal-tt-driver">
                  <span className="signal-tt-driver-label" title={d.label}>{d.label}</span>
                  <span className={`signal-tt-driver-val ${d.share >= 0 ? 'is-buy' : 'is-sell'}`}>
                    {`${d.share >= 0 ? '+' : ''}${(d.share * 100).toFixed(0)}`}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

// Group each strategy's signed contribution to the score (vote * weight / Σweight)
// by strategy category, so the tooltip shows *which kinds* of signals drove the
// verdict and by how much. Categories and their strategies are each sorted by
// impact, and negligible ones are dropped to keep the card readable.
function groupContributions(contributions, { maxItemsPerGroup = 3 } = {}) {
  if (!Array.isArray(contributions) || contributions.length === 0) return [];
  const totalWeight = contributions.reduce((sum, c) => sum + (c.weight || 0), 0);
  if (!totalWeight) return [];

  const byCat = new Map();
  for (const c of contributions) {
    const share = (c.vote * c.weight) / totalWeight;
    const key = c.category || 'other';
    if (!byCat.has(key)) byCat.set(key, { key, net: 0, weight: 0, items: [] });
    const g = byCat.get(key);
    g.net += share;
    g.weight += c.weight || 0;
    if (Math.abs(share) > 0.0005) g.items.push({ ...c, share });
  }

  return [...byCat.values()]
    .filter((g) => Math.abs(g.net) > 0.0005 || g.items.length > 0)
    .map((g) => ({
      ...g,
      max: g.weight / totalWeight,
      label: STRATEGY_CATEGORIES[g.key] || 'Other',
      items: g.items
        .sort((a, b) => Math.abs(b.share) - Math.abs(a.share))
        .slice(0, maxItemsPerGroup),
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}
