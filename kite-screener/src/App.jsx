import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChartPanel from './components/ChartPanel';
import DashboardView from './components/DashboardView';
import GlobalFilterBar from './components/GlobalFilterBar';
import MutualFundsView from './components/MutualFundsView';
import PositionsView from './components/PositionsView';
import ScreenerNav from './components/ScreenerNav';
import ScreenerTable from './components/ScreenerTable';
import {
  BATCH_SIZE,
  TARGET_ROWS_DEFAULT,
  fetchMoreRows,
  fetchHoldings,
  fetchPositions,
  fetchUpToRows,
  hasSession,
  isKiteEmbedded,
} from './screener/kiteApi';
import { fetchSectorGroupRows } from './screener/sectorScreeners';
import {
  applyResolvedEntries,
  bookmarkKey,
  bookmarksToRows,
  hasValidInstrumentToken,
  isInBookmarks,
  loadBookmarks,
  normalizeBookmark,
  resolveInstrumentToken,
  saveBookmarks,
  stripFabricatedTokens,
  toggleBookmarkEntry,
  addBookmarkEntry,
  reorderBookmarks,
} from './screener/bookmarks';
import { loadInstrumentIndex } from './screener/instruments';
import { ETF_WATCHLIST_ITEMS } from './screener/etfWatchlistData';
import { warmInstrumentDumpCache } from './screener/instrumentDumpCache';
import {
  entryNeedsTokenRefresh,
  resolveInstrumentTokensBulk,
  warmScreenerTokenCache,
} from './screener/screenerTokenCache';
import {
  MAX_WATCHLISTS,
  createWatchlist,
  deleteWatchlist,
  isInWatchlist,
  isWatchlistScreenerId,
  loadWatchlists,
  migrateWatchlist1ToBookmarks,
  renameWatchlist,
  reorderWatchlistItems,
  removeFromWatchlist,
  saveWatchlists,
  watchlistIdFromScreenerId,
  watchlistScreenerId,
} from './screener/watchlists';
import {
  BOOKMARKS_SCREENER_ID,
  DASHBOARD_SCREENER_ID,
  POSITIONS_SCREENER_ID,
  HOLDINGS_SCREENER_ID,
  CATEGORIES,
  HIDDEN_SCREENER_ID,
  MUTUAL_FUNDS_SCREENER_ID,
  MF_SAVED_SCREENER_ID,
  MF_HOLDINGS_SCREENER_ID,
  SCREENERS,
  makeBookmarksScreener,
  makeHiddenScreener,
  makeWatchlistScreener,
} from './screener/presets';
import { loadSavedFunds, saveSavedFunds, isFundSaved as isFundSavedInList, toggleSavedFund } from './screener/mfBookmarks';
import { filterHoldings, normalizeHolding, normalizePosition } from './screener/positions';
import { buildRequestBody } from './screener/queryBuilder';
import { mergeLiveTickRow } from './screener/liveTick';
import { useBookmarkSignals } from './screener/signals/useBookmarkSignals';
import { INDEX_SHORTCUTS } from './screener/indexShortcuts';
import { KiteTicker, requestEnctoken } from './screener/kiteTicker';
import {
  addHiddenSymbol,
  filterHiddenRows,
  isHiddenSymbol,
  loadHiddenSymbols,
  removeHiddenSymbol,
  saveHiddenSymbols,
} from './screener/hiddenSymbols';

function addToWatchlistLocal(lists, id, entry) {
  const key = bookmarkKey(entry);
  return lists.map((list) => {
    if (list.id !== id) return list;
    if (list.items.some((item) => bookmarkKey(item) === key)) return list;
    return { ...list, items: [...list.items, entry] };
  });
}

const FABRICATED_TOKEN_FIX_FLAG = 'kite-screener-token-fix-v3';

/** Trusted real tokens for symbols missing from the screener (ETFs, indices). */
function buildTrustedTokenMap() {
  const map = new Map();
  const add = (entry) => {
    const token = Number(entry?.instrument_token);
    if (!entry?.tradingsymbol || !Number.isFinite(token) || token <= 0) return;
    map.set(bookmarkKey(entry), token);
  };
  ETF_WATCHLIST_ITEMS.forEach(add);
  INDEX_SHORTCUTS.forEach((item) => add({
    tradingsymbol: item.tradingsymbol,
    exchange: item.exchange,
    segment: item.segment,
    instrument_token: item.instrument_token,
  }));
  return map;
}

function initStorage() {
  let watchlists = loadWatchlists();
  let bookmarks = loadBookmarks();
  let hiddenSymbols = loadHiddenSymbols();

  if (!localStorage.getItem(FABRICATED_TOKEN_FIX_FLAG)) {
    const trustedTokens = buildTrustedTokenMap();

    const fixedBookmarks = stripFabricatedTokens(bookmarks, trustedTokens);
    if (fixedBookmarks.changed) bookmarks = fixedBookmarks.entries;

    const fixedHidden = stripFabricatedTokens(hiddenSymbols, trustedTokens);
    if (fixedHidden.changed) hiddenSymbols = fixedHidden.entries;

    let watchlistsChanged = false;
    watchlists = watchlists.map((list) => {
      const fixed = stripFabricatedTokens(list.items, trustedTokens);
      if (!fixed.changed) return list;
      watchlistsChanged = true;
      return { ...list, items: fixed.entries };
    });
    if (watchlistsChanged) saveWatchlists(watchlists);

    localStorage.setItem(FABRICATED_TOKEN_FIX_FLAG, '1');
  }

  saveBookmarks(bookmarks);
  saveHiddenSymbols(hiddenSymbols);

  const migrated = migrateWatchlist1ToBookmarks(watchlists, bookmarks);
  if (migrated.bookmarks.length > bookmarks.length) {
    saveBookmarks(migrated.bookmarks);
    saveWatchlists(migrated.watchlists);
  }
  return { ...migrated, hiddenSymbols };
}

const TICK_FLUSH_MS = 400;

export default function App() {
  const embedded = isKiteEmbedded();
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0]);
  const [storage] = useState(initStorage);
  const [bookmarks, setBookmarks] = useState(storage.bookmarks);
  const [hiddenSymbols, setHiddenSymbols] = useState(storage.hiddenSymbols);
  const [watchlists, setWatchlists] = useState(storage.watchlists);
  const [savedFunds, setSavedFunds] = useState(loadSavedFunds);
  const [mfHoldingsCount, setMfHoldingsCount] = useState(0);
  const [activeScreenerId, setActiveScreenerId] = useState(BOOKMARKS_SCREENER_ID);
  const [dashboardTokens, setDashboardTokens] = useState([]);
  const [positionsTokens, setPositionsTokens] = useState([]);
  const [portfolioCounts, setPortfolioCounts] = useState({ positionCount: 0, holdingsCount: 0 });
  const [marketCapId, setMarketCapId] = useState('all');
  const [sector, setSector] = useState('');
  const [limit, setLimit] = useState(TARGET_ROWS_DEFAULT);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [selectedRow, setSelectedRow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const [liveTicks, setLiveTicks] = useState({});
  const [tickerReady, setTickerReady] = useState(false);
  const [indexTokensById, setIndexTokensById] = useState({});
  const tickerRef = useRef(null);
  const tickBufferRef = useRef(new Map());
  const visibleTokenSetRef = useRef(new Set());
  const connectGenRef = useRef(0);
  const tokenBootstrapGenRef = useRef(0);
  const mountedRef = useRef(true);

  const isDashboardView = activeScreenerId === DASHBOARD_SCREENER_ID;
  const isPositionsView = activeScreenerId === POSITIONS_SCREENER_ID;
  const isHoldingsView = activeScreenerId === HOLDINGS_SCREENER_ID;
  const isPortfolioView = isPositionsView || isHoldingsView;
  const isMfScreenerView = activeScreenerId === MUTUAL_FUNDS_SCREENER_ID;
  const isMfSavedView = activeScreenerId === MF_SAVED_SCREENER_ID;
  const isMfHoldingsView = activeScreenerId === MF_HOLDINGS_SCREENER_ID;
  const isMutualFundsView = isMfScreenerView || isMfSavedView || isMfHoldingsView;
  const isBookmarksView = activeScreenerId === BOOKMARKS_SCREENER_ID;
  const isHiddenView = activeScreenerId === HIDDEN_SCREENER_ID;
  const isWatchlistView = isWatchlistScreenerId(activeScreenerId);
  const isListView = isBookmarksView || isHiddenView || isWatchlistView;
  const activeWatchlistId = watchlistIdFromScreenerId(activeScreenerId);
  const activeWatchlist = useMemo(
    () => watchlists.find((list) => list.id === activeWatchlistId) || null,
    [watchlists, activeWatchlistId],
  );
  const indexWatchlistItems = useMemo(() => {
    const list = watchlists.find((item) => item.name?.trim().toLowerCase() === 'indices');
    return list?.items || [];
  }, [watchlists]);

  const activeListItems = isBookmarksView
    ? bookmarks
    : isHiddenView
      ? hiddenSymbols
      : (activeWatchlist?.items || []);
  const activeListItemsKey = activeListItems.map((item) => bookmarkKey(item)).join(',');

  const persistWatchlists = useCallback((next) => {
    saveWatchlists(next);
    setWatchlists(next);
  }, []);

  const persistBookmarks = useCallback((next) => {
    saveBookmarks(next);
    setBookmarks(next);
  }, []);

  const persistHiddenSymbols = useCallback((next) => {
    saveHiddenSymbols(next);
    setHiddenSymbols(next);
  }, []);

  const isFundSaved = useCallback((scheme) => isFundSavedInList(savedFunds, scheme), [savedFunds]);

  const toggleSaveFund = useCallback((scheme) => {
    setSavedFunds((current) => {
      const next = toggleSavedFund(current, scheme);
      saveSavedFunds(next);
      return next;
    });
  }, []);

  const isBookmarked = useCallback((row) => isInBookmarks(bookmarks, row), [bookmarks]);

  const isInActiveList = useCallback((row) => {
    if (isBookmarksView) return isInBookmarks(bookmarks, row);
    if (isHiddenView) return isHiddenSymbol(hiddenSymbols, row);
    if (isWatchlistView && activeWatchlistId) return isInWatchlist(watchlists, activeWatchlistId, row);
    return false;
  }, [isBookmarksView, isHiddenView, isWatchlistView, bookmarks, hiddenSymbols, watchlists, activeWatchlistId]);

  const toggleBookmark = useCallback(async (row) => {
    const entry = normalizeBookmark(row);
    if (!entry.tradingsymbol) return;

    if (isInBookmarks(bookmarks, entry)) {
      persistBookmarks(toggleBookmarkEntry(bookmarks, entry));
      return;
    }

    try {
      const token = await resolveInstrumentToken(entry);
      if (token) entry.instrument_token = token;
    } catch {
      // screener fallback still works for initial LTP
    }

    persistBookmarks(addBookmarkEntry(bookmarks, entry));
  }, [bookmarks, persistBookmarks]);

  const addToActiveList = useCallback(async (item) => {
    const entry = normalizeBookmark(item);
    if (!entry.tradingsymbol) return;

    if (isInActiveList(entry)) return;

    const entryKey = bookmarkKey(entry);

    if (isBookmarksView) {
      persistBookmarks(addBookmarkEntry(bookmarks, entry));
    } else if (isHiddenView) {
      return;
    } else if (isWatchlistView && activeWatchlistId) {
      setWatchlists((current) => {
        const next = addToWatchlistLocal(current, activeWatchlistId, entry);
        if (next === current) return current;
        saveWatchlists(next);
        return next;
      });
    } else {
      return;
    }

    if (hasValidInstrumentToken(entry) && !entryNeedsTokenRefresh(entry)) return;

    try {
      const token = await resolveInstrumentToken(entry);
      if (!token) return;

      if (isBookmarksView) {
        setBookmarks((current) => {
          const next = current.map((row) => (
            bookmarkKey(row) === entryKey ? { ...row, instrument_token: token } : row
          ));
          saveBookmarks(next);
          return next;
        });
        return;
      }

      if (!isWatchlistView || !activeWatchlistId) return;

      setWatchlists((current) => {
        const next = current.map((list) => {
          if (list.id !== activeWatchlistId) return list;
          const items = list.items.map((row) => (
            bookmarkKey(row) === entryKey ? { ...row, instrument_token: token } : row
          ));
          return { ...list, items };
        });
        saveWatchlists(next);
        return next;
      });
    } catch {
      // keep entry without token; screener quote fallback still works for equities
    }
  }, [
    isBookmarksView,
    isHiddenView,
    isWatchlistView,
    activeWatchlistId,
    bookmarks,
    isInActiveList,
    persistBookmarks,
  ]);

  const hideSymbol = useCallback(async (row) => {
    const entry = normalizeBookmark(row);
    if (!entry.tradingsymbol) return;

    try {
      const token = await resolveInstrumentToken(entry);
      if (token) entry.instrument_token = token;
    } catch {
      // keep hidden entry without token; screener rows still filter by symbol
    }

    persistHiddenSymbols(addHiddenSymbol(hiddenSymbols, entry));
    if (selectedRow && bookmarkKey(selectedRow) === bookmarkKey(entry)) {
      setSelectedRow(null);
    }
  }, [hiddenSymbols, persistHiddenSymbols, selectedRow]);

  const unhideSymbol = useCallback((row) => {
    persistHiddenSymbols(removeHiddenSymbol(hiddenSymbols, row));
  }, [hiddenSymbols, persistHiddenSymbols]);

  const removeFromActiveWatchlist = useCallback((row) => {
    if (!activeWatchlistId) return;
    const key = bookmarkKey(row);
    persistWatchlists(removeFromWatchlist(watchlists, activeWatchlistId, key));
    if (selectedRow && bookmarkKey(selectedRow) === key) {
      setSelectedRow(null);
    }
  }, [activeWatchlistId, watchlists, persistWatchlists, selectedRow]);

  const persistInstrumentToken = useCallback((entry, token) => {
    const normalized = normalizeBookmark(entry);
    if (!normalized.tradingsymbol || !token) return;

    const resolved = {
      [bookmarkKey(normalized)]: {
        instrument_token: Number(token),
        segment: normalized.segment || normalized.exchange || 'NSE',
      },
    };

    if (isBookmarksView) {
      setBookmarks((current) => {
        const next = applyResolvedEntries(current, resolved);
        if (next !== current) saveBookmarks(next);
        return next;
      });
      return;
    }

    if (!isWatchlistView || !activeWatchlistId) return;

    setWatchlists((current) => {
      const list = current.find((item) => item.id === activeWatchlistId);
      if (!list) return current;
      const nextItems = applyResolvedEntries(list.items, resolved);
      if (nextItems === list.items) return current;
      const next = current.map((item) => (
        item.id === activeWatchlistId ? { ...item, items: nextItems } : item
      ));
      saveWatchlists(next);
      return next;
    });
  }, [isBookmarksView, isWatchlistView, activeWatchlistId]);

  const reorderBookmarkRows = useCallback((fromIndex, toIndex) => {
    persistBookmarks(reorderBookmarks(bookmarks, fromIndex, toIndex));
  }, [bookmarks, persistBookmarks]);

  const reorderWatchlistRows = useCallback((fromIndex, toIndex) => {
    if (!activeWatchlistId) return;
    persistWatchlists(reorderWatchlistItems(watchlists, activeWatchlistId, fromIndex, toIndex));
  }, [watchlists, activeWatchlistId, persistWatchlists]);

  const handleCreateWatchlist = useCallback(() => {
    if (watchlists.length >= MAX_WATCHLISTS) return;
    const name = window.prompt('New watchlist name', `Watchlist ${watchlists.length + 1}`);
    if (name === null) return;
    const next = createWatchlist(watchlists, name);
    persistWatchlists(next);
    const created = next[next.length - 1];
    if (created) setActiveScreenerId(watchlistScreenerId(created.id));
  }, [watchlists, persistWatchlists]);

  const handleRenameWatchlist = useCallback((id, currentName) => {
    const name = window.prompt('Rename watchlist', currentName);
    if (name === null) return;
    persistWatchlists(renameWatchlist(watchlists, id, name));
  }, [watchlists, persistWatchlists]);

  const handleDeleteWatchlist = useCallback((id, name) => {
    if (!window.confirm(`Delete "${name}"? This removes its saved symbols.`)) return;
    const next = deleteWatchlist(watchlists, id);
    persistWatchlists(next);
    if (activeWatchlistId === id) {
      setActiveScreenerId(BOOKMARKS_SCREENER_ID);
    }
  }, [watchlists, activeWatchlistId, persistWatchlists]);

  const handleTicks = useCallback((ticks) => {
    const buffer = tickBufferRef.current;
    const recvAt = Date.now();
    ticks.forEach((tick) => {
      // Stamp the client receive time so order-safety can judge feed freshness
      // without depending on the exchange clock (immune to local clock skew).
      buffer.set(tick.instrument_token, { ...tick, _recvAt: recvAt });
    });
  }, []);

  const activeScreener = useMemo(() => {
    if (isBookmarksView) return makeBookmarksScreener();
    if (isHiddenView) return makeHiddenScreener();
    if (isWatchlistView) {
      return makeWatchlistScreener(activeScreenerId, activeWatchlist?.name || 'Watchlist');
    }
    return SCREENERS.find((screener) => screener.id === activeScreenerId) || SCREENERS[0];
  }, [isBookmarksView, isHiddenView, isWatchlistView, activeScreenerId, activeWatchlist]);

  const listRows = useMemo(
    () => bookmarksToRows(activeListItems),
    [activeListItems],
  );

  const baseRows = isListView ? listRows : rows;

  const displayRows = useMemo(() => {
    let next = baseRows;
    if (Object.keys(liveTicks).length) {
      next = baseRows.map((row) => {
        const token = Number(row?.instrument_token);
        return mergeLiveTickRow(row, liveTicks[token]);
      });
    }
    if (!isHiddenView) {
      next = filterHiddenRows(next, hiddenSymbols);
    }
    return next;
  }, [baseRows, liveTicks, isHiddenView, hiddenSymbols]);

  const displayLoading = isListView ? quotesLoading && listRows.length === 0 : loading;
  const displayTotal = isListView ? listRows.length : total;

  // Buy/Sell/Hold signals for the All Bookmarks view (computed from ~2y daily
  // candles + a weighted technical-score engine).
  const { signals: bookmarkSignals } = useBookmarkSignals(
    activeListItems,
    { enabled: embedded && isBookmarksView, refreshKey: quoteRefreshKey },
  );

  const finalDisplayRows = displayRows;

  const visibleTokens = useMemo(() => {
    const set = new Set();
    Object.values(indexTokensById).forEach((token) => {
      if (Number.isFinite(token) && token > 0) set.add(token);
    });
    if (isDashboardView) {
      dashboardTokens.forEach((token) => {
        if (Number.isFinite(token) && token > 0) set.add(token);
      });
    } else if (isPortfolioView) {
      positionsTokens.forEach((token) => {
        if (Number.isFinite(token) && token > 0) set.add(token);
      });
    } else {
      baseRows.forEach((row) => {
        if (row?.type === 'separator') return;
        const token = Number(row?.instrument_token);
        if (hasValidInstrumentToken(row)) set.add(token);
      });
    }
    return Array.from(set);
  }, [baseRows, indexTokensById, isDashboardView, dashboardTokens, isPortfolioView, positionsTokens]);

  const tokenKey = visibleTokens.join(',');

  const pruneLiveState = useCallback((tokens) => {
    const allowed = new Set(tokens);
    visibleTokenSetRef.current = allowed;

    const buffer = tickBufferRef.current;
    buffer.forEach((_tick, token) => {
      if (!allowed.has(token)) buffer.delete(token);
    });

    setLiveTicks((current) => {
      const next = {};
      allowed.forEach((token) => {
        if (current[token]) next[token] = current[token];
      });
      if (Object.keys(next).length === Object.keys(current).length) {
        let same = true;
        allowed.forEach((token) => {
          if (next[token] !== current[token]) same = false;
        });
        if (same) return current;
      }
      return next;
    });
  }, []);

  const selectedRowLive = useMemo(() => {
    if (!selectedRow) return null;
    const tick = liveTicks[Number(selectedRow?.instrument_token)];
    return mergeLiveTickRow(selectedRow, tick);
  }, [selectedRow, liveTicks]);

  const selectedToken = useMemo(() => {
    if (!selectedRow || selectedRow.type === 'separator') return null;
    const token = Number(selectedRow?.instrument_token);
    return hasValidInstrumentToken(selectedRow) ? token : null;
  }, [selectedRow]);

  const quoteTokens = useMemo(
    () => visibleTokens.filter((token) => token !== selectedToken),
    [visibleTokens, selectedToken],
  );

  const requestBody = useMemo(
    () => buildRequestBody({ screener: activeScreener, marketCapId, sector, limit: BATCH_SIZE }),
    [activeScreener, marketCapId, sector],
  );

  useEffect(() => {
    if (!embedded) {
      setError('Open https://kite.zerodha.com/local-screener with the Kite Local Screener extension enabled.');
      return undefined;
    }

    if (!hasSession()) {
      setError('Login to Kite first, then open https://kite.zerodha.com/local-screener');
      return undefined;
    }

    if (isListView || isDashboardView || isPortfolioView || isMutualFundsView) {
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      setError('');
      return undefined;
    }

    const controller = new AbortController();

    setLoading(true);
    setLoadingMore(false);
    setError('');
    setRows([]);
    setTotal(undefined);
    setHasMore(false);
    setNextOffset(0);

    const fetchPromise = activeScreener.isSectorGroup
      ? fetchSectorGroupRows(activeScreener, { marketCapId, limit, signal: controller.signal })
      : fetchUpToRows(requestBody, { targetRows: limit, signal: controller.signal });

    fetchPromise
      .then((result) => {
        setRows(result.rows);
        setTotal(result.total);
        setHasMore(result.hasMore);
        setNextOffset(result.nextOffset);
      })
      .catch((fetchError) => {
        if (fetchError.name === 'AbortError') return;
        setRows([]);
        setTotal(undefined);
        setHasMore(false);
        setNextOffset(0);
        setError(fetchError.message || 'Unable to load screener.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [embedded, isListView, isDashboardView, isPortfolioView, isMutualFundsView, activeScreener, requestBody, marketCapId, limit, refreshKey]);

  const loadMore = useCallback(() => {
    if (isListView || !embedded || !hasSession() || loading || loadingMore || !hasMore) return;

    setLoadingMore(true);

    fetchMoreRows(requestBody, { offset: nextOffset })
      .then((result) => {
        setRows((current) => [...current, ...result.rows]);
        setTotal(result.total);
        setHasMore(result.hasMore);
        setNextOffset(result.nextOffset);
      })
      .catch((fetchError) => {
        setError(fetchError.message || 'Unable to load more rows.');
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [embedded, hasMore, isListView, loading, loadingMore, nextOffset, requestBody]);

  useEffect(() => {
    if (!embedded || !hasSession() || !isListView || activeListItems.length === 0) {
      return undefined;
    }

    const gen = tokenBootstrapGenRef.current + 1;
    tokenBootstrapGenRef.current = gen;

    setQuotesLoading(true);

    (async () => {
      try {
        await warmScreenerTokenCache();
        await warmInstrumentDumpCache();
        if (gen !== tokenBootstrapGenRef.current) return;

        const entriesNeedingBootstrap = activeListItems.filter((item) => {
          if (item?.type === 'separator') return false;
          return entryNeedsTokenRefresh(item);
        });

        if (!entriesNeedingBootstrap.length) return;

        const resolved = await resolveInstrumentTokensBulk(entriesNeedingBootstrap);
        if (gen !== tokenBootstrapGenRef.current) return;
        if (!resolved || !Object.keys(resolved).length) return;

        if (isBookmarksView) {
          const next = applyResolvedEntries(bookmarks, resolved);
          if (next !== bookmarks) persistBookmarks(next);
          return;
        }

        if (isHiddenView) {
          const next = applyResolvedEntries(hiddenSymbols, resolved);
          if (next !== hiddenSymbols) persistHiddenSymbols(next);
          return;
        }

        if (!activeWatchlistId) return;
        setWatchlists((current) => {
          const list = current.find((item) => item.id === activeWatchlistId);
          if (!list) return current;
          const nextItems = applyResolvedEntries(list.items, resolved);
          if (nextItems === list.items) return current;
          const next = current.map((item) => (
            item.id === activeWatchlistId ? { ...item, items: nextItems } : item
          ));
          saveWatchlists(next);
          return next;
        });
      } catch {
        // token bootstrap failed — retry on next load or row click
      } finally {
        if (gen === tokenBootstrapGenRef.current) setQuotesLoading(false);
      }
    })();

    return () => {
      tokenBootstrapGenRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, isListView, activeListItems, quoteRefreshKey]);

  useEffect(() => {
    if (!isListView || displayRows.length === 0) return;
    setSelectedRow((current) => {
      if (
        current
        && current.type !== 'separator'
        && displayRows.some((row) => row.type !== 'separator' && bookmarkKey(row) === bookmarkKey(current))
      ) {
        return current;
      }
      return null;
    });
  }, [isListView, displayRows]);

  useEffect(() => {
    setSelectedRow(null);
  }, [activeScreenerId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Warm instrument search index + screener token cache once at startup.
  useEffect(() => {
    if (!embedded) return undefined;
    const controller = new AbortController();
    loadInstrumentIndex(controller.signal).catch(() => {});
    warmScreenerTokenCache(controller.signal).catch(() => {});
    warmInstrumentDumpCache().catch(() => {});
    return () => controller.abort();
  }, [embedded]);

  useEffect(() => {
    if (!embedded || !hasSession()) return undefined;

    const gen = connectGenRef.current + 1;
    connectGenRef.current = gen;

    requestEnctoken().then(({ ok, enctoken, userId }) => {
      if (!mountedRef.current || connectGenRef.current !== gen || !ok) return;

      if (tickerRef.current) tickerRef.current.disconnect();

      const ticker = new KiteTicker({ enctoken, userId, onTick: handleTicks });
      tickerRef.current = ticker;
      ticker.connect();
      if (mountedRef.current) setTickerReady(true);
    });

    const flush = setInterval(() => {
      const buffer = tickBufferRef.current;
      const visible = visibleTokenSetRef.current;
      if (buffer.size === 0) return;

      const updates = new Map();
      buffer.forEach((tick, token) => {
        if (visible.has(token)) updates.set(token, tick);
        buffer.delete(token);
      });
      if (updates.size === 0) return;

      setLiveTicks((current) => {
        const next = {};
        visible.forEach((token) => {
          if (updates.has(token)) {
            next[token] = { ...current[token], ...updates.get(token) };
          } else if (current[token]) {
            next[token] = current[token];
          }
        });
        return next;
      });
    }, TICK_FLUSH_MS);

    return () => {
      connectGenRef.current += 1;
      clearInterval(flush);
      tickBufferRef.current.clear();
      if (tickerRef.current) {
        tickerRef.current.disconnect();
        tickerRef.current = null;
      }
      if (mountedRef.current) {
        setTickerReady(false);
        setLiveTicks({});
      }
    };
  }, [embedded, handleTicks]);

  useEffect(() => {
    pruneLiveState(visibleTokens);
    const ticker = tickerRef.current;
    if (!ticker || !tickerReady || document.hidden) return;
    ticker.syncSubscriptions({
      quoteTokens,
      fullTokens: selectedToken ? [selectedToken] : [],
    });
  }, [tokenKey, tickerReady, pruneLiveState, visibleTokens, quoteTokens, selectedToken]);

  useEffect(() => {
    if (!tickerReady) return undefined;

    const onVisibilityChange = () => {
      const ticker = tickerRef.current;
      if (!ticker) return;
      if (document.hidden) {
        ticker.pause();
        tickBufferRef.current.clear();
        return;
      }
      ticker.resume();
      ticker.syncSubscriptions({
        quoteTokens,
        fullTokens: selectedToken ? [selectedToken] : [],
      });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [tickerReady, quoteTokens, selectedToken]);

  const refreshScreenerData = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  const refreshListQuotes = useCallback(() => {
    setQuoteRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!embedded || !hasSession()) {
      setIndexTokensById({});
      return undefined;
    }

    const tokensById = {};
    INDEX_SHORTCUTS.forEach((item) => {
      const token = Number(item.instrument_token);
      if (Number.isFinite(token) && token > 0) tokensById[item.id] = token;
    });
    setIndexTokensById(tokensById);
  }, [embedded]);

  useEffect(() => {
    if (!embedded || !hasSession()) {
      setPortfolioCounts({ positionCount: 0, holdingsCount: 0 });
      return undefined;
    }

    const controller = new AbortController();
    Promise.all([
      fetchPositions(controller.signal),
      fetchHoldings(controller.signal),
    ])
      .then(([{ net }, holdingsData]) => {
        if (controller.signal.aborted) return;
        setPortfolioCounts({
          positionCount: (net || []).length,
          holdingsCount: filterHoldings((holdingsData || []).map(normalizeHolding)).length,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPortfolioCounts({ positionCount: 0, holdingsCount: 0 });
        }
      });

    return () => controller.abort();
  }, [embedded, refreshKey]);

  const handlePortfolioCounts = useCallback((partial) => {
    setPortfolioCounts((current) => ({ ...current, ...partial }));
  }, []);

  return (
    <div className="app-shell">
      <GlobalFilterBar
        indexLiveTicks={liveTicks}
        indexTokensById={indexTokensById}
      />

      <div className={`workspace${isDashboardView ? ' workspace-dashboard' : ''}${isPortfolioView ? ' workspace-portfolio' : ''}${isMutualFundsView ? ' workspace-mf' : ''}`}>
        <ScreenerNav
          bookmarkCount={bookmarks.length}
          hiddenCount={hiddenSymbols.length}
          positionCount={portfolioCounts.positionCount}
          holdingsCount={portfolioCounts.holdingsCount}
          watchlists={watchlists}
          activeScreenerId={activeScreenerId}
          setActiveScreenerId={setActiveScreenerId}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          onCreateWatchlist={handleCreateWatchlist}
          onRenameWatchlist={handleRenameWatchlist}
          onDeleteWatchlist={handleDeleteWatchlist}
          savedFundCount={savedFunds.length}
          mfHoldingsCount={mfHoldingsCount}
        />

        {isMutualFundsView ? (
          <MutualFundsView
            mode={isMfHoldingsView ? 'holdings' : isMfSavedView ? 'saved' : 'screener'}
            embedded={embedded}
            savedFunds={savedFunds}
            isFundSaved={isFundSaved}
            onToggleSave={toggleSaveFund}
            onHoldingsCount={setMfHoldingsCount}
          />
        ) : isDashboardView ? (
          <DashboardView
            embedded={embedded}
            marketCapId={marketCapId}
            indexItems={indexWatchlistItems}
            liveTicks={liveTicks}
            selectedRow={selectedRow}
            selectedRowLive={selectedRowLive}
            onSelectRow={setSelectedRow}
            isBookmarked={isBookmarked}
            onToggleBookmark={toggleBookmark}
            onHideSymbol={hideSymbol}
            onVisibleTokens={setDashboardTokens}
            hiddenSymbols={hiddenSymbols}
            limit={limit}
            refreshKey={refreshKey}
            onRefresh={refreshScreenerData}
          />
        ) : isPortfolioView ? (
          <>
            <PositionsView
              mode={isHoldingsView ? 'holdings' : 'positions'}
              embedded={embedded}
              liveTicks={liveTicks}
              selectedRow={selectedRow}
              onSelectRow={setSelectedRow}
              onVisibleTokens={setPositionsTokens}
              onCountsChange={handlePortfolioCounts}
            />
            <ChartPanel row={selectedRowLive} onInstrumentTokenResolved={persistInstrumentToken} />
          </>
        ) : (
          <>
            <ScreenerTable
              screener={activeScreener}
              rows={finalDisplayRows}
              total={displayTotal}
              loading={displayLoading}
              loadingMore={loadingMore}
              hasMore={!isListView && hasMore}
              onLoadMore={loadMore}
              error={error}
              selectedRow={selectedRow}
              onSelectRow={setSelectedRow}
              requestBody={isListView ? null : { ...requestBody, limit }}
              isBookmarked={isBookmarked}
              onToggleBookmark={toggleBookmark}
              onHideSymbol={hideSymbol}
              onUnhideSymbol={unhideSymbol}
              onRemoveFromWatchlist={isWatchlistView ? removeFromActiveWatchlist : undefined}
              onAddBookmark={addToActiveList}
              isInActiveList={isInActiveList}
              isHiddenView={isHiddenView}
              onReorderRows={
                isWatchlistView
                  ? reorderWatchlistRows
                  : undefined
              }
              signalsByKey={isBookmarksView ? bookmarkSignals : null}
              liveQuotes={isListView}
              quotesLoading={quotesLoading}
              showFilters={!isListView}
              marketCapId={marketCapId}
              setMarketCapId={setMarketCapId}
              sector={sector}
              setSector={setSector}
              limit={limit}
              setLimit={setLimit}
              hideSectorFilter={Boolean(activeScreener?.isSectorGroup)}
              onRefresh={isListView ? refreshListQuotes : refreshScreenerData}
            />

            <ChartPanel row={selectedRowLive} onInstrumentTokenResolved={persistInstrumentToken} />
          </>
        )}
      </div>
    </div>
  );
}
