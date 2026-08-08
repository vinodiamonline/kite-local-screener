/**
 * Extended Internal Rate of Return (XIRR) Engine for Mutual Funds.
 * Excel-compliant XIRR implementation using Newton-Raphson iteration with Bisection fallback.
 */

/**
 * Safely parses any date string, timestamp, or Date object into a valid Date or null.
 */
export function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number' && Number.isFinite(val)) return new Date(val);
  const str = String(val).trim();
  if (!str) return null;
  // Replace space between YYYY-MM-DD and HH:mm:ss with 'T' for ISO compliance
  const isoStr = str.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
  const d = new Date(isoStr);
  if (!isNaN(d.getTime())) return d;
  const d2 = new Date(str);
  return isNaN(d2.getTime()) ? null : d2;
}

/**
 * Finds the date in a NAV series where the NAV was closest to a target NAV (average purchase price).
 */
export function findImpliedPurchaseDate(series, targetAvgNav) {
  if (!Array.isArray(series) || series.length === 0 || !Number.isFinite(targetAvgNav) || targetAvgNav <= 0) {
    return null;
  }
  let best = null;
  let minDiff = Infinity;
  for (let i = 0; i < series.length; i += 1) {
    const diff = Math.abs(series[i].nav - targetAvgNav);
    if (diff < minDiff) {
      minDiff = diff;
      best = series[i];
    }
  }
  return best ? new Date(best.t) : null;
}

/**
 * Calculates XIRR for a given list of cash flows.
 * @param {Array<{ amount: number, date: Date | number | string }>} cashFlows
 *   - Outflows (purchases/SIPs) MUST be negative numbers (e.g. -5000)
 *   - Current value or redemptions MUST be positive numbers (e.g. +6500)
 * @returns {number | null} XIRR annual percentage rate (e.g. 14.5 for 14.5%), or null if non-convergent.
 */
export function calculateXirr(cashFlows) {
  if (!cashFlows || cashFlows.length < 2) return null;

  // 1. Clean, parse, and sort cash flows by date ascending
  const sorted = cashFlows
    .map((cf) => ({
      amount: Number(cf.amount),
      date: parseDate(cf.date),
    }))
    .filter((cf) => cf.date && Number.isFinite(cf.amount) && cf.amount !== 0 && !isNaN(cf.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (sorted.length < 2) return null;

  const hasNegative = sorted.some((cf) => cf.amount < 0);
  const hasPositive = sorted.some((cf) => cf.amount > 0);
  if (!hasNegative || !hasPositive) return null;

  const startDate = sorted[0].date.getTime();

  // Convert dates to fractional years relative to start date (Excel 365 days standard)
  const dayYears = sorted.map((cf) => {
    const diffDays = (cf.date.getTime() - startDate) / (1000 * 60 * 60 * 24);
    return diffDays / 365.0;
  });

  // Net Present Value: NPV(r) = sum( C_i / (1 + r)^years_i )
  const npv = (rate) => {
    if (rate <= -0.999999) return NaN;
    let sum = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const term = Math.pow(1 + rate, dayYears[i]);
      if (!Number.isFinite(term) || term === 0) return NaN;
      sum += sorted[i].amount / term;
    }
    return sum;
  };

  // Derivative dNPV / dr
  const dNpv = (rate) => {
    if (rate <= -0.999999) return NaN;
    let sum = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const term = Math.pow(1 + rate, dayYears[i] + 1);
      if (!Number.isFinite(term) || term === 0) return NaN;
      sum -= (dayYears[i] * sorted[i].amount) / term;
    }
    return sum;
  };

  // 1. Try Newton-Raphson iteration
  let r = 0.1; // initial guess 10%
  const tol = 1e-7;
  const maxIter = 100;

  for (let iter = 0; iter < maxIter; iter += 1) {
    const fVal = npv(r);
    if (!Number.isFinite(fVal)) break;
    if (Math.abs(fVal) < tol) return r * 100;

    const fDeriv = dNpv(r);
    if (!Number.isFinite(fDeriv) || Math.abs(fDeriv) < 1e-12) break;

    const nextR = r - fVal / fDeriv;
    if (nextR <= -0.99) {
      r = (r - 0.99) / 2;
    } else {
      r = nextR;
    }

    if (Math.abs(r - nextR) < tol) {
      const finalCheck = npv(r);
      if (Number.isFinite(finalCheck) && Math.abs(finalCheck) < 100) {
        return r * 100;
      }
    }
  }

  // 2. Bisection Fallback
  let low = -0.99;
  let high = 10.0; // max +1000% annual rate

  let fLow = npv(low);
  let fHigh = npv(high);

  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) return null;

  // Bracket root if necessary
  if (fLow * fHigh > 0) {
    let foundBracket = false;
    for (let step = -0.9; step <= 5.0; step += 0.2) {
      const fStep = npv(step);
      if (Number.isFinite(fStep) && fLow * fStep <= 0) {
        high = step;
        fHigh = fStep;
        foundBracket = true;
        break;
      }
    }
    if (!foundBracket) return null;
  }

  for (let iter = 0; iter < 100; iter += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);

    if (!Number.isFinite(fMid)) break;
    if (Math.abs(fMid) < tol || (high - low) < tol) {
      return mid * 100;
    }

    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }

  return null;
}

/**
 * Extracts cash flows for a specific holding from Zerodha MF orders + current holding state.
 * @param {Object} row - Holding row object with { isin, invested, current, holding, avg, units }
 * @param {Array} orders - List of Zerodha MF orders from /oms/mf/orders
 * @param {Array} navSeries - Historical NAV array [{ t, nav }]
 * @returns {Array<{ amount: number, date: Date }>}
 */
export function buildHoldingCashFlows(row, orders = [], navSeries = null) {
  const isin = String(row.holding?.tradingsymbol || row.scheme?.isin || '').trim();
  const today = new Date();
  const invested = Number(row.invested) || 0;
  const current = Number(row.current) || 0;
  const avgNav = Number(row.avg) || Number(row.holding?.average_price) || 0;
  const totalUnits = Number(row.units || row.holding?.quantity || row.holding?.holding_quantity) || 0;

  if (invested <= 0 || current <= 0) return [];

  // Filter matching completed buy orders for this scheme
  const matchingOrders = Array.isArray(orders)
    ? orders.filter((o) => {
        const orderIsin = String(o.tradingsymbol || o.isin || '').trim();
        const status = String(o.status || '').toLowerCase();
        const type = String(o.transaction_type || '').toLowerCase();
        return (
          orderIsin === isin &&
          (status === 'complete' || status === 'executed' || status === 'completed') &&
          (type === 'buy' || Number(o.amount) > 0)
        );
      })
    : [];

  const orderUnits = matchingOrders.reduce((sum, o) => sum + (Number(o.quantity || o.units) || 0), 0);
  const isOrderHistoryComplete =
    matchingOrders.length > 0 &&
    totalUnits > 0 &&
    Math.abs(orderUnits - totalUnits) / totalUnits < 0.08;

  const flows = [];

  if (isOrderHistoryComplete) {
    matchingOrders.forEach((o) => {
      const amt = Number(o.amount || o.price * o.quantity || o.average_price * o.quantity) || 0;
      const d = parseDate(o.order_timestamp || o.date || o.created_at || o.exchange_timestamp);
      if (amt > 0 && d) {
        flows.push({ amount: -amt, date: d });
      }
    });
  } else {
    let coveredUnits = 0;
    let coveredAmount = 0;

    if (matchingOrders.length > 0) {
      matchingOrders.forEach((o) => {
        const u = Number(o.quantity || o.units) || 0;
        const amt = Number(o.amount || o.price * u || o.average_price * u) || 0;
        const d = parseDate(o.order_timestamp || o.date || o.created_at || o.exchange_timestamp);
        if (u > 0 && amt > 0 && d) {
          flows.push({ amount: -amt, date: d });
          coveredUnits += u;
          coveredAmount += amt;
        }
      });
    }

    const remainingUnits = Math.max(0, totalUnits - coveredUnits);
    const remainingInvested = Math.max(0, invested - coveredAmount);

    if (remainingUnits > 0 && remainingInvested > 0) {
      let purchaseDate = parseDate(
        row.holding?.created_at ||
        row.holding?.order_timestamp ||
        row.holding?.purchase_date ||
        row.holding?.last_transacted_at
      );

      if (!purchaseDate && navSeries && avgNav > 0) {
        purchaseDate = findImpliedPurchaseDate(navSeries, avgNav);
      }

      if (!purchaseDate && matchingOrders.length > 0) {
        const dates = matchingOrders
          .map((o) => parseDate(o.order_timestamp || o.date || o.created_at)?.getTime())
          .filter(Boolean);
        if (dates.length > 0) {
          purchaseDate = new Date(Math.min(...dates));
        }
      }

      if (purchaseDate) {
        flows.push({ amount: -remainingInvested, date: purchaseDate });
      }
    }
  }

  if (flows.length > 0) {
    flows.push({ amount: current, date: today });
  }

  return flows;
}

/**
 * Computes individual XIRR for a holding row.
 */
export function computeHoldingXirr(row, orders = [], navSeries = null) {
  const flows = buildHoldingCashFlows(row, orders, navSeries);
  return calculateXirr(flows);
}

/**
 * Computes overall portfolio XIRR across all mutual fund holdings and orders.
 */
export function computePortfolioXirr(holdingRows = [], orders = [], navSeriesMap = {}) {
  if (!holdingRows || holdingRows.length === 0) return null;

  const today = new Date();
  const allFlows = [];

  holdingRows.forEach((row) => {
    const series = row.code && navSeriesMap[row.code] ? navSeriesMap[row.code].series : null;
    const flows = buildHoldingCashFlows(row, orders, series);
    // Collect all negative cash outflows (investments)
    flows.forEach((cf) => {
      if (cf.amount < 0) {
        allFlows.push(cf);
      }
    });
  });

  const totalCurrentValue = holdingRows.reduce((sum, r) => sum + (Number(r.current) || 0), 0);
  if (allFlows.length > 0 && totalCurrentValue > 0) {
    allFlows.push({ amount: totalCurrentValue, date: today });
    return calculateXirr(allFlows);
  }

  return null;
}
