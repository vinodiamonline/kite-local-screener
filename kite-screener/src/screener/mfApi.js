// Mutual-fund data layer built on public sources:
//   - AMFI NAVAll.txt : full scheme master + latest NAV + category + AMC (one request)
//   - api.mfapi.in    : per-scheme historical NAV (used for the chart + returns)
//
// AMFI and mfapi.in both key schemes by the same AMFI scheme code, so a scheme
// from the master list maps directly to its mfapi history endpoint.

import { mfFetchText, mfFetchJson } from './mfProxy';

// www.amfiindia.com 301-redirects this file to portal.amfiindia.com; hit the
// portal host directly so the background fetch never has to follow a cross-host
// redirect (which would otherwise fail without permission for the target host).
const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const MFAPI_BASE = 'https://api.mfapi.in/mf';

const LIST_TTL_MS = 6 * 60 * 60 * 1000; // 6h in-memory cache for the scheme master
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

let listCache = null; // { at: number, schemes: [] }
let listPromise = null;
const historyCache = new Map(); // schemeCode -> { at: number, data: {...} }
const historyPromises = new Map();

const DAY_MS = 86400000;
const YEAR_MS = 365 * DAY_MS;

/** Header lines look like "Open Ended Schemes(Equity Scheme - Large Cap Fund)". */
function parseCategoryHeader(line) {
  if (!/Schemes?\s*\(/i.test(line)) return null;
  const match = line.match(/\((.+)\)\s*$/);
  const inner = (match ? match[1] : line).trim();

  let schemeType = inner;
  let subCategory = '';
  const dashSplit = inner.split(' - ');
  if (dashSplit.length >= 2) {
    schemeType = dashSplit[0].trim();
    subCategory = dashSplit.slice(1).join(' - ').trim();
  }
  schemeType = schemeType.replace(/\s*Scheme$/i, '').trim();

  return { schemeType: schemeType || 'Other', subCategory: subCategory || 'Other', category: inner };
}

function detectPlan(name) {
  return /\bdirect\b/i.test(name) ? 'Direct' : 'Regular';
}

function detectOption(name) {
  if (/\b(idcw|dividend|payout|reinvest)\b/i.test(name)) return 'IDCW';
  if (/\bgrowth\b/i.test(name)) return 'Growth';
  return 'Other';
}

function parseAmfiNav(text) {
  const schemes = [];
  let amc = '';
  let schemeType = 'Other';
  let subCategory = 'Other';
  let category = '';

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('Scheme Code')) continue;

    if (line.includes(';')) {
      const parts = line.split(';');
      if (parts.length < 6) continue;
      const schemeCode = parts[0].trim();
      const name = parts[3].trim();
      if (!/^\d+$/.test(schemeCode) || !name) continue;

      // NAV and Date are always the last two columns. AMFI has, over time,
      // added columns after the scheme name (e.g. Plan/Option), so read from
      // the end rather than fixed indices to stay resilient to that layout.
      const nav = Number.parseFloat(parts[parts.length - 2]);
      schemes.push({
        schemeCode,
        isin: parts[1].trim() || parts[2].trim() || '',
        name,
        nav: Number.isFinite(nav) ? nav : null,
        navDate: parts[parts.length - 1].trim(),
        amc,
        schemeType,
        subCategory,
        category,
        plan: detectPlan(name),
        option: detectOption(name),
      });
      continue;
    }

    const parsed = parseCategoryHeader(line);
    if (parsed) {
      schemeType = parsed.schemeType;
      subCategory = parsed.subCategory;
      category = parsed.category;
    } else {
      // Fund house (AMC) section header, e.g. "Aditya Birla Sun Life Mutual Fund".
      amc = line;
    }
  }

  return schemes;
}

/** Load the full mutual-fund scheme master (cached in memory for the session). */
export async function loadMfSchemes({ force = false } = {}) {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.schemes;
  }
  if (listPromise) return listPromise;

  listPromise = (async () => {
    const text = await mfFetchText(AMFI_NAV_URL, { accept: 'text/plain,*/*' });
    const schemes = parseAmfiNav(text);
    if (!schemes.length) throw new Error('Could not parse the AMFI scheme list.');
    listCache = { at: Date.now(), schemes };
    return schemes;
  })().finally(() => {
    listPromise = null;
  });

  return listPromise;
}

function toTime(ddmmyyyy) {
  const [d, m, y] = String(ddmmyyyy).split('-').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d).getTime();
}

/** Fetch a scheme's full NAV history (ascending by date), cached per scheme. */
export async function loadMfHistory(schemeCode, { signal, force = false } = {}) {
  const code = String(schemeCode);
  const cached = historyCache.get(code);
  if (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.data;
  if (!force && historyPromises.has(code)) return historyPromises.get(code);

  const promise = (async () => {
    const payload = await mfFetchJson(`${MFAPI_BASE}/${code}`, { signal });
    const rawData = Array.isArray(payload?.data) ? payload.data : [];

    const series = rawData
      .map((point) => ({ t: toTime(point.date), nav: Number.parseFloat(point.nav) }))
      .filter((point) => point.t != null && Number.isFinite(point.nav) && point.nav > 0)
      .sort((a, b) => a.t - b.t);

    const data = { meta: payload?.meta || {}, series };
    historyCache.set(code, { at: Date.now(), data });
    return data;
  })().finally(() => {
    historyPromises.delete(code);
  });

  historyPromises.set(code, promise);
  return promise;
}

/** Last NAV point at or before a target timestamp (series must be ascending). */
function navAtOrBefore(series, targetT) {
  let result = null;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].t <= targetT) result = series[i];
    else break;
  }
  return result;
}

function absoluteReturn(fromNav, toNav) {
  if (!fromNav || !toNav) return null;
  return ((toNav - fromNav) / fromNav) * 100;
}

function cagr(fromNav, toNav, years) {
  if (!fromNav || !toNav || years <= 0) return null;
  return ((toNav / fromNav) ** (1 / years) - 1) * 100;
}

/**
 * Compute standard trailing returns from a NAV series.
 * 1Y is absolute; 3Y/5Y/since-inception are annualised (CAGR) — matching the
 * usual mutual-fund reporting convention.
 */
export function computeMfReturns(series) {
  if (!series || series.length < 2) return null;

  const latest = series[series.length - 1];
  const first = series[0];
  const latestNav = latest.nav;

  const base1y = navAtOrBefore(series, latest.t - YEAR_MS);
  const base3y = navAtOrBefore(series, latest.t - 3 * YEAR_MS);
  const base5y = navAtOrBefore(series, latest.t - 5 * YEAR_MS);

  const jan1 = new Date(new Date(latest.t).getFullYear(), 0, 1).getTime();
  const baseYtd = navAtOrBefore(series, jan1) || first;

  const inceptionYears = (latest.t - first.t) / YEAR_MS;

  return {
    latestNav,
    latestDate: latest.t,
    inceptionDate: first.t,
    r1y: base1y ? absoluteReturn(base1y.nav, latestNav) : null,
    r3y: base3y ? cagr(base3y.nav, latestNav, 3) : null,
    r5y: base5y ? cagr(base5y.nav, latestNav, 5) : null,
    rYtd: absoluteReturn(baseYtd.nav, latestNav),
    rInception: inceptionYears >= 1
      ? cagr(first.nav, latestNav, inceptionYears)
      : absoluteReturn(first.nav, latestNav),
    series,
  };
}

/** Fetch a scheme's history and derive its trailing returns in one call. */
export async function loadMfReturns(schemeCode, { signal, force = false } = {}) {
  const { series } = await loadMfHistory(schemeCode, { signal, force });
  return computeMfReturns(series);
}

/** Run an async worker over items with limited concurrency (order preserved). */
export async function mapWithConcurrency(items, limit, worker, { signal } = {}) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
}
