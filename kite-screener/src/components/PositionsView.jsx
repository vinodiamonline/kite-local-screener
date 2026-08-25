import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchHoldings, fetchPositions, hasSession } from '../screener/kiteApi';
import { bookmarkKey, hasValidInstrumentToken } from '../screener/bookmarks';
import SignalTooltip from './SignalTooltip';
import { useBookmarkSignals } from '../screener/signals/useBookmarkSignals';
import {
  applyTickToHolding,
  applyTickToPosition,
  filterHoldings,
  normalizeHolding,
  normalizePosition,
  splitPositions,
  sumDayPnl,
  sumPnl,
} from '../screener/positions';

function collectTokens(rows) {
  const set = new Set();
  rows.forEach((row) => {
    const token = Number(row?.instrument_token);
    if (hasValidInstrumentToken(row)) set.add(token);
  });
  return Array.from(set);
}

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function fmtNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-';
}

function fmtPlainMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function toneClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'pos-up' : 'pos-down';
}

function fmtTime(date) {
  if (!date) return '';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function fmtPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

const HOLDING_COLUMNS = [
  { key: 'tradingsymbol', label: 'Symbol', align: 'left' },
  { key: 'quantity', label: 'Qty' },
  { key: 'average_price', label: 'Avg' },
  { key: 'last_price', label: 'LTP' },
  { key: 'invested', label: 'Invested' },
  { key: 'current_value', label: 'Cur. val' },
  { key: 'pnl', label: 'P&L' },
  { key: 'change_percent', label: 'Net chg' },
  { key: 'day_change_percent', label: 'Day chg' },
];

const POSITION_COLUMNS = [
  { key: 'tradingsymbol', label: 'Symbol', align: 'left' },
  { key: 'product', label: 'Product' },
  { key: 'quantity', label: 'Qty' },
  { key: 'average_price', label: 'Avg' },
  { key: 'last_price', label: 'LTP' },
  { key: 'change_percent', label: 'Chg%' },
  { key: 'pnl', label: 'P&L' },
];

function rowSelected(selectedRow, row) {
  if (!selectedRow || !row) return false;
  if (selectedRow.instrument_token && row.instrument_token) {
    return Number(selectedRow.instrument_token) === Number(row.instrument_token);
  }
  return selectedRow.tradingsymbol === row.tradingsymbol
    && selectedRow.exchange === row.exchange;
}

export default function PositionsView({
  mode = 'positions',
  embedded,
  liveTicks = {},
  selectedRow,
  onSelectRow,
  onVisibleTokens,
  onCountsChange,
}) {
  const isHoldings = mode === 'holdings';
  const [positions, setPositions] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [error, setError] = useState('');
  const tokensCallbackRef = useRef(onVisibleTokens);
  const countsCallbackRef = useRef(onCountsChange);
  tokensCallbackRef.current = onVisibleTokens;
  countsCallbackRef.current = onCountsChange;

  const ready = embedded && hasSession();

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();

    setLoading(true);
    setError('');

    const fetchPromise = isHoldings
      ? fetchHoldings(controller.signal).then((data) => {
        const rows = filterHoldings((data || []).map(normalizeHolding));
        setHoldings(rows);
        setPositions([]);
        return rows;
      })
      : fetchPositions(controller.signal).then(({ net }) => {
        const rows = (net || []).map(normalizePosition);
        setPositions(rows);
        setHoldings([]);
        return rows;
      });

    fetchPromise
      .then(() => {
        if (!controller.signal.aborted) setLastUpdated(new Date());
      })
      .catch((fetchError) => {
        if (fetchError.name === 'AbortError') return;
        setPositions([]);
        setHoldings([]);
        setError(fetchError.message || `Unable to load ${isHoldings ? 'holdings' : 'positions'}.`);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => controller.abort();
  }, [ready, localRefresh, isHoldings]);

  const handleRefresh = () => {
    if (!ready || refreshing) return;
    setRefreshing(true);
    setLocalRefresh((value) => value + 1);
  };

  const livePositions = useMemo(
    () => positions.map((row) => applyTickToPosition(row, liveTicks[Number(row.instrument_token)])),
    [positions, liveTicks],
  );

  const liveHoldings = useMemo(
    () => holdings.map((row) => applyTickToHolding(row, liveTicks[Number(row.instrument_token)])),
    [holdings, liveTicks],
  );

  const { open, closed } = useMemo(() => splitPositions(livePositions), [livePositions]);

  const visibleRows = isHoldings ? liveHoldings : livePositions;
  const { signals: holdingSignals } = useBookmarkSignals(
    holdings,
    { enabled: embedded && isHoldings, refreshKey: localRefresh },
  );

  useEffect(() => {
    tokensCallbackRef.current?.(collectTokens(visibleRows));
  }, [visibleRows]);

  useEffect(() => {
    if (isHoldings) {
      countsCallbackRef.current?.({ holdingsCount: liveHoldings.length });
      return;
    }
    countsCallbackRef.current?.({ positionCount: livePositions.length });
  }, [isHoldings, livePositions.length, liveHoldings.length]);

  const positionsPnl = useMemo(() => sumPnl(livePositions), [livePositions]);
  const holdingsPnl = useMemo(() => sumPnl(liveHoldings), [liveHoldings]);
  const openPnl = useMemo(() => sumPnl(open), [open]);
  const closedPnl = useMemo(() => sumPnl(closed), [closed]);
  const dayPnl = useMemo(
    () => (isHoldings ? sumDayPnl(liveHoldings) : sumDayPnl(livePositions)),
    [isHoldings, liveHoldings, livePositions],
  );

  const isEmpty = !loading && visibleRows.length === 0 && !error;

  return (
    <main className="table-panel positions-view">
      <div className="positions-toolbar">
        {isHoldings ? (
          <div className="positions-summary positions-summary-2">
            <div className="positions-summary-item">
              <span className="positions-summary-label">Holdings P&amp;L</span>
              <span className={`positions-summary-value ${toneClass(holdingsPnl)}`}>{fmtMoney(holdingsPnl)}</span>
            </div>
            <div className="positions-summary-item">
              <span className="positions-summary-label">Day P&amp;L</span>
              <span className={`positions-summary-value ${toneClass(dayPnl)}`}>{fmtMoney(dayPnl)}</span>
            </div>
          </div>
        ) : (
          <div className="positions-summary positions-summary-3">
            <div className="positions-summary-item">
              <span className="positions-summary-label">Open P&amp;L</span>
              <span className={`positions-summary-value ${toneClass(openPnl)}`}>{fmtMoney(openPnl)}</span>
            </div>
            <div className="positions-summary-item">
              <span className="positions-summary-label">Closed P&amp;L</span>
              <span className={`positions-summary-value ${toneClass(closedPnl)}`}>{fmtMoney(closedPnl)}</span>
            </div>
            <div className="positions-summary-item">
              <span className="positions-summary-label">Day P&amp;L</span>
              <span className={`positions-summary-value ${toneClass(dayPnl)}`}>{fmtMoney(dayPnl)}</span>
            </div>
          </div>
        )}

        <div className="positions-refresh-block">
          {lastUpdated && (
            <span className="positions-updated">Updated {fmtTime(lastUpdated)}</span>
          )}
          <button
            type="button"
            className="positions-refresh-btn"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            title={`Refresh ${isHoldings ? 'holdings' : 'positions'}`}
          >
            <span className={`positions-refresh-icon${refreshing ? ' spinning' : ''}`}>↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {loading && visibleRows.length === 0 && (
        <div className="positions-empty">
          Loading {isHoldings ? 'holdings' : 'positions'}…
        </div>
      )}

      {isEmpty && (
        <div className="positions-empty">
          {isHoldings ? 'No holdings in demat.' : 'No positions for today.'}
        </div>
      )}

      {!isHoldings && open.length > 0 && (
        <PortfolioTable
          title={`Open Positions (${open.length})`}
          rows={open}
          kind="position"
          selectedRow={selectedRow}
          onSelectRow={onSelectRow}
        />
      )}

      {!isHoldings && closed.length > 0 && (
        <PortfolioTable
          title={`Closed Positions (${closed.length})`}
          rows={closed}
          kind="position"
          selectedRow={selectedRow}
          onSelectRow={onSelectRow}
          closed
        />
      )}

      {isHoldings && liveHoldings.length > 0 && (
        <PortfolioTable
          title={`Holdings (${liveHoldings.length})`}
          rows={liveHoldings}
          kind="holding"
          selectedRow={selectedRow}
          onSelectRow={onSelectRow}
          signalsByKey={holdingSignals}
        />
      )}
    </main>
  );
}

function PortfolioTable({
  title,
  rows,
  kind,
  selectedRow,
  onSelectRow,
  closed = false,
  signalsByKey = null,
}) {
  const groupPnl = sumPnl(rows);
  const isHolding = kind === 'holding';
  const [sort, setSort] = useState({ key: 'pnl', direction: 'desc' });
  const [hoverSignal, setHoverSignal] = useState(null);

  const columns = useMemo(
    () => (isHolding ? HOLDING_COLUMNS : POSITION_COLUMNS),
    [isHolding],
  );

  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((left, right) => {
      const leftValue = getPortfolioSortValue(left, sort.key, isHolding);
      const rightValue = getPortfolioSortValue(right, sort.key, isHolding);

      if (typeof leftValue === 'string' || typeof rightValue === 'string') {
        return direction * String(leftValue).localeCompare(String(rightValue), 'en', { numeric: true });
      }

      if (leftValue == null && rightValue == null) return 0;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      return direction * (leftValue - rightValue);
    });
  }, [rows, sort, isHolding]);

  return (
    <section className={`positions-section${closed ? ' positions-section-closed' : ''}`}>
      {hoverSignal && (
        <SignalTooltip
          anchor={hoverSignal.rect}
          symbol={hoverSignal.symbol}
          currentPrice={hoverSignal.currentPrice}
          signal={hoverSignal.signal}
        />
      )}
      <div className="positions-section-head">
        <h3>{title}</h3>
        <span className={`positions-section-pnl ${toneClass(groupPnl)}`}>{fmtMoney(groupPnl)}</span>
      </div>
      <div className="positions-table-wrap">
        <table className="positions-table">
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort.key === column.key;
                const indicator = active ? (sort.direction === 'asc' ? '▲' : '▼') : '';
                return (
                  <th
                    key={column.key}
                    className={`sortable${column.align === 'left' ? ' align-left' : ''}`}
                    onClick={() => togglePortfolioSort(column.key, setSort)}
                  >
                    <span>{column.label}</span>
                    <span className="sort-indicator">{indicator}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const selected = rowSelected(selectedRow, row);
              const pnlTone = toneClass(row.pnl);

              return (
                <tr
                  key={`${kind}-${row.tradingsymbol}-${row.product || 'CNC'}-${index}`}
                  className={[
                    'positions-row',
                    pnlTone ? `row-${pnlTone}` : '',
                    selected ? 'selected-row' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelectRow?.(row)}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={getPortfolioCellClass(column, row, isHolding)}
                    >
                      {renderPortfolioCell(row, column, isHolding, signalsByKey, setHoverSignal)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function togglePortfolioSort(key, setSort) {
  setSort((current) => {
    if (current.key !== key) return { key, direction: 'desc' };
    if (current.direction === 'desc') return { key, direction: 'asc' };
    return { key: null, direction: 'desc' };
  });
}

function getPortfolioSortValue(row, key, isHolding) {
  if (key === 'tradingsymbol') {
    return String(row?.tradingsymbol || '').toUpperCase();
  }

  if (key === 'quantity') {
    const qty = isHolding ? row?.holding_quantity : row?.quantity;
    const n = Number(qty);
    return Number.isFinite(n) ? n : null;
  }

  if (key === 'product') {
    return String(row?.product || '').toUpperCase();
  }

  const value = row?.[key];
  if (value === undefined || value === null || value === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function getPortfolioCellClass(column, row, isHolding) {
  const classes = [];
  if (column.align === 'left') classes.push('align-left');
  if (column.key !== 'tradingsymbol' && column.key !== 'product') classes.push('num-cell');

  if (column.key === 'quantity') {
    const qty = isHolding ? row.holding_quantity : row.quantity;
    if (qty > 0) classes.push('pos-up');
    else if (qty < 0) classes.push('pos-down');
  }

  if (column.key === 'pnl') {
    const tone = toneClass(row.pnl);
    if (tone) classes.push('positions-pnl', tone);
  }

  if (column.key === 'change_percent' || column.key === 'day_change_percent') {
    const tone = toneClass(row[column.key]);
    if (tone) classes.push(tone);
  }

  return classes.join(' ');
}

function renderPortfolioCell(row, column, isHolding, signalsByKey, setHoverSignal) {
  if (column.key === 'tradingsymbol') {
    const qty = isHolding ? row.holding_quantity : row.quantity;
    const signal = signalsByKey?.[bookmarkKey(row)];
    return (
      <span className="positions-symbol">
        <span className={`positions-qty-dot ${
          qty > 0 ? 'long' : qty < 0 ? 'short' : 'flat'
        }`} />
        <span
          className="positions-ticker"
          onMouseEnter={signal && !signal.status ? (event) => setHoverSignal({
            rect: event.currentTarget.getBoundingClientRect(),
            symbol: row.tradingsymbol,
            currentPrice: Number(row.last_price),
            signal,
          }) : undefined}
          onMouseLeave={signal && !signal.status ? () => setHoverSignal(null) : undefined}
        >
          {row.tradingsymbol}
        </span>
        <span className="positions-exchange">{row.exchange}</span>
        {isHolding && row.collateral_quantity > 0 && (
          <span className="positions-badge positions-badge-pledge" title="Pledged as collateral">
            P {row.collateral_quantity}
          </span>
        )}
        {isHolding && row.t1_quantity > 0 && (
          <span className="positions-badge positions-badge-t1" title="T+1 quantity">
            T+1 {row.t1_quantity}
          </span>
        )}
      </span>
    );
  }

  if (column.key === 'product') {
    return <span className="positions-product">{row.product}</span>;
  }

  if (column.key === 'quantity') {
    return isHolding ? row.holding_quantity : row.quantity;
  }

  if (column.key === 'pnl') return fmtMoney(row.pnl);

  if (column.key === 'invested' || column.key === 'current_value') {
    return fmtPlainMoney(row[column.key]);
  }

  if (column.key === 'change_percent' || column.key === 'day_change_percent') {
    return fmtPercent(row[column.key]);
  }

  return fmtNum(row[column.key]);
}
