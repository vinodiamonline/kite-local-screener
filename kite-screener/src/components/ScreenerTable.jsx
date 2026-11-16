import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_COLUMNS } from '../screener/presets';
import { bookmarkKey } from '../screener/bookmarks';
import BookmarkSearch from './BookmarkSearch';import MarketCapTag from './MarketCapTag';
import ScreenerFilters from './ScreenerFilters';
import SymbolContextMenu from './SymbolContextMenu';
import SignalTooltip, { hasSignal } from './SignalTooltip';
import { signalView } from '../screener/signals/explain';
import { getSymbolNote, useSymbolNotes } from '../screener/symbolNotes';

export default function ScreenerTable({
  screener,
  rows,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  error,
  selectedRow,
  onSelectRow,
  requestBody,
  total,
  isBookmarked,
  onToggleBookmark,
  onHideSymbol,
  onUnhideSymbol,
  onRemoveFromWatchlist,
  onAddBookmark,
  isInActiveList,
  isHiddenView = false,
  onReorderRows,
  liveQuotes = false,
  quotesLoading = false,
  showFilters = false,
  marketCapId,
  setMarketCapId,
  sector,
  setSector,
  limit,
  setLimit,
  hideSectorFilter = false,
  onRefresh,
  signalsByKey = null,
  onAnalyzeSignals,
  signalsLoading = false,
  signalsProgress,
}) {
  const columns = screener.columns || DEFAULT_COLUMNS;
  const canReorderRows = Boolean((screener.isBookmarks || screener.isWatchlist) && onReorderRows);
  const scrollRef = useRef(null);
  const rowRefs = useRef(new Map());
  const sentinelRef = useRef(null);  const [sort, setSort] = useState({ key: null, direction: 'desc' });
  const [contextMenu, setContextMenu] = useState(null);
  const [dragFromIndex, setDragFromIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const [hoverSignal, setHoverSignal] = useState(null);
  useSymbolNotes();

  // Watchlists/bookmarks support manual drag-reorder, but only while unsorted.
  // Once a sort column is active, we sort and disable dragging.
  const reorderActive = canReorderRows && !sort.key;

  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;

    const direction = sort.direction === 'asc' ? 1 : -1;
    const sortGroup = (group) => [...group].sort((left, right) => {
      const leftValue = getSortValue(left, sort.key);
      const rightValue = getSortValue(right, sort.key);

      if (typeof leftValue === 'string' || typeof rightValue === 'string') {
        return direction * String(leftValue).localeCompare(String(rightValue), 'en', { numeric: true });
      }

      if (leftValue == null && rightValue == null) return 0;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      return direction * (leftValue - rightValue);
    });

    if (!rows.some(isSeparatorRow)) return sortGroup(rows);

    const grouped = [];
    let currentGroup = [];
    rows.forEach((row) => {
      if (isSeparatorRow(row)) {
        if (currentGroup.length) grouped.push(...sortGroup(currentGroup));
        currentGroup = [];
        grouped.push(row);
        return;
      }
      currentGroup.push(row);
    });
    if (currentGroup.length) grouped.push(...sortGroup(currentGroup));
    return grouped;
  }, [rows, sort]);

  useEffect(() => {
    setSort({ key: null, direction: screener.order === 'asc' ? 'asc' : 'desc' });
  }, [screener.id, screener.order]);

  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore || loading || loadingMore || !onLoadMore) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root, rootMargin: '120px' },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, onLoadMore, sortedRows.length]);

  const stockRowCount = useMemo(
    () => rows.filter((row) => !isSeparatorRow(row)).length,
    [rows],
  );

  const statusText = loading
    ? 'Loading'
    : screener.isSectorGroup
      ? `${stockRowCount} stocks`
      : liveQuotes
        ? quotesLoading
          ? 'Updating quotes'
          : `${rows.length} live`
        : total
          ? `${rows.length} / ${total}`
          : `${rows.length} rows`;

  const refreshBusy = liveQuotes ? quotesLoading : loading;

  const goToSavedItem = useCallback((item) => {
    const key = bookmarkKey(item);
    const row = rows.find((entry) => !isSeparatorRow(entry) && bookmarkKey(entry) === key);
    if (!row) return;

    onSelectRow?.(row);

    requestAnimationFrame(() => {
      const node = rowRefs.current.get(key);
      const container = scrollRef.current;
      if (!node || !container) return;

      const top = node.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop;
      container.scrollTo({ top: Math.max(0, top - 48), behavior: 'smooth' });
    });
  }, [rows, onSelectRow]);

  return (    <main className="table-panel">
      <SymbolContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onHideSymbol={!isHiddenView ? onHideSymbol : undefined}
        onUnhideSymbol={isHiddenView ? onUnhideSymbol : undefined}
        onRemoveFromWatchlist={onRemoveFromWatchlist}
        isBookmarked={isBookmarked}
        onToggleBookmark={!isHiddenView ? onToggleBookmark : undefined}
      />
      {hoverSignal && (
        <SignalTooltip
          anchor={hoverSignal.rect}
          symbol={hoverSignal.symbol}
          currentPrice={hoverSignal.currentPrice}
          signal={hoverSignal.signal}
          note={getSymbolNote(hoverSignal.symbol)}
        />
      )}
      {!(screener.isWatchlist || screener.isBookmarks) && (
        <div className="panel-title">
          <div>
            <div className="eyebrow">{screener.category}</div>
            <h2>{screener.title}</h2>
            <p>{screener.description}</p>
          </div>
          <div className="panel-title-actions">
            {!liveQuotes && <div className="status-pill">{statusText}</div>}
            {onRefresh && (
              <button
                type="button"
                className={`table-refresh-btn${refreshBusy ? ' spinning' : ''}`}
                onClick={onRefresh}
                disabled={refreshBusy}
                title="Refresh table"
                aria-label="Refresh table"
              >
                ↻
              </button>
            )}
          </div>
        </div>
      )}

      {showFilters && (
        <div className="screener-filters-row">
          <ScreenerFilters
            marketCapId={marketCapId}
            setMarketCapId={setMarketCapId}
            sector={sector}
            setSector={setSector}
            limit={limit}
            setLimit={setLimit}
            hideSectorFilter={hideSectorFilter}
          />
        </div>
      )}

      {liveQuotes && (
        <div className="table-toolbar">
          {!isHiddenView && (
            <BookmarkSearch
              onAdd={onAddBookmark}
              onGoTo={goToSavedItem}
              isBookmarked={isInActiveList}
            />
          )}
          {onAnalyzeSignals && (
            <button
              type="button"
              className={`table-refresh-btn table-analyze-btn${signalsLoading ? ' is-busy' : ''}`}
              onClick={onAnalyzeSignals}
              disabled={signalsLoading}
              title={signalsLoading
                ? `Analyzing signals ${signalsProgress?.done ?? 0}/${signalsProgress?.total ?? 0}…`
                : 'Analyze Buy / Sell signals (fetches only symbols not analyzed in the last 6h)'}
              aria-label="Analyze signals"
            >
              {signalsLoading && signalsProgress?.total ? (
                <span className="table-analyze-pct">
                  {Math.floor((signalsProgress.done / signalsProgress.total) * 100)}%
                </span>
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M1 9h3l2-5 3 9 2-6 1.5 2H15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              className={`table-refresh-btn${refreshBusy ? ' spinning' : ''}`}
              onClick={onRefresh}
              disabled={refreshBusy}
              title="Refresh table"
              aria-label="Refresh table"
            >
              ↻
            </button>
          )}
        </div>
      )}

      {!liveQuotes && requestBody && (
        <details className="query-preview">
          <summary>API query</summary>
          <pre>{JSON.stringify(requestBody, null, 2)}</pre>
        </details>
      )}

      {error && <div className="error-box">{error}</div>}

      <div className="table-scroll" ref={scrollRef}>
        <table className="screener-table">
          <thead>
            <tr>
              {columns.map((column) => {
                const active = sort.key === column.key;
                const indicator = active ? (sort.direction === 'asc' ? '▲' : '▼') : '';

                const isSymbol = column.type === 'symbol';
                return (
                  <th
                    key={column.key}
                    className={`sortable${isSymbol ? ' align-left' : ''}`}
                    onClick={() => toggleSort(column.key, setSort)}
                  >
                    <span>{column.label}</span>
                    {isSymbol && liveQuotes && (
                      <span className="th-status">({statusText})</span>
                    )}
                    <span className="sort-indicator">{indicator}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!loading && sortedRows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty-cell">
                  {liveQuotes
                    ? (screener.isHidden
                      ? 'No hidden symbols. Right-click any symbol and choose Hide symbol.'
                      : screener.isBookmarks
                      ? 'No bookmarks yet. Search above or star any symbol from another screener.'
                      : 'No symbols yet. Search above to add to this watchlist.')
                    : 'No rows loaded yet.'}
                </td>
              </tr>
            )}

            {sortedRows.map((row, index) => {
              if (isSeparatorRow(row)) {
                return (
                  <tr key={`separator-${row.label}-${index}`} className="watchlist-separator-row">
                    <td colSpan={columns.length}>
                      {row.label}
                    </td>
                  </tr>
                );
              }

              const symbol = getSymbol(row) || `row-${index}`;
              const selected = selectedRow === row || getSymbol(selectedRow) === symbol;
              const change = getChangeValue(row);
              const signal = signalsByKey?.[bookmarkKey(row)];
              const note = getSymbolNote(row);
              const hasHoverCard = hasSignal(signal) || Boolean(note);

              return (
                <tr
                  key={`${symbol}-${index}`}
                  ref={(node) => {
                    const rowKey = bookmarkKey(row);
                    if (node) rowRefs.current.set(rowKey, node);
                    else rowRefs.current.delete(rowKey);
                  }}
                  className={[                    selected ? 'selected-row' : '',
                    dragOverIndex === index ? 'row-drop-target' : '',
                    dragFromIndex === index ? 'row-dragging' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelectRow(row)}
                  onDragOver={(event) => {
                    if (!reorderActive || dragFromIndex == null) return;
                    event.preventDefault();
                    setDragOverIndex(index);
                  }}
                  onDrop={(event) => {
                    if (!reorderActive || dragFromIndex == null) return;
                    event.preventDefault();
                    if (dragFromIndex !== index) onReorderRows(dragFromIndex, index);
                    setDragFromIndex(null);
                    setDragOverIndex(null);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, row });
                  }}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={getCellClassName(column, row, change)}
                    >
                      {column.type === 'symbol' ? (
                        <span className="symbol-wrap">
                          {reorderActive && (
                            <span
                              className="row-drag-handle"
                              draggable
                              title="Drag to reorder"
                              onClick={(event) => event.stopPropagation()}
                              onDragStart={(event) => {
                                event.stopPropagation();
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', String(index));
                                setDragFromIndex(index);
                                setDragOverIndex(index);
                              }}
                              onDragEnd={() => {
                                setDragFromIndex(null);
                                setDragOverIndex(null);
                              }}
                            >
                              ⋮⋮
                            </span>
                          )}
                          {!isHiddenView && (
                            <button
                              type="button"
                              className={`bookmark-star${isBookmarked?.(row) ? ' active' : ''}`}
                              title={isBookmarked?.(row) ? 'Remove bookmark' : 'Add bookmark'}
                              onClick={(event) => {
                                event.stopPropagation();
                                onToggleBookmark?.(row);
                              }}
                            >
                              {isBookmarked?.(row) ? '★' : '☆'}
                            </button>
                          )}
                          <span className="symbol-text">
                            <span className="symbol-line">
                              <span
                                className={`symbol-ticker${getSymbolTone(change)}`}
                                onMouseEnter={hasHoverCard ? (event) => setHoverSignal({
                                  rect: event.currentTarget.getBoundingClientRect(),
                                  symbol: getSymbol(row),
                                  currentPrice: Number(row?.last_price),
                                  signal,
                                }) : undefined}
                                onMouseLeave={hasHoverCard ? () => setHoverSignal(null) : undefined}
                              >
                                {getSymbol(row)}
                              </span>
                              {note && <span className="symbol-note-mark" aria-label="Has note">✎</span>}
                              {hasSignal(signal) && signal.category !== 'hold' && (() => {
                                const view = signalView(signal, undefined, Number(row?.last_price));
                                return (
                                  <span className={`signal-tag signal-${view.tone}`}>
                                    {view.label.toUpperCase()}
                                  </span>
                                );
                              })()}
                              <MarketCapTag marketCap={row?.market_cap} />
                            </span>
                            {getCompanyName(row) && (
                              <span className="symbol-name">{getCompanyName(row)}</span>
                            )}
                          </span>
                        </span>
                      ) : (
                        formatCell(row, column)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {hasMore && (
          <div className="table-sentinel" ref={sentinelRef}>
            {loadingMore ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </main>
  );
}

function toggleSort(key, setSort) {
  setSort((current) => {
    if (current.key !== key) return { key, direction: 'desc' };
    if (current.direction === 'desc') return { key, direction: 'asc' };
    return { key: null, direction: 'desc' };
  });
}

function isSeparatorRow(row) {
  return row?.type === 'separator';
}

function getSortValue(row, key) {
  if (key === 'distance_52w_high') {
    const ltp = Number(row?.last_price);
    const high = Number(row?.week_52_high);
    if (!ltp || !high) return null;
    return ((high - ltp) / high) * 100;
  }

  const value = row?.[key];
  if (value === undefined || value === null || value === '') return null;

  if (key === 'tradingsymbol') return String(value).toUpperCase();

  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function getChangeValue(row) {
  const change = Number(row?.change_percent ?? row?.change);
  return Number.isFinite(change) ? change : null;
}

function getSymbolTone(change) {
  if (change == null || change === 0) return '';
  return change > 0 ? ' up' : ' down';
}

function getCellClassName(column, row, change) {
  const classes = [];

  if (column.type === 'symbol') classes.push('symbol-cell');
  if (column.type === 'number' || column.type === 'percent' || column.type === 'compact') {
    classes.push('num-cell');
  }

  const tone = getTone(column, row, change);
  if (tone) classes.push(tone);

  return classes.join(' ');
}

function getTone(column, row, change) {
  if (column.key === 'change_percent' || column.key === 'change') {
    if (change == null || change === 0) return '';
    return change > 0 ? 'cell-up' : 'cell-down';
  }

  if (column.key === 'last_price' && change != null && change !== 0) {
    return change > 0 ? 'cell-up' : 'cell-down';
  }

  if (column.type === 'percent' || column.type === 'derived52HighDistance') {
    const value = column.type === 'derived52HighDistance'
      ? getSortValue(row, 'distance_52w_high')
      : Number(row?.[column.key]);

    if (!Number.isFinite(value) || value === 0) return '';
    return value > 0 ? 'cell-up' : 'cell-down';
  }

  return '';
}

export function getSymbol(row) {
  return row?.tradingsymbol || row?.symbol || '';
}

export function getCompanyName(row) {
  const name = row?.name?.trim();
  const symbol = getSymbol(row);
  if (!name || name.toUpperCase() === symbol.toUpperCase()) return '';
  return name;
}

export function formatCell(row, column) {
  if (column.type === 'derived52HighDistance') {
    const value = getSortValue(row, 'distance_52w_high');
    if (value == null) return '-';
    return `${value.toFixed(2)}%`;
  }

  const value = row?.[column.key];
  if (value === undefined || value === null || value === '') return '-';

  if (column.type === 'percent') {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const sign = number > 0 ? '+' : '';
    return `${sign}${number.toFixed(2)}%`;
  }

  if (column.type === 'number') return formatNumber(value);
  if (column.type === 'compact') return compactNumber(value);
  return String(value);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(value);
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (Math.abs(number) >= 100000) return `${(number / 100000).toFixed(1)}L`;
  if (Math.abs(number) >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return formatNumber(number);
}
