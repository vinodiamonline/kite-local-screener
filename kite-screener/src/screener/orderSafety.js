// Central order-safety rules. Every order must pass validateOrder() before it
// is allowed to reach the Kite OMS. Keep this file pure (no network, no React)
// so the guards stay easy to reason about and test.

export const ORDER_LIMITS = {
  MAX_ORDER_VALUE: 200000, // ₹2,00,000 notional per order
  MAX_QUANTITY: 1000, // shares/lots per order
  PRICE_BAND_PCT: 5, // limit/trigger must stay within ±5% of LTP
  TICK_FRESHNESS_MS: 5000, // reject if last tick older than 5s
  DUPLICATE_WINDOW_MS: 4000, // block identical order within this window
};

export const ALLOWED = {
  variety: ['regular'],
  product: ['CNC', 'MIS'],
  order_type: ['MARKET', 'LIMIT', 'SL-M'],
  transaction_type: ['BUY', 'SELL'],
  validity: ['DAY'],
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function isPositiveInt(value) {
  const n = num(value);
  return Number.isInteger(n) && n > 0;
}

/** Reference price used for value/price-band checks (LTP falls back to limit price). */
export function referencePrice(order, ltp) {
  const live = num(ltp);
  if (Number.isFinite(live) && live > 0) return live;
  const price = num(order?.price);
  if (Number.isFinite(price) && price > 0) return price;
  return NaN;
}

/** Estimated notional value of the order. */
export function estimateOrderValue(order, ltp) {
  const qty = num(order?.quantity);
  const ref = referencePrice(order, ltp);
  if (!Number.isFinite(qty) || !Number.isFinite(ref)) return NaN;
  return Math.abs(qty * ref);
}

function tickAgeMs(tickTimeSeconds, now = Date.now()) {
  const t = num(tickTimeSeconds);
  if (!Number.isFinite(t) || t <= 0) return Infinity;
  return now - t * 1000;
}

/**
 * Validate a single order. Returns { errors: [], warnings: [] }.
 * `errors` block submission; `warnings` require an extra typed confirm.
 *
 * @param {object} order  { variety, product, order_type, transaction_type, quantity, price, trigger_price, validity }
 * @param {object} ctx    { ltp, tickTime, receivedAt, limits }
 */
export function validateOrder(order, ctx = {}) {
  const errors = [];
  const warnings = [];
  const limits = { ...ORDER_LIMITS, ...(ctx.limits || {}) };
  const { ltp, tickTime, receivedAt } = ctx;

  if (!order || typeof order !== 'object') {
    return { errors: ['No order data.'], warnings: [] };
  }

  // Whitelist enums — anything outside the allowed set is hard-blocked.
  Object.entries(ALLOWED).forEach(([key, allowedValues]) => {
    const value = order[key];
    if (value == null || value === '') {
      errors.push(`Missing ${key}.`);
      return;
    }
    if (!allowedValues.includes(value)) {
      errors.push(`${key} "${value}" is not allowed.`);
    }
  });

  // Quantity
  if (!isPositiveInt(order.quantity)) {
    errors.push('Quantity must be a positive whole number.');
  } else if (num(order.quantity) > limits.MAX_QUANTITY) {
    errors.push(`Quantity ${order.quantity} exceeds cap of ${limits.MAX_QUANTITY}.`);
  }

  const needsPrice = order.order_type === 'LIMIT';
  const needsTrigger = order.order_type === 'SL-M';

  if (needsPrice && !(num(order.price) > 0)) {
    errors.push('Limit price must be greater than 0.');
  }
  if (needsTrigger && !(num(order.trigger_price) > 0)) {
    errors.push('Trigger price must be greater than 0.');
  }

  // Value cap
  const value = estimateOrderValue(order, ltp);
  if (Number.isFinite(value) && value > limits.MAX_ORDER_VALUE) {
    errors.push(
      `Order value ₹${Math.round(value).toLocaleString('en-IN')} exceeds cap of ₹${limits.MAX_ORDER_VALUE.toLocaleString('en-IN')}.`,
    );
  } else if (!Number.isFinite(value)) {
    warnings.push('Could not estimate order value (no live price).');
  }

  // Tick freshness. Prefer the client receive time of the last tick (measures
  // whether the live feed is still flowing, and is immune to clock skew between
  // this machine and the exchange). Fall back to the exchange tick timestamp
  // only when no receive time is available.
  const recv = num(receivedAt);
  const age = Number.isFinite(recv) && recv > 0 ? Date.now() - recv : tickAgeMs(tickTime);
  if (age > limits.TICK_FRESHNESS_MS) {
    warnings.push(
      Number.isFinite(age)
        ? `Last price is ${(age / 1000).toFixed(1)}s old — may be stale.`
        : 'No live price timestamp — price may be stale.',
    );
  }

  // Price band vs LTP (only meaningful for priced orders with a live LTP)
  const live = num(ltp);
  if ((needsPrice || needsTrigger) && Number.isFinite(live) && live > 0) {
    const checkPrice = needsTrigger ? num(order.trigger_price) : num(order.price);
    if (Number.isFinite(checkPrice) && checkPrice > 0) {
      const deviation = Math.abs((checkPrice - live) / live) * 100;
      if (deviation > limits.PRICE_BAND_PCT) {
        warnings.push(
          `Price ₹${checkPrice} is ${deviation.toFixed(1)}% away from LTP ₹${live} (band ±${limits.PRICE_BAND_PCT}%).`,
        );
      }
    }
  }

  return { errors, warnings };
}

/** Stable fingerprint of an order for duplicate detection. */
export function orderFingerprint(order) {
  return [
    order?.exchange,
    order?.tradingsymbol,
    order?.transaction_type,
    order?.product,
    order?.order_type,
    order?.quantity,
    order?.price,
    order?.trigger_price,
  ].join('|');
}

// In-memory guard against accidental double-submits (rapid clicks / re-renders).
const recentOrders = new Map(); // fingerprint -> timestamp
const inFlight = new Set(); // fingerprints currently being sent

export function isDuplicateOrder(order, windowMs = ORDER_LIMITS.DUPLICATE_WINDOW_MS) {
  const fp = orderFingerprint(order);
  if (inFlight.has(fp)) return true;
  const last = recentOrders.get(fp);
  return Boolean(last && Date.now() - last < windowMs);
}

export function markOrderInFlight(order) {
  inFlight.add(orderFingerprint(order));
}

export function markOrderSettled(order) {
  const fp = orderFingerprint(order);
  inFlight.delete(fp);
  recentOrders.set(fp, Date.now());
}

/** True when any order is currently being sent (global single-flight guard). */
export function hasInFlightOrder() {
  return inFlight.size > 0;
}
