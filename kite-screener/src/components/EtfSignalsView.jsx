import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bookmarkKey } from '../screener/bookmarks';
import { parseInstrumentToken } from '../screener/instrumentToken';
import { useBookmarkSignals } from '../screener/signals/useBookmarkSignals';
import { explainSignal, groupLeans, indicatorRows, signalView } from '../screener/signals/explain';

const GROUPS = [
  { id: 'strong-buy', label: 'Strong Buy', tone: 'strong-buy', hint: 'Most indicators positive, not overbought.' },
  { id: 'buy', label: 'Buy', tone: 'buy', hint: 'Indicators lean positive at a fair price.' },
  { id: 'dip', label: 'Buy on dip', tone: 'buy', hint: 'Positive, but stretched — wait for the pullback level.' },
  { id: 'sell', label: 'Sell', tone: 'sell', hint: 'Indicators lean negative.' },
  { id: 'hold', label: 'Hold', tone: 'hold', hint: 'Mixed, no clear edge.', minor: true },
];

// Column headers for the two price levels, per group.
const LEVEL_HEADS = {
  'strong-buy': ['Buy up to', 'Stop-loss'],
  buy: ['Buy up to', 'Stop-loss'],
  dip: ['Dip target', 'Stop-loss'],
  sell: ['Could fall to', 'Turns + above'],
  hold: ['Breakout above', 'Breakdown below'],
};

const GROUP_ICONS = [
  { key: 'trend', short: 'T', title: 'Trend' },
  { key: 'momentum', short: 'M', title: 'Momentum' },
  { key: 'volatility', short: 'V', title: 'Price range' },
  { key: 'structure', short: 'S', title: 'Key levels' },
  { key: 'volume', short: 'Vol', title: 'Volume' },
];

const LEAN_ARROW = { up: '▲', down: '▼', neutral: '•' };

function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;
}

function pctFrom(price, value) {
  if (!Number.isFinite(price) || !Number.isFinite(value) || price <= 0) return null;
  return ((value - price) / price) * 100;
}

function signClass(v) {
  if (!Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'is-up' : 'is-down';
}

// Attach the watchlist section (Gold, Silver, ...) to each ETF.
function withSections(items) {
  const out = [];
  let section = '';
  for (const item of items || []) {
    if (!item) continue;
    if (item.type === 'separator') { section = item.label || ''; continue; }
    if (!item.tradingsymbol && !item.symbol) continue;
    out.push({ item, section });
  }
  return out;
}

function groupOf(signal, view) {
  if (view.dip) return 'dip';
  if (signal.category === 'strong-buy') return 'strong-buy';
  if (signal.category === 'buy') return 'buy';
  if (signal.category === 'sell') return 'sell';
  return 'hold';
}

function levelPair(groupId, signal, view) {
  const l = signal.levels || {};
  if (groupId === 'dip') return [view.dip?.target?.value, view.dip?.floor];
  if (groupId === 'buy' || groupId === 'strong-buy') return [l.buyCap, l.sellFloor];
  if (groupId === 'sell') return [l.sellFloor, l.holdHigh];
  return [l.holdHigh, l.holdLow];
}

const SORTERS = {
  symbol: (r) => r.symbol,
  section: (r) => r.section,
  ltp: (r) => r.price,
  day: (r) => r.dayPct,
  score: (r) => r.score,
  l1: (r) => r.l1Pct,
  l2: (r) => r.l2Pct,
  rsi: (r) => r.rsi,
  adx: (r) => r.adx,
};

export default function EtfSignalsView({ embedded, etfItems, liveTicks, onVisibleTokens }) {
  const [scan, setScan] = useState(false);
  const [forceKey, setForceKey] = useState(0);
  const [activeGroup, setActiveGroup] = useState('strong-buy');
  const [expanded, setExpanded] = useState(null);
  const [sort, setSort] = useState({ key: 'score', dir: -1 });

  const entries = useMemo(() => withSections(etfItems), [etfItems]);
  const plainItems = useMemo(() => entries.map((e) => e.item), [entries]);

  const tokensCallbackRef = useRef(onVisibleTokens);
  tokensCallbackRef.current = onVisibleTokens;
  useEffect(() => {
    const tokens = plainItems.map((i) => parseInstrumentToken(i.instrument_token)).filter(Boolean);
    tokensCallbackRef.current?.(tokens);
    return () => tokensCallbackRef.current?.([]);
  }, [plainItems]);

  const { signals, loading, progress } = useBookmarkSignals(plainItems, {
    enabled: embedded,
    fetchMissing: scan,
    concurrency: 3,
    refreshKey: forceKey,
  });

  const rowsByGroup = useMemo(() => {
    const out = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
    let missing = 0;
    for (const { item, section } of entries) {
      const signal = signals[bookmarkKey(item)];
      if (!signal || !signal.category) { missing += 1; continue; }
      const token = parseInstrumentToken(item.instrument_token);
      const tick = token ? liveTicks?.[token] : null;
      const live = Number(tick?.last_price);
      const price = Number.isFinite(live) && live > 0 ? live : signal.levels?.price;
      const view = signalView(signal, groupLeans(signal.contributions), price);
      const groupId = groupOf(signal, view);
      const [l1, l2] = levelPair(groupId, signal, view);
      const dayPct = Number(tick?.change_percent);
      out[groupId].push({
        key: bookmarkKey(item),
        symbol: item.tradingsymbol || item.symbol,
        name: item.name || '',
        section,
        signal,
        view,
        price,
        dayPct: tick && Number.isFinite(dayPct) ? dayPct : null,
        score: signal.score,
        l1,
        l2,
        l1Pct: pctFrom(price, l1),
        l2Pct: pctFrom(price, l2),
        rsi: signal.readings?.rsi ?? null,
        adx: signal.readings?.adx ?? null,
        leans: groupLeans(signal.contributions),
      });
    }
    return { out, missing };
  }, [entries, signals, liveTicks]);

  const activeRows = useMemo(() => {
    const list = [...(rowsByGroup.out[activeGroup] || [])];
    const get = SORTERS[sort.key] || SORTERS.score;
    list.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * sort.dir;
      return (av - bv) * sort.dir;
    });
    return list;
  }, [rowsByGroup, activeGroup, sort]);

  const analyzed = entries.length - rowsByGroup.missing;
  const activeMeta = GROUPS.find((g) => g.id === activeGroup);
  const [h1, h2] = LEVEL_HEADS[activeGroup];

  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'symbol' || key === 'section' ? 1 : -1 }));
  const th = (key, label, extra = '') => (
    <th
      className={`etf-sig-th${extra}${sort.key === key ? ' is-sorted' : ''}`}
      onClick={() => sortBy(key)}
      title="Sort"
    >
      {label}{sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div className="dashboard-view etf-sig-view">
      <div className="etf-sig-toolbar">
        <span className="etf-sig-title">ETF Signals</span>
        <span className="etf-sig-meta">
          {loading
            ? `Analyzing ${progress.done}/${progress.total}…`
            : `${analyzed}/${entries.length} analyzed · daily candles, cached 6h`}
        </span>
        <button
          type="button"
          className="etf-sig-btn"
          disabled={loading || !embedded}
          onClick={() => setScan(true)}
          title={rowsByGroup.missing ? `Analyze ${rowsByGroup.missing} ETFs not in cache` : 'All ETFs analyzed'}
        >
          ⚡ Analyze{rowsByGroup.missing ? ` (${rowsByGroup.missing})` : ''}
        </button>
        <button
          type="button"
          className="etf-sig-btn etf-sig-btn-icon"
          disabled={loading || !embedded}
          onClick={() => { setScan(true); setForceKey((k) => k + 1); }}
          title="Re-analyze all ETFs (ignores cache)"
        >
          ⟳
        </button>
      </div>

      {loading && progress.total > 0 && (
        <div className="etf-sig-progress">
          <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}

      <div className="etf-sig-cards">
        {GROUPS.map((g) => {
          const rows = rowsByGroup.out[g.id];
          const dipCounts = g.id === 'dip'
            ? rows.reduce((acc, r) => { acc[r.view.dip.state] = (acc[r.view.dip.state] || 0) + 1; return acc; }, {})
            : null;
          return (
            <button
              key={g.id}
              type="button"
              className={`etf-sig-card etf-sig-card-${g.tone}${activeGroup === g.id ? ' is-active' : ''}${g.minor ? ' is-minor' : ''}`}
              onClick={() => { setActiveGroup(g.id); setExpanded(null); }}
              title={g.hint}
            >
              <span className="etf-sig-card-label">{g.label}</span>
              <span className="etf-sig-card-count">{rows.length}</span>
              {dipCounts && (
                <span className="etf-sig-card-sub">
                  <span title="Still above the dip target">⏳ {dipCounts.waiting || 0}</span>
                  <span title="Pulled back into the dip zone">✅ {dipCounts.reached || 0}</span>
                  <span title="Fell through the stop-loss">⛔ {dipCounts.broken || 0}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="etf-sig-table-wrap">
        {analyzed === 0 && !loading ? (
          <div className="etf-sig-empty">
            No ETFs analyzed yet. Click <strong>⚡ Analyze</strong> to fetch daily history for {entries.length} ETFs
            (one request each, cached for 6 hours).
          </div>
        ) : activeRows.length === 0 ? (
          <div className="etf-sig-empty">No ETFs in <strong>{activeMeta.label}</strong> right now.</div>
        ) : (
          <table className="etf-sig-table">
            <thead>
              <tr>
                {th('symbol', 'ETF')}
                {th('section', 'Section')}
                {th('ltp', 'LTP', ' num')}
                {th('day', 'Day', ' num')}
                <th>Signal</th>
                {th('score', 'Score', ' num')}
                {th('l1', h1, ' num')}
                {th('l2', h2, ' num')}
                {th('rsi', 'RSI', ' num')}
                {th('adx', 'ADX', ' num')}
                <th title="Indicator groups: Trend, Momentum, Price range, Key levels, Volume">Groups</th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((r) => {
                const isOpen = expanded === r.key;
                return (
                  <Fragment key={r.key}>
                    <tr
                      className={`etf-sig-row${isOpen ? ' is-open' : ''}`}
                      onClick={() => setExpanded(isOpen ? null : r.key)}
                    >
                      <td className="etf-sig-sym">
                        <span className="etf-sig-caret">{isOpen ? '▾' : '▸'}</span>
                        <strong>{r.symbol}</strong>
                        {r.name && <span className="etf-sig-name">{r.name}</span>}
                      </td>
                      <td className="etf-sig-section">{r.section}</td>
                      <td className="num">{fmtNum(r.price)}</td>
                      <td className={`num ${signClass(r.dayPct)}`}>{fmtPct(r.dayPct)}</td>
                      <td><span className={`signal-tag signal-${r.view.tone}`}>{r.view.label.toUpperCase()}</span></td>
                      <td className={`num ${signClass(r.score)}`}>{fmtNum(r.score)}</td>
                      <td className="num">
                        {fmtNum(r.l1)}
                        <span className={`etf-sig-pct ${signClass(r.l1Pct)}`}>{fmtPct(r.l1Pct, 1)}</span>
                      </td>
                      <td className="num">
                        {fmtNum(r.l2)}
                        <span className={`etf-sig-pct ${signClass(r.l2Pct)}`}>{fmtPct(r.l2Pct, 1)}</span>
                      </td>
                      <td className={`num${r.rsi >= 70 ? ' is-down' : r.rsi <= 30 ? ' is-up' : ''}`}>{fmtNum(r.rsi, 1)}</td>
                      <td className="num">{fmtNum(r.adx, 1)}</td>
                      <td className="etf-sig-leans">
                        {GROUP_ICONS.map((g) => {
                          const lean = r.leans[g.key];
                          if (!lean) return null;
                          return (
                            <span
                              key={g.key}
                              className={`etf-sig-lean lean-${lean.lean}`}
                              title={`${g.title}: ${lean.reading}`}
                            >
                              {g.short}{LEAN_ARROW[lean.lean]}
                            </span>
                          );
                        })}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="etf-sig-detail-row">
                        <td colSpan={11}>
                          <EtfSignalDetail row={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EtfSignalDetail({ row }) {
  const ex = useMemo(() => explainSignal(row.signal, row.price), [row.signal, row.price]);
  const indicators = useMemo(() => indicatorRows(row.signal), [row.signal]);
  const groups = Object.values(ex.groups);

  return (
    <div className="etf-sig-detail">
      <div className="etf-sig-detail-top">
        <div className="etf-sig-detail-col">
          <div className="etf-sig-detail-head">
            <span className={`signal-tag signal-${ex.tone}`}>{ex.label.toUpperCase()}</span>
            <span>Score {fmtNum(row.signal.score)} · {ex.votes.buy} buy / {ex.votes.sell} sell / {ex.votes.neutral} neutral</span>
          </div>
          <p className="etf-sig-summary">{ex.summary}</p>
          {ex.conflicts.length > 0 && (
            <ul className="etf-sig-warnings">
              {ex.conflicts.map((c) => <li key={c}>⚠ {c}</li>)}
            </ul>
          )}
        </div>

        <table className="etf-sig-mini">
          <thead><tr><th>Level</th><th className="num">Price</th><th className="num">From LTP</th><th>Based on</th></tr></thead>
          <tbody>
            {ex.levels.map((l) => (
              <tr key={l.label}>
                <td>{l.label}</td>
                <td className="num">{l.value}</td>
                <td className={`num ${l.pctSign > 0 ? 'is-up' : l.pctSign < 0 ? 'is-down' : ''}`}>{l.pct}</td>
                <td className="etf-sig-muted">{l.source}</td>
              </tr>
            ))}
            {ex.levels.length === 0 && <tr><td colSpan={4} className="etf-sig-muted">No levels</td></tr>}
          </tbody>
        </table>

        <table className="etf-sig-mini">
          <thead><tr><th>Group</th><th className="num">Lean</th><th>Reading</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td>{g.label}</td>
                <td className={`num lean-${g.lean}`}>{fmtPct(g.ratio * 100, 0)}</td>
                <td className={`lean-${g.lean}`}>{g.reading}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <table className="etf-sig-ind">
        <thead>
          <tr>
            <th>Indicator</th>
            <th>Group</th>
            <th>Value</th>
            <th>Vote</th>
            <th className="num" title="Effective weight (contrarian indicators are damped in strong trends)">Weight</th>
            <th className="num" title="Share of the final score">Impact</th>
          </tr>
        </thead>
        <tbody>
          {indicators.map((i) => (
            <tr key={i.id}>
              <td>{i.label}</td>
              <td className="etf-sig-muted">{i.group}</td>
              <td className="etf-sig-value">{i.reading}</td>
              <td className={i.verdict === 'Buy' ? 'is-up' : i.verdict === 'Sell' ? 'is-down' : 'etf-sig-muted'}>
                {i.verdict} <span className="etf-sig-muted">({fmtNum(i.vote)})</span>
              </td>
              <td className="num">{fmtNum(i.weight)}</td>
              <td className={`num ${signClass(i.impact)}`}>{fmtNum(i.impact, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
