import { lookupTokenFromScreenerCache, warmScreenerTokenCache } from './screenerTokenCache';
import { parseInstrumentToken } from './instrumentToken';

// Kite moved the screener behind the OMS gateway. The old `/screener/instruments`
// route now returns 404 "Route not found". The current endpoint lives under
// `/oms/`, authenticates with the enctoken (like every other OMS call) and pages
// with `page`/`per_page` instead of `offset`/`limit`.
const API_URL = '/oms/screener/instruments';

export const TARGET_ROWS_DEFAULT = 500;
// The screener API only honors a page size up to 100. Any `limit` above 100 is
// silently treated as the tiny default (~20 rows), which forces many more
// requests. Requesting exactly 100 returns a full page and minimizes calls.
export const BATCH_SIZE = 100;
export const MAX_HISTORICAL_DAYS = 2000;
export const MAX_HISTORICAL_CHUNKS = 15;
const SCREENER_MAX_CONCURRENT = 4;
const SCREENER_MIN_GAP_MS = 50;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export function isKiteEmbedded() {
  return (
    window.location.hostname === 'kite.zerodha.com' &&
    window.location.pathname.startsWith('/local-screener')
  );
}

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

/** Kite web app persists session fields via storejs in localStorage — read only, never written by us. */
function readStoreJs(key) {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return '';
    return stored.replaceAll('"', '').trim();
  } catch {
    return '';
  }
}

export function hasSession() {
  return Boolean(readCookie('public_token'));
}

/** Global limiter: max concurrent screener calls + minimum gap between dispatches. */
let screenerInFlight = 0;
const screenerWaitQueue = [];
let screenerLastDispatchAt = 0;

async function waitForScreenerSlot(signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (screenerInFlight >= SCREENER_MAX_CONCURRENT) {
    await new Promise((resolve, reject) => {
      const entry = () => resolve();
      screenerWaitQueue.push(entry);
      signal?.addEventListener('abort', () => {
        const idx = screenerWaitQueue.indexOf(entry);
        if (idx >= 0) screenerWaitQueue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const elapsed = Date.now() - screenerLastDispatchAt;
  const gap = Math.max(0, SCREENER_MIN_GAP_MS - elapsed);
  if (gap > 0) await sleep(gap, signal);
  screenerLastDispatchAt = Date.now();
  screenerInFlight += 1;
}

function releaseScreenerSlot() {
  screenerInFlight = Math.max(0, screenerInFlight - 1);
  if (screenerWaitQueue.length && screenerInFlight < SCREENER_MAX_CONCURRENT) {
    const next = screenerWaitQueue.shift();
    next();
  }
}

async function withScreenerSlot(signal, fn) {
  await waitForScreenerSlot(signal);
  try {
    return await fn();
  } finally {
    releaseScreenerSlot();
  }
}

// The screener body used to be `{ query, order_by, order, limit, offset, tags }`.
// The OMS screener keeps `query`/`order_by`/`order`/`tags` but pages by 1-based
// `page` + `per_page`. Callers still pass `limit`/`offset`, so translate here in
// one place. `offset` always advances in whole `per_page` steps, so the page
// index divides cleanly.
function toScreenerBody({ limit, offset, tags, ...rest }) {
  const perPage = Math.min(Math.max(1, Number(limit) || BATCH_SIZE), BATCH_SIZE);
  const page = Math.floor((Number(offset) || 0) / perPage) + 1;
  return {
    ...rest,
    tags: Array.isArray(tags) ? tags : [],
    per_page: perPage,
    page,
  };
}

async function fetchScreenerDirect(body, signal) {
  const enctoken = readEnctoken();

  if (!enctoken) {
    throw new Error('Login to Kite first, then open https://kite.zerodha.com/local-screener');
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      authorization: `enctoken ${enctoken}`,
      'x-kite-userid': getUserId(),
      'x-kite-app-uuid': getAppUuid(),
      'x-kite-version': '3.0.0',
    },
    body: JSON.stringify(toScreenerBody(body)),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok || payload?.status === 'error') {
    throw new Error(payload?.message || `Kite screener failed with HTTP ${response.status}`);
  }

  return {
    raw: payload,
    rows: extractRows(payload),
    total: extractTotal(payload),
  };
}

export async function fetchScreener(body, signal) {
  if (!isKiteEmbedded()) {
    throw new Error('Open https://kite.zerodha.com/local-screener with the extension enabled.');
  }

  return withScreenerSlot(signal, () => fetchScreenerDirect(body, signal));
}

// Hard cap on requests per fetch, so a small-page API response can never spiral
// into a "Too many requests" storm. At 100 rows/page this allows ~3000 rows.
const MAX_PAGE_REQUESTS = 30;

export async function fetchUpToRows(bodyTemplate, { targetRows = TARGET_ROWS_DEFAULT, signal } = {}) {
  const rows = [];
  let total;
  let offset = 0;
  // Page purely by offset. The API silently caps an over-large `limit` (returns
  // a small default page), so we always request BATCH_SIZE and advance by
  // however many rows actually came back. We stop on an empty page, when we hit
  // the reported total, when the target is met, or when the request cap is hit —
  // NOT on a short page, since the API can return fewer than requested.
  const limit = BATCH_SIZE;
  let requests = 0;

  while (rows.length < targetRows && requests < MAX_PAGE_REQUESTS) {
    let page;

    try {
      page = await fetchScreener({ ...bodyTemplate, limit, offset }, signal);
    } catch (error) {
      if (rows.length > 0) break;
      throw error;
    }

    requests += 1;
    total = page.total ?? total;

    if (!page.rows.length) break;

    rows.push(...page.rows);
    offset += page.rows.length;

    if (total && rows.length >= total) break;
    if (rows.length >= targetRows) break;
  }

  const hasMore = total ? rows.length < total : false;

  return { rows, total, hasMore, nextOffset: rows.length };
}

export async function fetchMoreRows(bodyTemplate, { offset, signal } = {}) {
  const page = await fetchScreener({ ...bodyTemplate, limit: BATCH_SIZE, offset }, signal);
  const total = page.total;
  const hasMore = total ? offset + page.rows.length < total : page.rows.length === BATCH_SIZE;

  return {
    rows: page.rows,
    total,
    hasMore,
    nextOffset: offset + page.rows.length,
  };
}

// Kite web OMS positions endpoint (same-origin, enctoken session). Returns
// { net, day } arrays. Note: `pnl`/`last_price` here can be stale — the app
// recomputes live PNL from websocket LTP using the standard Kite formula.
export async function fetchPositions(signal) {
  const response = await fetch('/oms/portfolio/positions', {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: authHeaders(),
  });

  const payload = await response.json();

  if (!response.ok || payload?.status !== 'success') {
    throw new Error(payload?.message || `Positions failed with HTTP ${response.status}`);
  }

  return {
    net: payload?.data?.net || [],
    day: payload?.data?.day || [],
  };
}

// Long-term equity holdings (demat). Returns a flat array.
export async function fetchHoldings(signal) {
  const response = await fetch('/oms/portfolio/holdings', {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: authHeaders(),
  });

  const payload = await response.json();

  if (!response.ok || payload?.status !== 'success') {
    throw new Error(payload?.message || `Holdings failed with HTTP ${response.status}`);
  }

  return payload?.data || [];
}

// Mutual-fund holdings (Coin). Returns a flat array; each entry carries the
// scheme ISIN in `tradingsymbol`, allotted units, average/last NAV and P&L.
export async function fetchMfHoldings(signal) {
  const response = await fetch('/oms/mf/holdings', {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: authHeaders(),
  });

  const payload = await response.json();

  if (!response.ok || payload?.status !== 'success') {
    throw new Error(payload?.message || `MF holdings failed with HTTP ${response.status}`);
  }

  return payload?.data || [];
}

// Mutual-fund order history (Coin). Returns list of executed/pending orders.
export async function fetchMfOrders(signal) {
  try {
    const response = await fetch('/oms/mf/orders', {
      method: 'GET',
      credentials: 'include',
      signal,
      headers: authHeaders(),
    });
    const payload = await response.json();
    if (!response.ok || payload?.status !== 'success') return [];
    return payload?.data || [];
  } catch {
    return [];
  }
}

export function buildKiteChartUrl({ exchange = 'NSE', symbol, token }) {
  if (!symbol || !token) return '';
  return `https://kite.zerodha.com/markets/ext/chart/web/tvc/${exchange}/${symbol}/${token}`;
}

function readEnctoken() {
  return readCookie('enctoken') || readStoreJs('__storejs_kite_enctoken');
}

function authHeaders(extra = {}) {
  const enctoken = readEnctoken();
  if (!enctoken) {
    throw new Error('Kite session token not found. Open Kite, log in, then reload this page.');
  }

  return {
    accept: 'application/json, text/plain, */*',
    authorization: `enctoken ${enctoken}`,
    ...extra,
  };
}

/** Auth headers for OMS calls (exposed for the order module). */
export function getAuthHeaders(extra = {}) {
  return authHeaders(extra);
}

/** Kite app instance uuid (from Kite's storejs localStorage). */
export function getAppUuid() {
  return readStoreJs('__storejs_kite_app_uuid');
}

/** Current Kite user id (cookie, then Kite's storejs localStorage). */
export function getUserId() {
  return readCookie('user_id') || readStoreJs('__storejs_kite_user_id');
}

function symbolsMatch(left, right) {
  return String(left || '').trim().toUpperCase() === String(right || '').trim().toUpperCase();
}

function segmentsToTry(entry) {
  const primary = entry?.segment || entry?.exchange || 'NSE';
  return [...new Set([primary, 'NSE', 'BSE'].filter((segment) => segment && segment !== 'INDICES'))];
}

async function fetchQuoteRow(entry, signal) {
  const symbol = String(entry?.tradingsymbol || entry?.symbol || '').trim();
  if (!symbol) return { row: null, token: null };

  try {
    await warmScreenerTokenCache(signal);
    const cached = lookupTokenFromScreenerCache(entry);
    if (cached) {
      return { row: null, token: cached };
    }
  } catch {
    // cache not ready — fall through to per-symbol screener lookup
  }

  for (const segment of segmentsToTry(entry)) {
    try {
      const page = await fetchScreener({
        query: `tradingsymbol = "${symbol}"&segment = "${segment}"`,
        limit: 1,
        offset: 0,
      }, signal);
      const row = page.rows?.[0];
      if (row && symbolsMatch(row.tradingsymbol, symbol)) {
        return { row, token: row.instrument_token ? Number(row.instrument_token) : null };
      }
    } catch {
      // try next segment
    }
  }

  const token = parseInstrumentToken(entry?.instrument_token || entry?.token);
  if (token) {
    try {
      const page = await fetchScreener(
        { query: `instrument_token = ${token}`, limit: 1, offset: 0 },
        signal,
      );
      const row = page.rows?.[0];
      if (row && symbolsMatch(row.tradingsymbol, symbol)) {
        return { row, token: Number(row.instrument_token || token) };
      }
    } catch {
      // ignore
    }
  }

  return { row: null, token: null };
}

/** Fetch one instrument's full screener row via direct symbol/token match. */
export async function fetchInstrumentRow(entry, signal) {
  const { row } = await fetchQuoteRow(entry, signal);
  return row;
}

export function getEnctoken() {
  return readEnctoken();
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseCandleDate(raw) {
  if (typeof raw === 'string') {
    const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(raw);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function candleKey(candle) {
  return String(candle?.[0] ?? '');
}

async function fetchHistoricalRange(token, interval, fromDate, toDate, signal) {
  const url = `/oms/instruments/historical/${token}/${interval}?oi=0&from=${formatDate(fromDate)}&to=${formatDate(toDate)}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: authHeaders(),
  });

  const payload = await response.json();

  if (!response.ok || payload?.status !== 'success') {
    throw new Error(payload?.message || `Historical failed with HTTP ${response.status}`);
  }

  return payload?.data?.candles || [];
}

async function fetchHistoricalChunked(token, interval, signal) {
  const merged = new Map();
  let to = new Date();
  const earliest = new Date(2000, 0, 1);

  for (let chunk = 0; chunk < MAX_HISTORICAL_CHUNKS; chunk += 1) {
    const from = addDays(to, -(MAX_HISTORICAL_DAYS - 1));
    const boundedFrom = from < earliest ? earliest : from;
    const candles = await fetchHistoricalRange(token, interval, boundedFrom, to, signal);

    if (!candles.length) break;

    const beforeSize = merged.size;
    candles.forEach((candle) => {
      const key = candleKey(candle);
      if (key) merged.set(key, candle);
    });

    if (merged.size === beforeSize) break;

    to = addDays(boundedFrom, -1);
    if (to < earliest) break;
  }

  return [...merged.values()].sort(
    (left, right) => parseCandleDate(left[0]) - parseCandleDate(right[0]),
  );
}

function istDateString(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istDateOffset(daysBack = 0) {
  const anchor = new Date(Date.now() - daysBack * 86400000);
  return istDateString(anchor);
}

async function fetchIntradayDay(token, interval, day, signal) {
  const url = `/oms/instruments/historical/${token}/${interval}?oi=0&from=${day}&to=${day}`;

  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    signal,
    headers: authHeaders(),
  });

  const payload = await response.json();

  if (!response.ok || payload?.status !== 'success') {
    throw new Error(payload?.message || `Historical failed with HTTP ${response.status}`);
  }

  return payload?.data?.candles || [];
}

/** Walk back calendar days until Kite returns sessions (handles weekends + holidays). */
async function fetchIntradaySession(token, interval = '5minute', sessions = 1, signal) {
  const MAX_LOOKBACK = Math.max(15, sessions * 5);
  const sessionBuckets = [];

  for (let daysBack = 0; daysBack <= MAX_LOOKBACK; daysBack += 1) {
    const sessionDate = istDateOffset(daysBack);
    const candles = await fetchIntradayDay(token, interval, sessionDate, signal);
    if (candles.length) {
      sessionBuckets.push({ candles, sessionDate, isToday: daysBack === 0 });
      if (sessionBuckets.length >= sessions) break;
    }
  }

  if (!sessionBuckets.length) {
    return { candles: [], sessionDate: null, isToday: false, sessions: 0 };
  }

  const ordered = sessionBuckets.reverse();
  return {
    candles: ordered.flatMap((bucket) => bucket.candles),
    sessionDate: ordered[ordered.length - 1].sessionDate,
    isToday: ordered[ordered.length - 1].isToday,
    sessions: ordered.length,
  };
}

export function formatSessionLabel(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const label = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  const shortYear = String(year).slice(-2);
  return `${label} '${shortYear}`;
}

export async function fetchHistorical(
  token,
  { interval = 'day', days = 365, intraday = false, sessions = 1, fullHistory = false } = {},
  signal,
) {
  if (intraday) {
    const resolvedInterval = interval === 'day' ? '5minute' : interval;
    return fetchIntradaySession(token, resolvedInterval, sessions, signal);
  }

  if (fullHistory) {
    return fetchHistoricalChunked(token, interval, signal);
  }

  const to = new Date();
  const cappedDays = Math.min(Math.max(1, Number(days) || 365), MAX_HISTORICAL_DAYS);
  const from = addDays(to, -(cappedDays - 1));
  return fetchHistoricalRange(token, interval, from, to, signal);
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.instruments)) return payload.data.instruments;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.instruments)) return payload.instruments;
  return [];
}

function extractTotal(payload) {
  return (
    payload?.data?.total
    ?? payload?.data?.count
    ?? payload?.count
    ?? payload?.total
    ?? undefined
  );
}
