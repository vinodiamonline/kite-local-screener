import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  loadMfSchemes,
  loadMfHistory,
  loadMfReturns,
  computeMfReturns,
  mapWithConcurrency,
} from '../screener/mfApi';
import { fetchMfHoldings, fetchMfOrders, hasSession } from '../screener/kiteApi';
import { computeHoldingXirr, computePortfolioXirr } from '../screener/xirr';
import MfNavChart from './MfNavChart';
import MfCompareModal from './MfCompareModal';
import MfInsightsModal from './MfInsightsModal';
import MfAllocationPie from './MfAllocationPie';

// One-click screens. Each is category-specific so the filtered set stays small
// enough for trailing returns to auto-load.
const MF_PRESETS = [
  { id: 'large3y', label: 'Large Cap · 3Y', type: 'Equity', subMatch: 'large cap', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'mid3y', label: 'Mid Cap · 3Y', type: 'Equity', subMatch: 'mid cap', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'small5y', label: 'Small Cap · 5Y', type: 'Equity', subMatch: 'small cap', sort: { key: 'r5y', dir: 'desc' } },
  { id: 'flexi3y', label: 'Flexi Cap · 3Y', type: 'Equity', subMatch: 'flexi cap', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'elss3y', label: 'ELSS · 3Y', type: 'Equity', subMatch: 'elss', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'index1y', label: 'Index Funds · 1Y', type: 'Other', subMatch: 'index', sort: { key: 'r1y', dir: 'desc' } },
  { id: 'baa3y', label: 'Balanced Advantage · 3Y', type: 'Hybrid', subMatch: 'balanced advantage', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'aggr3y', label: 'Aggressive Hybrid · 3Y', type: 'Hybrid', subMatch: 'aggressive hybrid', sort: { key: 'r3y', dir: 'desc' } },
  { id: 'debt1y', label: 'Short Duration Debt · 1Y', type: 'Debt', subMatch: 'short duration', sort: { key: 'r1y', dir: 'desc' } },
];

function resolveSubCategory(options, match) {
  const lowered = options.map((option) => ({ option, lower: option.toLowerCase() }));
  const included = lowered.filter((item) => item.lower.includes(match));
  if (!included.length) return 'All';
  const startsWith = included.filter((item) => item.lower.startsWith(match));
  const pool = startsWith.length ? startsWith : included;
  return pool.sort((a, b) => a.option.length - b.option.length)[0].option;
}

const AUTO_RETURNS_THRESHOLD = 60; // auto-load trailing returns when the filtered set is small
const MAX_MANUAL_RETURNS = 400;
const RETURNS_CONCURRENCY = 8;
const DISPLAY_LIMIT = 250;
const MAX_COMPARE = 5;

const DEFAULT_FILTERS = {
  search: '',
  schemeType: 'Equity',
  subCategory: 'All',
  amc: 'All',
  plan: 'Direct',
  option: 'Growth',
};

function formatNav(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
}

const NAV_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse an AMFI date string ("10-Jul-2026") into a timestamp, so it can be
// compared against the mfapi history timestamp to decide which NAV is fresher.
function parseAmfiDate(str) {
  const match = String(str || '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const mon = NAV_MONTHS.indexOf(match[2][0].toUpperCase() + match[2].slice(1, 3).toLowerCase());
  const year = Number(match[3]);
  if (mon < 0 || !day || !year) return null;
  return new Date(year, mon, day).getTime();
}

// Accepts either a timestamp (from mfapi history) or an AMFI date string
// ("10-Jul-2026") and renders a consistent "10-Jul-2026" label.
function formatNavDate(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getDate()).padStart(2, '0')}-${NAV_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
  }
  return String(value);
}

const moneyFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const unitFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

function formatMoney(value) {
  return Number.isFinite(value) ? `₹${moneyFormatter.format(Math.round(value))}` : '—';
}

function formatUnits(value) {
  return Number.isFinite(value) ? unitFormatter.format(Math.round(value)) : '—';
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function toneClass(value) {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'cell-up' : 'cell-down';
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export default function MutualFundsView({
  mode = 'screener',
  embedded = false,
  savedFunds = [],
  isFundSaved,
  onToggleSave,
  onHoldingsCount,
}) {
  const isSavedMode = mode === 'saved';
  const isHoldingsMode = mode === 'holdings';

  const [schemes, setSchemes] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [holdings, setHoldings] = useState([]);
  const [mfOrders, setMfOrders] = useState([]);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [holdingsError, setHoldingsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [activePreset, setActivePreset] = useState(null);

  const [returnsByCode, setReturnsByCode] = useState({});
  const [returnsLoading, setReturnsLoading] = useState(false);
  const loadedCodesRef = useRef(new Set());
  const returnsGenRef = useRef(0);

  const [selected, setSelected] = useState(null);
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedRange, setSelectedRange] = useState('1Y');

  const [compare, setCompare] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError('');
    loadMfSchemes()
      .then((data) => {
        if (!cancelled) setSchemes(data);
      })
      .catch((error) => {
        if (!cancelled) setListError(error?.message || 'Unable to load mutual fund list.');
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const schemesByCode = useMemo(() => {
    const map = new Map();
    schemes.forEach((scheme) => map.set(scheme.schemeCode, scheme));
    return map;
  }, [schemes]);

  const schemesByIsin = useMemo(() => {
    const map = new Map();
    schemes.forEach((scheme) => {
      if (scheme.isin) map.set(scheme.isin, scheme);
    });
    return map;
  }, [schemes]);

  // Fetch the user's actual mutual-fund holdings from Zerodha (holdings mode only).
  useEffect(() => {
    if (!isHoldingsMode) return undefined;
    if (!hasSession()) {
      setHoldingsError('Log in to Kite, then open https://kite.zerodha.com/local-screener to see your holdings.');
      return undefined;
    }
    const controller = new AbortController();
    setHoldingsLoading(true);
    setHoldingsError('');
    Promise.all([
      fetchMfHoldings(controller.signal),
      fetchMfOrders(controller.signal),
    ])
      .then(([hData, oData]) => {
        if (!controller.signal.aborted) {
          setHoldings(Array.isArray(hData) ? hData : []);
          setMfOrders(Array.isArray(oData) ? oData : []);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && error?.name !== 'AbortError') {
          setHoldingsError(error?.message || 'Unable to load your mutual-fund holdings.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setHoldingsLoading(false);
      });
    return () => controller.abort();
  }, [isHoldingsMode, embedded]);

  // Enrich each holding with its AMFI scheme (via ISIN) and derived P&L/value.
  // Kite's /oms/mf/holdings last_price can lag a day or two, and the two public
  // feeds (mfapi.in history vs AMFI NAVAll.txt) don't update in lockstep — either
  // one can be ahead on any given day — so we pick whichever NAV is the most
  // recent BY DATE (not by a fixed source order) and recompute value + P&L from
  // it. Kite's last_price is only a fallback for schemes we can't map.
  const holdingRows = useMemo(() => {
    return holdings
      .map((holding) => {
        const isin = String(holding.tradingsymbol || '').trim();
        const matched = schemesByIsin.get(isin) || null;
        const code = matched?.schemeCode || null;
        const units = Number(holding.quantity) || 0;
        const avg = Number(holding.average_price) || 0;
        const kiteLtp = Number(holding.last_price) || 0;

        const ret = code ? returnsByCode[code] : null;
        const candidates = [];
        if (ret && Number.isFinite(ret.latestNav) && ret.latestNav > 0) {
          candidates.push({
            nav: Number(ret.latestNav),
            t: Number.isFinite(ret.latestDate) ? ret.latestDate : -Infinity,
            source: 'history',
            dateRaw: ret.latestDate,
          });
        }
        if (matched && Number.isFinite(matched.nav) && matched.nav > 0) {
          candidates.push({
            nav: Number(matched.nav),
            t: parseAmfiDate(matched.navDate) ?? -Infinity,
            source: 'amfi',
            dateRaw: matched.navDate || '',
          });
        }
        // Freshest date wins; keeps whichever public feed happens to be ahead.
        candidates.sort((a, b) => b.t - a.t);
        const best = candidates[0] || null;

        const ltp = best ? best.nav : kiteLtp;
        const navSource = best ? best.source : 'kite';
        const usingFreshNav = navSource !== 'kite';
        const navDate = best ? formatNavDate(best.dateRaw) : '';

        const invested = units * avg;
        const current = units * ltp;
        // When we override the NAV, Kite's pnl no longer matches, so recompute it
        // from the fresh price. Only trust Kite's pnl if we kept Kite's price.
        const rawPnl = Number(holding.pnl);
        const pnl = usingFreshNav
          ? current - invested
          : (Number.isFinite(rawPnl) && rawPnl !== 0 ? rawPnl : current - invested);
        const pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
        const scheme = matched || {
          schemeCode: null,
          name: holding.fund || isin,
          isin,
          nav: ltp,
          amc: '',
          schemeType: '',
          subCategory: '',
          plan: '',
          option: '',
        };
        return {
          key: code || isin,
          holding,
          scheme,
          code,
          units,
          avg,
          ltp,
          navDate,
          navSource,
          kiteLtp,
          invested,
          current,
          pnl,
          pnlPct,
        };
      })
      .sort((a, b) => b.current - a.current);
  }, [holdings, schemesByIsin, returnsByCode]);

  const holdingsSummary = useMemo(
    () => holdingRows.reduce(
      (acc, row) => {
        acc.invested += row.invested;
        acc.current += row.current;
        acc.pnl += row.pnl;
        return acc;
      },
      { invested: 0, current: 0, pnl: 0 },
    ),
    [holdingRows],
  );

  const overallXirr = useMemo(
    () => computePortfolioXirr(holdingRows, mfOrders, returnsByCode),
    [holdingRows, mfOrders, returnsByCode],
  );

  useEffect(() => {
    if (isHoldingsMode) onHoldingsCount?.(holdingRows.length);
  }, [isHoldingsMode, holdingRows.length, onHoldingsCount]);

  const typeOptions = useMemo(() => uniqueSorted(schemes.map((s) => s.schemeType)), [schemes]);
  const amcOptions = useMemo(() => uniqueSorted(schemes.map((s) => s.amc)), [schemes]);
  const subCategoryOptions = useMemo(() => {
    const pool = filters.schemeType === 'All'
      ? schemes
      : schemes.filter((s) => s.schemeType === filters.schemeType);
    return uniqueSorted(pool.map((s) => s.subCategory));
  }, [schemes, filters.schemeType]);

  const savedScheme = useCallback(
    (saved) => schemesByCode.get(saved.schemeCode) || saved,
    [schemesByCode],
  );

  const baseList = useMemo(() => {
    if (isHoldingsMode) return [];
    if (isSavedMode) return savedFunds.map(savedScheme);

    const term = filters.search.trim().toLowerCase();
    return schemes.filter((scheme) => {
      if (filters.schemeType !== 'All' && scheme.schemeType !== filters.schemeType) return false;
      if (filters.subCategory !== 'All' && scheme.subCategory !== filters.subCategory) return false;
      if (filters.amc !== 'All' && scheme.amc !== filters.amc) return false;
      if (filters.plan !== 'All' && scheme.plan !== filters.plan) return false;
      if (filters.option !== 'All' && scheme.option !== filters.option) return false;
      if (term && !scheme.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [isHoldingsMode, isSavedMode, savedFunds, savedScheme, schemes, filters]);

  const sortedList = useMemo(() => {
    const withReturns = baseList.map((scheme) => ({
      scheme,
      ret: returnsByCode[scheme.schemeCode] || null,
    }));

    const dir = sort.dir === 'asc' ? 1 : -1;
    const value = (item) => {
      switch (sort.key) {
        case 'nav': return item.ret?.latestNav ?? item.scheme.nav ?? null;
        case 'r1y': return item.ret?.r1y ?? null;
        case 'r3y': return item.ret?.r3y ?? null;
        case 'r5y': return item.ret?.r5y ?? null;
        default: return item.scheme.name?.toLowerCase() ?? '';
      }
    };

    return [...withReturns].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return dir * String(av).localeCompare(String(bv));
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
  }, [baseList, returnsByCode, sort]);

  const visible = useMemo(() => sortedList.slice(0, DISPLAY_LIMIT), [sortedList]);

  const loadReturnsForCodes = useCallback((codes, { force = false } = {}) => {
    const pending = force
      ? Array.from(new Set(codes))
      : codes.filter((code) => !loadedCodesRef.current.has(code));
    if (!pending.length) return;

    pending.forEach((code) => loadedCodesRef.current.add(code));
    const gen = returnsGenRef.current;
    setReturnsLoading(true);

    mapWithConcurrency(pending, RETURNS_CONCURRENCY, async (code) => {
      const data = await loadMfReturns(code, { force });
      if (returnsGenRef.current !== gen) return null;
      setReturnsByCode((prev) => ({ ...prev, [code]: data }));
      return data;
    }).finally(() => {
      if (returnsGenRef.current === gen) setReturnsLoading(false);
    });
  }, []);

  // Auto-load trailing returns for the visible set when it is small enough.
  useEffect(() => {
    if (listLoading) return;
    const codes = visible.map((item) => item.scheme.schemeCode);
    const missing = codes.filter((code) => !loadedCodesRef.current.has(code));
    if (missing.length && (isSavedMode || missing.length <= AUTO_RETURNS_THRESHOLD)) {
      loadReturnsForCodes(missing);
    }
  }, [visible, listLoading, isSavedMode, loadReturnsForCodes]);

  // Auto-load trailing returns for holdings that mapped to an AMFI scheme code.
  useEffect(() => {
    if (!isHoldingsMode || listLoading) return;
    const codes = holdingRows.map((row) => row.code).filter(Boolean);
    const missing = codes.filter((code) => !loadedCodesRef.current.has(code));
    if (missing.length) loadReturnsForCodes(missing);
  }, [isHoldingsMode, listLoading, holdingRows, loadReturnsForCodes]);

  // Manual refresh for the holdings table: re-pull the Kite holdings and force
  // a fresh fetch of BOTH NAV feeds (AMFI master list + per-fund history) so the
  // cached values are bypassed and the latest NAV/value/P&L are recomputed.
  const handleRefreshHoldings = useCallback(async () => {
    if (!isHoldingsMode || refreshing) return;
    if (!hasSession()) {
      setHoldingsError('Log in to Kite, then open https://kite.zerodha.com/local-screener to see your holdings.');
      return;
    }
    setRefreshing(true);
    setHoldingsError('');
    try {
      const [schemesData, holdingsData, ordersData] = await Promise.all([
        loadMfSchemes({ force: true }).catch(() => null),
        fetchMfHoldings(),
        fetchMfOrders(),
      ]);
      if (schemesData) setSchemes(schemesData);
      const list = Array.isArray(holdingsData) ? holdingsData : [];
      setHoldings(list);
      setMfOrders(Array.isArray(ordersData) ? ordersData : []);

      const byIsin = new Map();
      (schemesData || schemes).forEach((scheme) => {
        if (scheme.isin) byIsin.set(scheme.isin, scheme);
      });
      const codes = list
        .map((holding) => byIsin.get(String(holding.tradingsymbol || '').trim())?.schemeCode)
        .filter(Boolean);

      // Drop cached returns/history so the NAV comes back from a live fetch.
      loadedCodesRef.current = new Set();
      setReturnsByCode({});
      if (codes.length) loadReturnsForCodes(codes, { force: true });
    } catch (error) {
      setHoldingsError(error?.message || 'Unable to refresh your mutual-fund holdings.');
    } finally {
      setRefreshing(false);
    }
  }, [isHoldingsMode, refreshing, schemes, loadReturnsForCodes]);

  const missingReturns = useMemo(
    () => visible.filter((item) => !(item.scheme.schemeCode in returnsByCode)).length,
    [visible, returnsByCode],
  );

  // Load NAV history for the selected scheme.
  useEffect(() => {
    if (!selected || !selected.schemeCode) {
      setSelectedHistory(null);
      return undefined;
    }
    const controller = new AbortController();
    setSelectedLoading(true);
    setSelectedHistory(null);
    loadMfHistory(selected.schemeCode, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setSelectedHistory(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSelectedHistory(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectedLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

  const setFilter = useCallback((patch) => {
    setActivePreset(null);
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (patch.schemeType && patch.schemeType !== prev.schemeType) next.subCategory = 'All';
      return next;
    });
  }, []);

  const applyPreset = useCallback((preset) => {
    const pool = preset.type === 'All' ? schemes : schemes.filter((s) => s.schemeType === preset.type);
    const subCategory = preset.subMatch
      ? resolveSubCategory(uniqueSorted(pool.map((s) => s.subCategory)), preset.subMatch)
      : 'All';
    setSelected(null);
    setActivePreset(preset.id);
    setSort(preset.sort || { key: 'r3y', dir: 'desc' });
    setFilters({
      ...DEFAULT_FILTERS,
      schemeType: preset.type,
      subCategory,
      plan: preset.plan || 'Direct',
      option: 'Growth',
      search: '',
    });
  }, [schemes]);

  const resetReturns = useCallback(() => {
    returnsGenRef.current += 1;
    loadedCodesRef.current = new Set();
    setReturnsByCode({});
    setReturnsLoading(false);
  }, []);

  const toggleSort = useCallback((key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: key === 'name' ? 'asc' : 'desc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const toggleCompare = useCallback((scheme) => {
    setCompare((prev) => {
      const exists = prev.some((item) => item.schemeCode === scheme.schemeCode);
      if (exists) return prev.filter((item) => item.schemeCode !== scheme.schemeCode);
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, scheme];
    });
  }, []);

  const inCompare = useCallback(
    (scheme) => compare.some((item) => item.schemeCode === scheme.schemeCode),
    [compare],
  );

  const selectedReturns = useMemo(
    () => (selectedHistory ? computeMfReturns(selectedHistory.series) : null),
    [selectedHistory],
  );

  const sortIndicator = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <>
      {isHoldingsMode ? (
        <main className="table-panel mf-panel">
          <div className="panel-title">
            <div>
              <div className="eyebrow">Mutual Funds</div>
              <h2>My Holdings</h2>
              <p>Your Zerodha mutual-fund holdings, enriched with NAV history &amp; returns from AMFI · mfapi.in.</p>
            </div>
            <div className="panel-title-actions">
              <button
                type="button"
                className="mf-refresh-btn"
                onClick={handleRefreshHoldings}
                disabled={refreshing || holdingsLoading}
                title="Re-fetch holdings and pull the latest NAV"
              >
                <span className={`mf-refresh-icon${refreshing ? ' spinning' : ''}`}>↻</span>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              <div className="status-pill">
                {holdingsLoading ? 'Loading' : `${holdingRows.length} fund${holdingRows.length === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>

          {holdingRows.length > 0 && (
            <div className="mf-holdings-overview">
              <div className="mf-holdings-summary">
                <div className="mf-holdings-summary-item">
                  <span>Invested</span>
                  <strong>{formatMoney(holdingsSummary.invested)}</strong>
                </div>
                <div className="mf-holdings-summary-item">
                  <span>Current</span>
                  <strong>{formatMoney(holdingsSummary.current)}</strong>
                </div>
                <div className="mf-holdings-summary-item">
                  <span>P&amp;L</span>
                  <strong className={toneClass(holdingsSummary.pnl)}>
                    {formatMoney(holdingsSummary.pnl)}
                    {holdingsSummary.invested > 0 && ` (${formatPct((holdingsSummary.pnl / holdingsSummary.invested) * 100)})`}
                  </strong>
                </div>
                <div className="mf-holdings-summary-item mf-xirr-card">
                  <span>Overall XIRR</span>
                  <strong className={toneClass(overallXirr)}>
                    {overallXirr != null ? `${overallXirr > 0 ? '+' : ''}${overallXirr.toFixed(2)}% p.a.` : '—'}
                  </strong>
                </div>
              </div>

              <MfAllocationPie rows={holdingRows} />
            </div>
          )}

          {holdingsError && <div className="error-box">{holdingsError}</div>}

          <div className="table-scroll">
            <table className="screener-table mf-table mf-holdings-table">
              <thead>
                <tr>
                  <th className="align-left">Scheme</th>
                  <th className="num-cell">Units</th>
                  <th className="num-cell">Avg NAV</th>
                  <th className="num-cell">NAV</th>
                  <th className="num-cell">Invested</th>
                  <th className="num-cell">Current</th>
                  <th className="num-cell">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {!holdingsLoading && holdingRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty-cell">
                      {holdingsError
                        ? 'Could not load your mutual-fund holdings.'
                        : 'No mutual-fund holdings found in your Zerodha account.'}
                    </td>
                  </tr>
                )}
                {holdingsLoading && holdingRows.length === 0 && !holdingsError && (
                  <tr>
                    <td colSpan={7} className="empty-cell">Loading your holdings…</td>
                  </tr>
                )}
                {holdingRows.map((row) => {
                  const selectedRow = Boolean(row.code) && selected?.schemeCode === row.code;
                  const ret = row.code ? returnsByCode[row.code] : null;
                  return (
                    <tr
                      key={row.key}
                      className={`${selectedRow ? 'selected-row' : ''}${row.code ? '' : ' mf-holdings-unlinked'}`}
                      onClick={() => row.code && setSelected(row.scheme)}
                    >
                      <td className="symbol-cell align-left">
                        <span className="symbol-text">
                          <span className="mf-name">{row.scheme.name}</span>
                          <span className="mf-sub">
                            {row.scheme.subCategory && <span className="mf-tag">{row.scheme.subCategory}</span>}
                            {row.holding.folio && <span className="mf-amc">Folio {row.holding.folio}</span>}
                            {ret?.r1y != null && <span className="mf-amc">1Y {formatPct(ret.r1y)}</span>}
                          </span>
                        </span>
                      </td>
                      <td className="num-cell">{formatUnits(row.units)}</td>
                      <td className="num-cell">{formatNav(row.avg)}</td>
                      <td className="num-cell">
                        {formatNav(row.ltp)}
                        {row.navDate && (
                          <small
                            className="mf-holdings-navdate"
                            title={`NAV as of ${row.navDate}`}
                          >
                            {row.navDate}
                          </small>
                        )}
                      </td>
                      <td className="num-cell">{formatMoney(row.invested)}</td>
                      <td className="num-cell">{formatMoney(row.current)}</td>
                      <td className={`num-cell ${toneClass(row.pnl)}`}>
                        <span className="mf-holdings-pnl">{formatMoney(row.pnl)}</span>
                        <small className="mf-holdings-pnl-pct">{formatPct(row.pnlPct)}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </main>
      ) : (
      <main className="table-panel mf-panel">
        {!isSavedMode && (
          <div className="panel-title">
            <div>
              <div className="eyebrow">Mutual Funds</div>
              <h2>Fund Screener</h2>
              <p>Screen open & close-ended schemes by category, AMC and trailing returns. NAV data from AMFI · returns from mfapi.in.</p>
            </div>
            <div className="panel-title-actions">
              <div className="status-pill">
                {listLoading ? 'Loading' : `${baseList.length} funds`}
              </div>
            </div>
          </div>
        )}

        {!isSavedMode && (
          <div className="mf-presets">
            <span className="mf-presets-label">Screens</span>
            {MF_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`mf-preset-chip${activePreset === preset.id ? ' active' : ''}`}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}

        {!isSavedMode && (
          <div className="mf-filters">
            <input
              type="search"
              className="mf-search"
              placeholder="Search scheme name…"
              value={filters.search}
              onChange={(event) => setFilter({ search: event.target.value })}
            />
            <select value={filters.schemeType} onChange={(e) => setFilter({ schemeType: e.target.value })}>
              <option value="All">All types</option>
              {typeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <select value={filters.subCategory} onChange={(e) => setFilter({ subCategory: e.target.value })}>
              <option value="All">All categories</option>
              {subCategoryOptions.map((sub) => <option key={sub} value={sub}>{sub}</option>)}
            </select>
            <select value={filters.amc} onChange={(e) => setFilter({ amc: e.target.value })}>
              <option value="All">All AMCs</option>
              {amcOptions.map((amc) => <option key={amc} value={amc}>{amc}</option>)}
            </select>
            <select value={filters.plan} onChange={(e) => setFilter({ plan: e.target.value })}>
              <option value="All">Direct + Regular</option>
              <option value="Direct">Direct</option>
              <option value="Regular">Regular</option>
            </select>
            <select value={filters.option} onChange={(e) => setFilter({ option: e.target.value })}>
              <option value="All">Growth + IDCW</option>
              <option value="Growth">Growth</option>
              <option value="IDCW">IDCW</option>
            </select>
            <button
              type="button"
              className="mf-filter-reset"
              onClick={() => { setActivePreset(null); setFilters(DEFAULT_FILTERS); }}
            >
              Reset
            </button>
          </div>
        )}

        <div className="mf-toolbar">
          <span className="mf-toolbar-status">
            {isSavedMode
              ? `${baseList.length} saved fund${baseList.length === 1 ? '' : 's'}`
              : `Showing ${visible.length} of ${sortedList.length}`}
            {returnsLoading && ' · loading returns…'}
          </span>
          {!isSavedMode && missingReturns > 0 && !returnsLoading && (
            <button
              type="button"
              className="mf-load-returns"
              disabled={missingReturns > MAX_MANUAL_RETURNS}
              onClick={() => loadReturnsForCodes(visible.map((item) => item.scheme.schemeCode))}
              title={missingReturns > MAX_MANUAL_RETURNS
                ? `Refine filters to under ${MAX_MANUAL_RETURNS} funds to load returns`
                : 'Fetch trailing returns for the visible funds'}
            >
              Load returns ({missingReturns})
            </button>
          )}
          {compare.length > 0 && (
            <button type="button" className="mf-compare-open" onClick={() => setCompareOpen(true)}>
              Compare ({compare.length})
            </button>
          )}
        </div>

        {listError && <div className="error-box">{listError}</div>}

        <div className="table-scroll">
          <table className="screener-table mf-table">
            <thead>
              <tr>
                <th className="sortable align-left" onClick={() => toggleSort('name')}>
                  Scheme{sortIndicator('name')}
                </th>
                <th className="sortable num-cell" onClick={() => toggleSort('nav')}>NAV{sortIndicator('nav')}</th>
                <th className="sortable num-cell" onClick={() => toggleSort('r1y')}>1Y{sortIndicator('r1y')}</th>
                <th className="sortable num-cell" onClick={() => toggleSort('r3y')}>3Y{sortIndicator('r3y')}</th>
                <th className="sortable num-cell" onClick={() => toggleSort('r5y')}>5Y{sortIndicator('r5y')}</th>
                <th className="num-cell mf-col-actions">Compare</th>
              </tr>
            </thead>
            <tbody>
              {!listLoading && visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    {isSavedMode
                      ? 'No saved funds yet. Star any scheme in the Fund Screener to save it here.'
                      : 'No funds match these filters.'}
                  </td>
                </tr>
              )}

              {visible.map(({ scheme, ret }) => {
                const selectedRow = selected?.schemeCode === scheme.schemeCode;
                const saved = isFundSaved?.(scheme);
                return (
                  <tr
                    key={scheme.schemeCode}
                    className={selectedRow ? 'selected-row' : ''}
                    onClick={() => setSelected(scheme)}
                  >
                    <td className="symbol-cell align-left">
                      <span className="symbol-wrap">
                        <button
                          type="button"
                          className={`bookmark-star${saved ? ' active' : ''}`}
                          title={saved ? 'Remove from saved funds' : 'Save fund'}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleSave?.(scheme);
                          }}
                        >
                          {saved ? '★' : '☆'}
                        </button>
                        <span className="symbol-text">
                          <span className="mf-name">{scheme.name}</span>
                          <span className="mf-sub">
                            <span className="mf-tag">{scheme.subCategory}</span>
                            <span className="mf-amc">{scheme.amc?.replace(/ Mutual Fund$/i, '')}</span>
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="num-cell">{formatNav(ret?.latestNav ?? scheme.nav)}</td>
                    <td className={`num-cell ${toneClass(ret?.r1y)}`}>{formatPct(ret?.r1y)}</td>
                    <td className={`num-cell ${toneClass(ret?.r3y)}`}>{formatPct(ret?.r3y)}</td>
                    <td className={`num-cell ${toneClass(ret?.r5y)}`}>{formatPct(ret?.r5y)}</td>
                    <td className="num-cell mf-col-actions">
                      <button
                        type="button"
                        className={`mf-compare-toggle${inCompare(scheme) ? ' active' : ''}`}
                        title={inCompare(scheme) ? 'Remove from comparison' : 'Add to comparison'}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleCompare(scheme);
                        }}
                      >
                        {inCompare(scheme) ? '−' : '+'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {sortedList.length > DISPLAY_LIMIT && (
            <div className="table-sentinel">
              Showing first {DISPLAY_LIMIT} — refine filters to narrow results.
            </div>
          )}
        </div>
      </main>
      )}

      <aside className="chart-panel mf-detail-panel">
        {!selected ? (
          <div className="chart-placeholder">Select a fund to see its NAV history and returns.</div>
        ) : (
          <>
            <div className="mf-detail-head">
              <h2 className="mf-detail-name">{selected.name}</h2>
              <div className="mf-detail-meta">
                <span className="mf-tag">{selected.schemeType}</span>
                <span className="mf-tag">{selected.subCategory}</span>
                <span>{selected.amc}</span>
              </div>
              <div className="mf-detail-actions">
                <button
                  type="button"
                  className={`mf-detail-btn${isFundSaved?.(selected) ? ' active' : ''}`}
                  onClick={() => onToggleSave?.(selected)}
                >
                  {isFundSaved?.(selected) ? '★ Saved' : '☆ Save'}
                </button>
                <button
                  type="button"
                  className={`mf-detail-btn${inCompare(selected) ? ' active' : ''}`}
                  onClick={() => toggleCompare(selected)}
                >
                  {inCompare(selected) ? '− Comparing' : '+ Compare'}
                </button>
                <button
                  type="button"
                  className="mf-detail-btn mf-detail-btn-insights"
                  onClick={() => setInsightsOpen(true)}
                  disabled={!selected.isin}
                  title={selected.isin ? 'Deep-dive: ratings, holdings, risk & peers' : 'No ISIN available for this scheme'}
                >
                  ◈ Insights
                </button>
              </div>
            </div>

            <div className="mf-detail-chart">
              {selectedLoading && <div className="chart-placeholder">Loading NAV history…</div>}
              {!selectedLoading && selectedHistory?.series?.length > 1 && (
                <MfNavChart
                  series={selectedHistory.series}
                  rangeId={selectedRange}
                  onRangeChange={setSelectedRange}
                />
              )}
              {!selectedLoading && !(selectedHistory?.series?.length > 1) && (
                <div className="chart-placeholder">No NAV history available for this scheme.</div>
              )}
            </div>

            <div className="mf-returns-card">
              <div className="mf-returns-row">
                <span>Latest NAV</span>
                <strong>{formatNav(selectedReturns?.latestNav ?? selected.nav)}</strong>
              </div>
              <div className="mf-returns-grid">
                <MfReturn label="YTD" value={selectedReturns?.rYtd} />
                <MfReturn label="1Y" value={selectedReturns?.r1y} />
                <MfReturn label="3Y (CAGR)" value={selectedReturns?.r3y} />
                <MfReturn label="5Y (CAGR)" value={selectedReturns?.r5y} />
                <MfReturn label="Since inception" value={selectedReturns?.rInception} />
              </div>
              {selectedReturns?.inceptionDate && (
                <div className="mf-returns-note">
                  History since {new Date(selectedReturns.inceptionDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}.
                  3Y / 5Y / inception are annualised (CAGR).
                </div>
              )}
            </div>
          </>
        )}
      </aside>

      {insightsOpen && selected && (
        <MfInsightsModal scheme={selected} onClose={() => setInsightsOpen(false)} />
      )}

      {compareOpen && compare.length > 0 && (
        <MfCompareModal
          schemes={compare}
          onClose={() => setCompareOpen(false)}
          onRemove={(scheme) => {
            setCompare((prev) => {
              const next = prev.filter((item) => item.schemeCode !== scheme.schemeCode);
              if (next.length === 0) setCompareOpen(false);
              return next;
            });
          }}
        />
      )}
    </>
  );
}

function MfReturn({ label, value }) {
  return (
    <div className="mf-return-cell">
      <span className="mf-return-label">{label}</span>
      <span className={`mf-return-value ${toneClass(value)}`}>{formatPct(value)}</span>
    </div>
  );
}
