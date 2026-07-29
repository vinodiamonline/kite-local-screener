import { buildSectorScreeners } from './sectorScreeners';

export const MARKET_CAP_BUCKETS = [
  { id: 'all', label: 'All', query: '' },
  { id: 'large', label: 'Large', query: 'market_cap>20000' },
  { id: 'mid', label: 'Mid', query: 'market_cap>=5000&market_cap<=20000' },
  { id: 'small', label: 'Small', query: 'market_cap>=100&market_cap<5000' },
  { id: 'micro', label: 'Micro', query: 'market_cap>0&market_cap<100' },
];

/** Classify screener market_cap (Cr) into Large / Mid / Small / Micro. */
export function getMarketCapBucket(marketCap) {
  const cap = Number(marketCap);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  if (cap > 20000) return MARKET_CAP_BUCKETS.find((b) => b.id === 'large');
  if (cap >= 5000) return MARKET_CAP_BUCKETS.find((b) => b.id === 'mid');
  if (cap >= 100) return MARKET_CAP_BUCKETS.find((b) => b.id === 'small');
  return MARKET_CAP_BUCKETS.find((b) => b.id === 'micro');
}

export const DEFAULT_COLUMNS = [
  { key: 'tradingsymbol', label: 'Symbol', type: 'symbol' },
  { key: 'change_percent', label: 'Chg%', type: 'percent' },
  { key: 'last_price', label: 'LTP', type: 'number' },
];

export const BOOKMARKS_SCREENER_ID = 'bookmarks';
export const HIDDEN_SCREENER_ID = 'hidden';
export const DASHBOARD_SCREENER_ID = 'dashboard';
export const POSITIONS_SCREENER_ID = 'positions';
export const HOLDINGS_SCREENER_ID = 'holdings';
export const MUTUAL_FUNDS_SCREENER_ID = 'mutual-funds';
export const MF_SAVED_SCREENER_ID = 'mutual-funds-saved';
export const MF_HOLDINGS_SCREENER_ID = 'mutual-funds-holdings';
export const ETF_PICKS_SCREENER_ID = 'etf-picks';

export const DASHBOARD_GAINERS = {
  id: 'dash-gainers',
  title: 'Top Gainers',
  query: 'change_percent>0',
  order_by: 'change_percent',
  order: 'desc',
};

export const DASHBOARD_LOSERS = {
  id: 'dash-losers',
  title: 'Top Losers',
  query: 'change_percent<0',
  order_by: 'change_percent',
  order: 'asc',
};

export const DASHBOARD_SECTOR = {
  id: 'dash-sector',
  title: 'Sector Screener',
  query: 'market_cap>0',
  order_by: 'market_cap',
  order: 'desc',
};

/** Minimum stocks loaded for dashboard sector grouping (more = better per-sector coverage). */
export const SECTOR_SCREENER_MIN_ROWS = 2500;

/**
 * Dashboard sector panel: priority groups shown first (top), related sectors adjacent.
 * Each inner array is one block in display order; only sectors present in data are shown.
 */
export const SECTOR_DASHBOARD_PRIORITY = [
  ['Banks'],
  ['Pharmaceuticals'],
  [
    'Passenger Vehicle',
    'Commercial Vehicle',
    'Auto Ancillary',
    'Automobiles',
    'Two & Three Wheelers',
    'Automobiles - Dealers & Distributors',
  ],
  ['Real Estate'],
  ['Housing Finance'],
  ['Cement'],
  ['Asset Management'],
  ['Hospital & Healthcare', 'Diagnostics', 'Medical Equipment'],
  [
    'Metal - Ferrous',
    'Metal - Non Ferrous',
    'Aluminium',
    'Steel & Iron Products',
    'Steel Pipes',
    'Steel/Sponge /Pig Iron',
    'Mining & Minerals',
    'Ferro & Silica Manganese',
  ],
  [
    'Finance',
    'Finance - NBFC',
    'Finance - Lending',
    'Finance - Investment',
    'Microfinance',
    'Fintech',
    'Insurance',
    'Stock Broking',
  ],
  [
    'Household & Personal Products',
    'Consumer Food',
    'Consumer Durables',
    'Dairy Products',
    'Edible Oil',
    'Tobacco',
    'Alcoholic Beverages',
  ],
  ['IT - Software'],
];

/** Short labels for heatmap group headers (same order as SECTOR_DASHBOARD_PRIORITY). */
export const SECTOR_DASHBOARD_GROUP_LABELS = [
  'Banks',
  'Pharma',
  'Auto',
  'Real Estate',
  'Housing Finance',
  'Cement',
  'Asset Mgmt',
  'Healthcare',
  'Metal',
  'Finance',
  'FMCG',
  'IT',
];

const PRIORITY_SECTOR_SET = new Set(SECTOR_DASHBOARD_PRIORITY.flat());

export function sectorDashboardSortKey(sectorName) {
  const name = (sectorName || '').trim();
  for (let groupIdx = 0; groupIdx < SECTOR_DASHBOARD_PRIORITY.length; groupIdx += 1) {
    const pos = SECTOR_DASHBOARD_PRIORITY[groupIdx].indexOf(name);
    if (pos >= 0) return groupIdx * 100 + pos;
  }
  return null;
}

export function isPrioritySector(sectorName) {
  return PRIORITY_SECTOR_SET.has((sectorName || '').trim());
}

export function compareSectorOrder(a, b) {
  const keyA = sectorDashboardSortKey(a.sector ?? a.label);
  const keyB = sectorDashboardSortKey(b.sector ?? b.label);
  const aPriority = keyA != null;
  const bPriority = keyB != null;
  if (aPriority && bPriority) return keyA - keyB;
  if (aPriority) return -1;
  if (bPriority) return 1;
  return (Number(b.avg) || 0) - (Number(a.avg) || 0);
}

/** Split sector stats into labeled priority groups + other sectors (by avg desc). */
export function buildSectorHeatmapSections(items) {
  const byLabel = new Map(items.map((item) => [item.label, item]));

  const prioritySections = SECTOR_DASHBOARD_PRIORITY.map((sectors, index) => ({
    label: SECTOR_DASHBOARD_GROUP_LABELS[index] || `Group ${index + 1}`,
    items: sectors.map((name) => byLabel.get(name)).filter(Boolean),
  })).filter((section) => section.items.length);

  const others = items
    .filter((item) => !isPrioritySector(item.label))
    .sort((a, b) => (Number(b.avg) || 0) - (Number(a.avg) || 0));

  return { prioritySections, others };
}

export function makeBookmarksScreener() {
  return {
    id: BOOKMARKS_SCREENER_ID,
    category: 'Bookmarks',
    title: 'Bookmarks',
    description: 'Starred symbols from screeners',
    local: true,
    isBookmarks: true,
    columns: DEFAULT_COLUMNS,
  };
}

export function makeHiddenScreener() {
  return {
    id: HIDDEN_SCREENER_ID,
    category: 'Hidden',
    title: 'Hidden',
    description: 'Globally hidden symbols',
    local: true,
    isHidden: true,
    columns: DEFAULT_COLUMNS,
  };
}

export function makeWatchlistScreener(id, name) {
  return {
    id,
    category: 'Watchlists',
    title: name,
    description: 'Live watchlist — search to add symbols',
    local: true,
    isWatchlist: true,
    columns: DEFAULT_COLUMNS,
  };
}

export const BASE_SCREENERS = [
  {
    id: 'top-gainers',
    category: 'Price Action',
    title: 'Top Gainers',
    description: 'Highest price increase today',
    query: 'change_percent>0',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: 'top-losers',
    category: 'Price Action',
    title: 'Top Losers',
    description: 'Highest price decline today',
    query: 'change_percent<0',
    order_by: 'change_percent',
    order: 'asc',
  },
  {
    id: 'high-volatility',
    category: 'Price Action',
    title: 'High volatility Stocks',
    description: 'Intraday range exceeds 4% of previous close',
    query: 'close>0&((high-low)/close)*100>=4',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: '52w-high-breakout',
    category: 'Price Action',
    title: '52W High Breakout',
    description: 'Hitting a new 52-week high today',
    query: 'week_52_high>0&high>=week_52_high',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: '52w-low-breakdown',
    category: 'Price Action',
    title: '52W Low Breakdown',
    description: 'Hitting a new 52-week low today',
    query: 'week_52_low>0&low<=week_52_low',
    order_by: 'change_percent',
    order: 'asc',
  },
  {
    id: 'near-52w-high',
    category: 'Price Action',
    title: 'Near 52W High',
    description: 'Trading within 2% of 52-week high',
    query: 'week_52_high>0&last_price>=week_52_high*0.98',
    order_by: '((week_52_high-last_price)/week_52_high)*100',
    order: 'asc',
  },
  {
    id: 'near-52w-low',
    category: 'Price Action',
    title: 'Near 52W Low',
    description: 'Trading within 2% of 52-week low',
    query: 'week_52_low>0&last_price<=week_52_low*1.02',
    order_by: '((last_price-week_52_low)/week_52_low)*100',
    order: 'asc',
  },
  {
    id: 'intraday-bullish',
    category: 'Price Action',
    title: 'Intraday Bullish Trend',
    description: 'Near day high, above VWAP',
    query: 'last_price>open&last_price>average_price&last_price>=high*0.995',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: 'intraday-bearish',
    category: 'Price Action',
    title: 'Intraday Bearish Trend',
    description: 'Near day low, below VWAP',
    query: 'last_price<open&last_price<average_price&last_price<=low*1.005',
    order_by: 'change_percent',
    order: 'asc',
  },
  {
    id: 'gap-up',
    category: 'Price Action',
    title: 'Gap Up',
    description: 'Opened 2%+ higher than previous close',
    query: 'close>0&open>close*1.02',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: 'gap-down',
    category: 'Price Action',
    title: 'Gap Down',
    description: 'Opened 2%+ lower than previous close',
    query: 'close>0&open<close*0.98&open>0',
    order_by: 'change_percent',
    order: 'asc',
  },
  {
    id: 'recovery',
    category: 'Price Action',
    title: 'Recovery',
    description: 'Opened weak, recovered above previous close',
    query: 'close>0&open<close&last_price>close',
    order_by: '((last_price-close)/close)*100',
    order: 'desc',
  },
  {
    id: 'most-active',
    category: 'Price Action',
    title: 'Most Active',
    description: 'Highest traded value today',
    query: 'volume>0&average_price>0',
    order_by: 'volume*average_price',
    order: 'desc',
  },
  {
    id: 'high-near-open',
    category: 'Price Action',
    title: 'High Near Open',
    description: 'Day high equals open — bearish',
    query: 'open>0&high<=open*1.001&last_price<open',
    order_by: 'change_percent',
    order: 'asc',
  },
  {
    id: 'low-near-open',
    category: 'Price Action',
    title: 'Low Near Open',
    description: 'Day low equals open — bullish',
    query: 'open>0&low>=open*0.999&last_price>open',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: '52w-high-momentum',
    category: 'Momentum',
    title: '52W High Momentum',
    description: 'Near 52-week high, green today, above VWAP, and actively traded',
    query: 'week_52_high>0&last_price>=week_52_high*0.98&change_percent>0&last_price>average_price&average_price>0&volume>0',
    order_by: 'change_percent',
    order: 'desc',
  },
  {
    id: 'market-cap',
    category: 'Fundamentals',
    title: 'Market Cap',
    description: 'All stocks sorted by market cap',
    query: 'market_cap>0',
    order_by: 'market_cap',
    order: 'desc',
  },
  {
    id: 'pe-low',
    category: 'Fundamentals',
    title: 'P/E Low',
    description: 'Positive PE, lowest first',
    query: 'pe>0',
    order_by: 'pe',
    order: 'asc',
  },
  {
    id: 'growth-stocks',
    category: 'Fundamentals',
    title: 'Growth Stocks',
    description: 'Revenue and profit growth above 15% YoY',
    query: 'revenue_growth_yoy>15&pat_growth_yoy>15',
    order_by: 'pat_growth_yoy',
    order: 'desc',
  },
  {
    id: 'quality-value',
    category: 'Fundamentals',
    title: 'Quality Value',
    description: 'Low PE, high ROE, low debt',
    query: 'pe>0&pe<=20&roe>15&debt_to_equity>=0&debt_to_equity<0.5&free_cash_flow>0',
    order_by: 'pe',
    order: 'asc',
  },
  {
    id: 'debt-free-compounders',
    category: 'Fundamentals',
    title: 'Debt Free Compounders',
    description: 'Near-zero debt with high ROE and profit growth',
    query: 'debt_to_equity>=0&debt_to_equity<0.5&roe>15&free_cash_flow>0&pat_growth_yoy>10&market_cap>5000',
    order_by: 'roe',
    order: 'desc',
  },
  {
    id: 'large-cap-stability',
    category: 'Fundamentals',
    title: 'Large Cap Stability',
    description: 'Large caps with strong ROE and low debt',
    query: 'market_cap>20000&roe>15&debt_to_equity>=0&debt_to_equity<0.5&free_cash_flow>0',
    order_by: 'market_cap',
    order: 'desc',
  },
];

export const SCREENERS = [
  ...BASE_SCREENERS,
  ...buildSectorScreeners(),
];

export const SCREENER_CATEGORY_ORDER = ['Price Action', 'Momentum', 'Fundamentals', 'Sectors'];

export const CATEGORIES = SCREENER_CATEGORY_ORDER.filter(
  (category) => SCREENERS.some((screener) => screener.category === category),
);
