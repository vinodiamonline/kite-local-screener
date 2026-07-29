// Best-effort ISIN resolution for exchange-traded ETFs.
//
// ETFs are NOT in the /oms/screener universe and the curated ETF list carries
// only { tradingsymbol, name, instrument_token } — no ISIN. finapi insights are
// ISIN-keyed, so we recover each ETF's ISIN by matching it against the AMFI
// scheme master (loadMfSchemes), which every ETF also appears in as a fund.
//
// This is enrichment only: any ETF that fails to match simply runs on the
// technical engine (candles) without the fundamental/risk overlay.

import { loadMfSchemes } from './mfApi';

const cache = new Map(); // normalizedSymbol -> isin | null
let indexPromise = null;

const STOP_WORDS = new Set([
  'ETF', 'FUND', 'SCHEME', 'GROWTH', 'IDCW', 'REGULAR', 'DIRECT', 'PLAN', 'OPTION',
  'THE', 'OF', 'AND', 'INDIA', 'INDEX', 'PAYOUT', 'REINVESTMENT', 'DAILY', 'WEEKLY',
  'EXCHANGE', 'TRADED', 'OPEN', 'ENDED', 'SERIES', 'LTD', 'AMC', 'ASSET', 'MANAGEMENT',
]);

// AMC aliases so a Kite AMC label matches the AMFI fund-house wording.
const AMC_ALIASES = [
  [/\bNIPPON\b/, 'NIPPON'],
  [/\bICICI\b/, 'ICICI'],
  [/\bSBI\b/, 'SBI'],
  [/\bHDFC\b/, 'HDFC'],
  [/\bKOTAK\b/, 'KOTAK'],
  [/\bADITYA ?BIRLA\b|\bABSL\b/, 'BIRLA'],
  [/\bMIRAE\b/, 'MIRAE'],
  [/\bMOTILAL\b|\bMOSL\b/, 'MOTILAL'],
  [/\bUTI\b/, 'UTI'],
  [/\bEDELWEISS\b/, 'EDELWEISS'],
  [/\bDSP\b/, 'DSP'],
  [/\bAXIS\b/, 'AXIS'],
  [/\bTATA\b/, 'TATA'],
  [/\bBHARAT\b/, 'BHARAT'],
  [/\bLIC\b/, 'LIC'],
  [/\bGROWW\b/, 'GROWW'],
  [/\bBAJAJ\b/, 'BAJAJ'],
];

function normalizeSymbol(entry) {
  return String(entry?.tradingsymbol || entry?.symbol || '').trim().toUpperCase();
}

/** Split a name into a set of significant tokens (drops stop-words & short bits). */
function tokenize(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok.length >= 2 && !STOP_WORDS.has(tok));
}

/** Numeric fragments in a symbol/name (e.g. "50", "500", "30", "10") are strong hints. */
function numberTokens(text) {
  return (String(text || '').match(/\d{2,4}/g) || []);
}

function amcHint(text) {
  const blob = String(text || '').toUpperCase();
  for (const [rx, tag] of AMC_ALIASES) if (rx.test(blob)) return tag;
  return null;
}

/**
 * Build a search index of AMFI ETF schemes once. We keep the Growth/plain plan
 * (skip IDCW/reinvestment/FOF variants) so the ISIN maps to the tradable ETF.
 */
async function buildEtfSchemeIndex() {
  const schemes = await loadMfSchemes();
  const etfs = [];
  for (const scheme of schemes) {
    const name = scheme?.name || '';
    if (!scheme?.isin) continue;
    if (!/\bETF\b|BeES|Exchange Traded/i.test(name)) continue;
    if (/\bFOF\b|Fund of Fund/i.test(name)) continue; // fund-of-fund, not the ETF
    if (/IDCW|Reinvest|Payout/i.test(name)) continue; // prefer growth/plain plan
    etfs.push({
      isin: scheme.isin,
      name,
      tokens: new Set(tokenize(name)),
      numbers: new Set(numberTokens(name)),
      amc: amcHint(`${scheme.amc} ${name}`),
    });
  }
  return etfs;
}

function scoreMatch(symbol, entryName, scheme) {
  const symTokens = new Set([
    ...tokenize(entryName),
    ...tokenize(symbol.replace(/(ETF|IETF|BEES|N50|BEE)$/i, '')),
  ]);
  const symNumbers = new Set([...numberTokens(symbol), ...numberTokens(entryName)]);
  const wantAmc = amcHint(`${entryName} ${symbol}`);

  let score = 0;
  // AMC must line up when both sides declare one — otherwise it's a different house.
  if (wantAmc && scheme.amc) {
    if (wantAmc === scheme.amc) score += 3;
    else return -1;
  }
  // Shared numeric index tokens (50 / 500 / 100 / 30 ...) are highly discriminating.
  for (const n of symNumbers) if (scheme.numbers.has(n)) score += 2;
  // Shared word tokens (GOLD, SILVER, BANK, MOMENTUM, HEALTHCARE ...).
  for (const t of symTokens) if (scheme.tokens.has(t)) score += 1;
  return score;
}

/**
 * Resolve one ETF entry to an ISIN (best-effort). Returns null when no confident
 * AMFI match is found; callers then use the technical engine only.
 */
export async function resolveEtfIsin(entry) {
  const symbol = normalizeSymbol(entry);
  if (!symbol) return null;
  if (cache.has(symbol)) return cache.get(symbol);

  if (!indexPromise) indexPromise = buildEtfSchemeIndex().catch(() => []);
  const schemes = await indexPromise;
  if (!schemes.length) {
    cache.set(symbol, null);
    return null;
  }

  const entryName = entry?.name || '';
  let best = null;
  let bestScore = 0;
  for (const scheme of schemes) {
    const score = scoreMatch(symbol, entryName, scheme);
    if (score > bestScore) {
      bestScore = score;
      best = scheme;
    }
  }

  // Require a meaningful match (AMC + at least one shared index/number token).
  const isin = bestScore >= 4 && best ? best.isin : null;
  cache.set(symbol, isin);
  return isin;
}

export function clearEtfIsinCache() {
  cache.clear();
  indexPromise = null;
}
