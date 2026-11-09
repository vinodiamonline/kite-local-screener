import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { explainSignal } from '../screener/signals/explain';

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

export function hasSignal(signal) {
  return Boolean(signal && !signal.status && signal.levels);
}

// Renders the hover card describing the signal + the actionable price level(s),
// plus the user's note for the symbol. Either part may be absent.
export default function SignalTooltip({ anchor, symbol, currentPrice, signal, note }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const showSignal = hasSignal(signal);
  const valid = Boolean(anchor && (showSignal || note));

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
  }, [valid, anchor, signal, note]);

  if (!valid) return null;

  // Until measured, render at the naive spot but hidden to avoid a flash in the
  // wrong place; the layout effect fills in `pos` synchronously before paint.
  const style = pos
    ? { top: pos.top, left: pos.left }
    : { top: anchor.bottom + 6, left: Math.min(anchor.left, window.innerWidth - 280), visibility: 'hidden' };

  const noteBlock = note ? (
    <div className={`signal-tt-note${showSignal ? '' : ' signal-tt-note-only'}`}>
      <span className="signal-tt-key">Note</span>
      <div className="signal-tt-note-text">{note}</div>
    </div>
  ) : null;

  if (!showSignal) {
    return createPortal(
      <div ref={ref} className="signal-tooltip signal-tooltip-note" style={style} role="tooltip">
        <div className="signal-tt-head">
          <span className="signal-tt-symbol">{symbol}</span>
        </div>
        {noteBlock}
      </div>,
      document.body,
    );
  }

  const { category, contributions } = signal;
  const ex = explainSignal(signal, Number(currentPrice));
  const groups = groupContributions(contributions, ex.groups);

  return createPortal(
    <div ref={ref} className={`signal-tooltip signal-tooltip-${category}`} style={style} role="tooltip">
      <div className="signal-tt-head">
        <span className="signal-tt-symbol">{symbol}</span>
        <span className={`signal-badge signal-${category}`}>{ex.label.toUpperCase()}</span>
      </div>

      <p className="signal-tt-summary">{ex.summary}</p>

      <div className="signal-tt-gauge" aria-label={`Verdict: ${ex.label}`}>
        <div className="signal-tt-gauge-track">
          {ex.gauge.zones.map((z) => (
            <span key={z.id} className={`signal-tt-gauge-zone zone-${z.id}${z.id === category ? ' is-active' : ''}`} style={{ width: `${z.width}%` }} />
          ))}
          <span className="signal-tt-gauge-marker" style={{ left: `${ex.gauge.marker}%` }} />
        </div>
        <div className="signal-tt-gauge-labels">
          {ex.gauge.zones.map((z) => (
            <span key={z.id} className={z.id === category ? 'is-active' : ''} style={{ width: `${z.width}%` }}>{z.label}</span>
          ))}
        </div>
      </div>

      <div className="signal-tt-votes">
        <span className="vote-chip vote-buy">{ex.votes.buy} Buy</span>
        <span className="vote-chip vote-sell">{ex.votes.sell} Sell</span>
        <span className="vote-chip vote-neutral">{ex.votes.neutral} Neutral</span>
        <span className="signal-tt-scale">of {ex.votes.total} indicators</span>
      </div>

      {ex.conflicts.length > 0 && (
        <div className="signal-tt-conflicts">
          {ex.conflicts.map((text) => (
            <div key={text} className="signal-tt-conflict">⚠ {text}</div>
          ))}
        </div>
      )}

      <div className="signal-tt-levels">
        <div className="signal-tt-row">
          <span className="signal-tt-key">Current price</span>
          <span>{fmt(Number.isFinite(Number(currentPrice)) && currentPrice > 0 ? currentPrice : signal.levels.price)}</span>
        </div>
        {ex.levels.map((row) => (
          <div key={row.label} className="signal-tt-level">
            <div className="signal-tt-row">
              <span className="signal-tt-key">{row.label}</span>
              <span>
                <strong>{row.value}</strong>
                {row.pct && (
                  <span className={`signal-tt-pct ${row.pctSign > 0 ? 'is-buy' : row.pctSign < 0 ? 'is-sell' : ''}`}> {row.pct}</span>
                )}
              </span>
            </div>
            {row.source && <div className="signal-tt-source">from {row.source}</div>}
          </div>
        ))}
      </div>

      {groups.length > 0 && (
        <div className="signal-tt-drivers">
          <div className="signal-tt-drivers-head">
            <span className="signal-tt-key">What each group says</span>
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
              {g.reading && (
                <div className={`signal-tt-group-reading lean-${g.lean}`}>{g.reading}</div>
              )}
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
      {noteBlock}
    </div>,
    document.body,
  );
}

// Group each strategy's signed contribution to the score (vote * weight / Σweight)
// by strategy category, so the tooltip shows *which kinds* of signals drove the
// verdict and by how much. Categories and their strategies are each sorted by
// impact, and negligible ones are dropped to keep the card readable.
function groupContributions(contributions, plainGroups = {}, { maxItemsPerGroup = 3 } = {}) {
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
      label: plainGroups[g.key]?.label || 'Other',
      reading: plainGroups[g.key]?.reading || '',
      lean: plainGroups[g.key]?.lean || 'flat',
      items: g.items
        .sort((a, b) => Math.abs(b.share) - Math.abs(a.share))
        .slice(0, maxItemsPerGroup),
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}
