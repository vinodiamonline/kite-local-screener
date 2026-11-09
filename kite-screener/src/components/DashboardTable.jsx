import { useEffect, useMemo, useRef, useState } from 'react';
import MarketCapTag from './MarketCapTag';
import SymbolContextMenu from './SymbolContextMenu';
import SignalTooltip from './SignalTooltip';
import { getSymbol, getCompanyName } from './ScreenerTable';
import { getSymbolNote, useSymbolNotes } from '../screener/symbolNotes';

function sepKey(label) {
  return String(label || '').trim().toLowerCase();
}

const COLUMNS = [
  { key: 'tradingsymbol', label: 'Symbol', type: 'symbol' },
  { key: 'change_percent', label: 'Chg%', type: 'percent' },
  { key: 'last_price', label: 'LTP', type: 'number' },
];

function isSeparatorRow(row) {
  return row?.type === 'separator';
}

function getSortValue(row, key) {
  const value = row?.[key];
  if (value === undefined || value === null || value === '') return null;
  if (key === 'tradingsymbol') return String(value).toUpperCase();
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function toneClass(change) {
  const n = Number(change);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'cell-up' : 'cell-down';
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value == null || value === '' ? '-' : String(value);
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export default function DashboardTable({
  title,
  subtitle,
  rows,
  loading = false,
  error = '',
  selectedRow,
  onSelectRow,
  isBookmarked,
  onToggleBookmark,
  onHideSymbol,
  grouped = false,
  showCapTag = true,
  registerJump,
}) {
  const [sort, setSort] = useState({ key: null, direction: 'desc' });
  const [contextMenu, setContextMenu] = useState(null);
  const [hoverNote, setHoverNote] = useState(null);
  useSymbolNotes();
  const scrollRef = useRef(null);
  const sepRefs = useRef({});

  const jumpToSector = (label) => {
    const node = sepRefs.current[sepKey(label)];
    const container = scrollRef.current;
    if (!node || !container) return;
    const top = node.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop;
    container.scrollTo({ top, behavior: 'smooth' });
  };

  useEffect(() => {
    if (typeof registerJump === 'function') {
      registerJump(jumpToSector);
      return () => registerJump(null);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerJump]);

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

    const out = [];
    let bucket = [];
    rows.forEach((row) => {
      if (isSeparatorRow(row)) {
        if (bucket.length) out.push(...sortGroup(bucket));
        bucket = [];
        out.push(row);
        return;
      }
      bucket.push(row);
    });
    if (bucket.length) out.push(...sortGroup(bucket));
    return out;
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: 'desc' };
      if (current.direction === 'desc') return { key, direction: 'asc' };
      return { key: null, direction: 'desc' };
    });
  };

  const dataCount = rows.filter((row) => !isSeparatorRow(row)).length;

  return (
    <section className="dash-table">
      <SymbolContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onHideSymbol={onHideSymbol}
        isBookmarked={isBookmarked}
        onToggleBookmark={onToggleBookmark}
      />
      {hoverNote && (
        <SignalTooltip
          anchor={hoverNote.rect}
          symbol={hoverNote.symbol}
          note={getSymbolNote(hoverNote.symbol)}
        />
      )}
      <header className="dash-table-head">
        <div className="dash-table-title">
          <span>{title}</span>
          <span className="dash-table-count">{subtitle || `${dataCount}`}</span>
        </div>
      </header>

      <div className="dash-table-scroll" ref={scrollRef}>
        <table className="screener-table dash-screener-table">
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                const indicator = active ? (sort.direction === 'asc' ? '▲' : '▼') : '';
                return (
                  <th
                    key={column.key}
                    className={`sortable${column.type === 'symbol' ? ' align-left' : ''}`}
                    onClick={() => toggleSort(column.key)}
                  >
                    <span>{column.label}</span>
                    <span className="sort-indicator">{indicator}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty-cell">{error}</td>
              </tr>
            )}

            {!error && loading && dataCount === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty-cell">Loading…</td>
              </tr>
            )}

            {!error && !loading && dataCount === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty-cell">No data.</td>
              </tr>
            )}

            {sortedRows.map((row, index) => {
              if (isSeparatorRow(row)) {
                return (
                  <tr
                    key={`sep-${row.label}-${index}`}
                    ref={(node) => {
                      if (node) sepRefs.current[sepKey(row.label)] = node;
                    }}
                    className="watchlist-separator-row dash-separator-row"
                  >
                    <td colSpan={COLUMNS.length}>
                      <span className="dash-sep-name">{row.label}</span>
                      {row.meta && (
                        <span className="dash-sep-meta-wrap">
                          <span className={`dash-sep-meta ${toneClass(row.meta.avg)}`}>
                            {formatPercent(row.meta.avg)}
                          </span>
                          {(row.meta.up > 0 || row.meta.down > 0) && (
                            <span className="dash-sep-breadth">
                              <span className="cell-up">+{row.meta.up}</span>
                              <span className="dash-sep-breadth-sep">/</span>
                              <span className="cell-down">−{row.meta.down}</span>
                            </span>
                          )}
                          <span className="dash-sep-count">{row.meta.count}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              }

              const symbol = getSymbol(row) || `row-${index}`;
              const selected = selectedRow
                && getSymbol(selectedRow) === getSymbol(row)
                && (selectedRow.exchange || '') === (row.exchange || '');
              const change = Number(row?.change_percent ?? row?.change);
              const tone = toneClass(change);
              const note = getSymbolNote(row);

              return (
                <tr
                  key={`${symbol}-${index}`}
                  className={selected ? 'selected-row' : ''}
                  onClick={() => onSelectRow?.(row)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, row });
                  }}
                >
                  <td className="symbol-cell">
                    <span className="symbol-wrap">
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
                      <span className="symbol-text">
                        <span className="symbol-line">
                          <span
                            className={`symbol-ticker${tone === 'cell-up' ? ' up' : tone === 'cell-down' ? ' down' : ''}`}
                            onMouseEnter={note ? (event) => setHoverNote({
                              rect: event.currentTarget.getBoundingClientRect(),
                              symbol: getSymbol(row),
                            }) : undefined}
                            onMouseLeave={note ? () => setHoverNote(null) : undefined}
                          >
                            {getSymbol(row)}
                          </span>
                          {note && <span className="symbol-note-mark" aria-label="Has note">✎</span>}
                          {showCapTag && <MarketCapTag marketCap={row?.market_cap} />}
                        </span>
                        {getCompanyName(row) && (
                          <span className="symbol-name">{getCompanyName(row)}</span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className={`num-cell ${tone}`}>{formatPercent(row?.change_percent ?? change)}</td>
                  <td className={`num-cell ${tone}`}>{formatNumber(row?.last_price)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
