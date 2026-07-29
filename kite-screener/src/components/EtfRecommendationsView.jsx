import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import ChartPanel from './ChartPanel';
import { hasSession } from '../screener/kiteApi';
import {
  ETF_BUCKETS,
  computeEtfRecommendations,
  getEtfUniverse,
  bestPerBucket,
  VERDICTS,
} from '../screener/etfRecommendations';

const CATEGORY_LABELS = {
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  volume: 'Volume',
  fundamental: 'Fundamental',
};

function verdictClass(verdict) {
  return `etf-verdict etf-verdict-${verdict?.tone || 'flat'}`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}
function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function toChartRow(res) {
  if (!res) return null;
  return {
    tradingsymbol: res.tradingsymbol,
    instrument_token: res.instrument_token,
    last_price: res.lastPrice,
    change_percent: res.dayChange,
    name: res.name,
    exchange: 'NSE',
    segment: 'NSE',
    isin: res.isin || undefined,
  };
}

function VerdictBadge({ verdict, composite }) {
  return (
    <span className={verdictClass(verdict)} title={`Composite score ${composite}`}>
      {verdict?.label || 'Hold'}
    </span>
  );
}

function indRowClass(signal) {
  if (signal > 0) return 'etf-ind-row etf-ind-up';
  if (signal < 0) return 'etf-ind-row etf-ind-down';
  return 'etf-ind-row etf-ind-flat';
}

function signalWord(signal) {
  if (signal > 0) return 'Bullish';
  if (signal < 0) return 'Bearish';
  if (signal === 0) return 'Neutral';
  return 'N/A';
}

function IndicatorBreakdown({ res }) {
  const grouped = useMemo(() => {
    const map = {};
    for (const ind of res.indicators) (map[ind.category] ||= []).push(ind);
    return map;
  }, [res.indicators]);

  return (
    <div className="etf-breakdown">
      <div className="etf-breakdown-scores">
        {Object.entries(res.categoryScores).map(([cat, { score, count }]) => (
          <div key={cat} className="etf-catscore">
            <span className="etf-catscore-label">{CATEGORY_LABELS[cat] || cat}</span>
            <span className={`etf-catscore-val ${score > 0 ? 'cell-up' : score < 0 ? 'cell-down' : ''}`}>
              {Math.round(score)}
            </span>
            <span className="etf-catscore-count">{count} signals</span>
          </div>
        ))}
      </div>
      <div className="etf-ind-grid">
        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat} className="etf-ind-col">
            <div className="etf-ind-col-head">
              {CATEGORY_LABELS[cat] || cat}
              <span className="etf-ind-col-count">{list.length}</span>
            </div>
            <div className="etf-ind-rows">
              {list.map((ind) => (
                <div key={ind.key} className={indRowClass(ind.signal)} title={ind.note || ''}>
                  <span className="etf-ind-dot" />
                  <span className="etf-ind-label">{ind.label}</span>
                  <span className="etf-ind-value">{String(ind.value)}</span>
                  <span className="etf-ind-signal">{signalWord(ind.signal)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!res.hasFundamental && (
        <div className="etf-breakdown-note">
          Fundamental/risk data unavailable for this ETF — verdict from technical signals only.
        </div>
      )}
    </div>
  );
}

export default function EtfRecommendationsView({
  embedded,
  selectedRow,
  selectedRowLive,
  onSelectRow,
}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [bucket, setBucket] = useState('All');
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const progressRef = useRef(0);

  const ready = embedded && hasSession();

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setResults([]);
    progressRef.current = 0;
    setProgress({ done: 0, total: getEtfUniverse().length });

    computeEtfRecommendations({
      signal: controller.signal,
      force: refreshKey > 0,
      onProgress: (partial) => {
        if (controller.signal.aborted) return;
        progressRef.current += 1;
        setResults(partial);
        setProgress((p) => ({ done: progressRef.current, total: p.total || partial.length }));
      },
    })
      .then((all) => {
        if (!controller.signal.aborted) {
          setResults(all);
          setProgress({ done: all.length, total: all.length });
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && err.name !== 'AbortError') {
          setError(err.message || 'Failed to compute ETF recommendations.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [ready, refreshKey]);

  useEffect(() => {
    if (!selectedRow) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onSelectRow?.(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedRow, onSelectRow]);

  const filtered = useMemo(
    () => (bucket === 'All' ? results : results.filter((r) => r.bucket === bucket)),
    [results, bucket],
  );

  const summary = useMemo(() => {
    const counts = {};
    for (const r of filtered) counts[r.verdict.id] = (counts[r.verdict.id] || 0) + 1;
    return counts;
  }, [filtered]);

  const topPicks = useMemo(() => {
    const best = bestPerBucket(results);
    return ETF_BUCKETS.map((b) => best[b]).filter(Boolean).filter((r) => r.composite > 0);
  }, [results]);

  const handleSelect = useCallback((res) => {
    onSelectRow?.(toChartRow(res));
  }, [onSelectRow]);

  if (!ready) {
    return (
      <div className="etf-view">
        <div className="etf-empty">Log in to Kite to load ETF recommendations.</div>
      </div>
    );
  }

  return (
    <div className="etf-view dashboard-view">
      <div className="etf-toolbar">
        <div className="etf-tabs">
          {['All', ...ETF_BUCKETS].map((b) => (
            <button
              key={b}
              type="button"
              className={bucket === b ? 'active' : ''}
              onClick={() => setBucket(b)}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="etf-toolbar-right">
          {loading && (
            <span className="etf-progress">
              Analysing {progress.done}/{progress.total || '…'} ETFs
            </span>
          )}
          <button
            type="button"
            className={`table-refresh-btn${loading ? ' spinning' : ''}`}
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
            title="Recompute recommendations"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="etf-summary-strip">
        {[VERDICTS.STRONG_BUY, VERDICTS.BUY, VERDICTS.HOLD, VERDICTS.SELL, VERDICTS.STRONG_SELL].map((v) => (
          <div key={v.id} className={`etf-summary-item etf-verdict-${v.tone}`}>
            <span className="etf-summary-count">{summary[v.id] || 0}</span>
            <span className="etf-summary-label">{v.label}</span>
          </div>
        ))}
      </div>

      {error && <div className="etf-error">{error}</div>}

      {topPicks.length > 0 && (
        <div className="etf-toppicks">
          <div className="etf-section-head">Top Picks by Category</div>
          <div className="etf-cards">
            {topPicks.map((res) => (
              <button
                key={res.tradingsymbol}
                type="button"
                className="etf-card"
                onClick={() => handleSelect(res)}
              >
                <div className="etf-card-top">
                  <span className="etf-card-bucket">{res.bucket}</span>
                  <VerdictBadge verdict={res.verdict} composite={res.composite} />
                </div>
                <div className="etf-card-symbol">{res.tradingsymbol}</div>
                <div className="etf-card-meta">
                  <span>{fmtPrice(res.lastPrice)}</span>
                  <span className={res.dayChange > 0 ? 'cell-up' : res.dayChange < 0 ? 'cell-down' : ''}>
                    {fmtPct(res.dayChange)}
                  </span>
                </div>
                <div className="etf-card-foot">
                  <span>Score {res.composite}</span>
                  <span>Conf {res.confidence}%</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="etf-table-wrap">
        <table className="etf-table">
          <thead>
            <tr>
              <th>ETF</th>
              <th>Bucket</th>
              <th>Verdict</th>
              <th>Conf</th>
              <th>Score</th>
              <th>LTP</th>
              <th>Chg%</th>
              <th>Signals</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((res) => (
              <Fragment key={res.tradingsymbol}>
                <tr
                  className={selectedRow?.tradingsymbol === res.tradingsymbol ? 'active' : ''}
                >
                  <td className="etf-td-symbol">
                    <button type="button" className="etf-symbol-btn" onClick={() => handleSelect(res)}>
                      {res.tradingsymbol}
                    </button>
                  </td>
                  <td>{res.bucket}</td>
                  <td><VerdictBadge verdict={res.verdict} composite={res.composite} /></td>
                  <td>{res.confidence}%</td>
                  <td className={res.composite > 0 ? 'cell-up' : res.composite < 0 ? 'cell-down' : ''}>
                    {res.composite}
                  </td>
                  <td>{fmtPrice(res.lastPrice)}</td>
                  <td className={res.dayChange > 0 ? 'cell-up' : res.dayChange < 0 ? 'cell-down' : ''}>
                    {fmtPct(res.dayChange)}
                  </td>
                  <td className="etf-td-signals">
                    <span className="cell-up">{res.counts.bull}▲</span>{' '}
                    <span className="cell-down">{res.counts.bear}▼</span>{' '}
                    <span>{res.counts.total}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="etf-expand-btn"
                      onClick={() => setExpanded(expanded === res.tradingsymbol ? null : res.tradingsymbol)}
                      title="Indicator breakdown"
                    >
                      {expanded === res.tradingsymbol ? '▲' : '▼'}
                    </button>
                  </td>
                </tr>
                {expanded === res.tradingsymbol && (
                  <tr className="etf-breakdown-row">
                    <td colSpan={9}><IndicatorBreakdown res={res} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!filtered.length && !loading && (
              <tr><td colSpan={9} className="etf-empty">No ETFs to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="etf-disclaimer">
        For educational/informational use only — not investment advice. Signals are computed
        from historical prices and public fund data and may be delayed or incomplete.
      </div>

      {selectedRow && (
        <div className="dashboard-chart-overlay" role="dialog" aria-modal="true">
          <div className="dashboard-chart-backdrop" onClick={() => onSelectRow?.(null)} />
          <div className="dashboard-chart-panel">
            <button
              type="button"
              className="dashboard-chart-close"
              title="Close chart"
              onClick={() => onSelectRow?.(null)}
            >
              ✕
            </button>
            <ChartPanel row={selectedRowLive || selectedRow} />
          </div>
        </div>
      )}
    </div>
  );
}
