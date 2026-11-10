// Rebalancing maths for the MF holdings view. Pure functions only; values are
// the current market values the app already shows, so results are exact.

const STORAGE_KEY = 'kite-screener-mf-rebalance-targets';

export function loadRebalanceTargets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRebalanceTargets(all) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore storage failures
  }
}

/** Groups holding rows into buckets [{ key, label, value }] for a dimension. */
export function groupHoldings(rows, dimension) {
  const map = new Map();
  rows.forEach((row) => {
    const value = Number(row.current) || 0;
    if (value <= 0) return;
    let key;
    let label;
    if (dimension === 'fund') {
      key = row.key;
      label = row.scheme?.name || row.key;
    } else {
      label = (row.scheme?.[dimension] || 'Other').trim() || 'Other';
      key = label;
    }
    const prev = map.get(key) || { key, label, value: 0 };
    prev.value += value;
    map.set(key, prev);
  });
  return [...map.values()].sort((a, b) => b.value - a.value);
}

/**
 * @param {Array<{key,label,value}>} groups
 * @param {Object<string, number>} targets  percent per group key (should sum to 100)
 * @param {number} extra  fresh money to invest (>= 0)
 * @param {'full'|'addOnly'} mode  full = buy and sell to hit targets; addOnly = only deploy fresh money
 */
export function computeRebalance(groups, targets, extra = 0, mode = 'full') {
  const cash = Math.max(0, Number(extra) || 0);
  const current = groups.reduce((sum, g) => sum + g.value, 0);
  const total = current + cash;
  const rows = groups.map((g) => {
    const targetPct = Math.max(0, Number(targets?.[g.key]) || 0);
    return {
      ...g,
      currentPct: current > 0 ? (g.value / current) * 100 : 0,
      targetPct,
      targetValue: (total * targetPct) / 100,
      action: 0,
    };
  });

  if (mode === 'addOnly') {
    const shortfalls = rows.map((r) => Math.max(0, r.targetValue - r.value));
    const need = shortfalls.reduce((a, b) => a + b, 0);
    if (need > 0 && need >= cash) {
      rows.forEach((r, i) => { r.action = (cash * shortfalls[i]) / need; });
    } else {
      const leftover = cash - need;
      const pctSum = rows.reduce((a, r) => a + r.targetPct, 0) || 1;
      rows.forEach((r, i) => { r.action = shortfalls[i] + (leftover * r.targetPct) / pctSum; });
    }
  } else {
    rows.forEach((r) => { r.action = r.targetValue - r.value; });
  }

  rows.forEach((r) => {
    r.after = r.value + r.action;
    r.afterPct = total > 0 ? (r.after / total) * 100 : 0;
  });
  return { rows, current, total };
}
