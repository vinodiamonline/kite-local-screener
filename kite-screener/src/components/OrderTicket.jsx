import { useEffect, useMemo, useState } from 'react';
import { buildOrder, placeOrder } from '../screener/orders';
import { estimateOrderValue, validateOrder } from '../screener/orderSafety';
import { hasSession } from '../screener/kiteApi';
import OrderBookPanel from './OrderBookPanel';

const SIDES = ['BUY', 'SELL'];
const PRODUCTS = ['CNC', 'MIS'];
const ORDER_TYPES = [
  { id: 'MARKET', label: 'MKT' },
  { id: 'LIMIT', label: 'LMT' },
  { id: 'SL-M', label: 'SL-M' },
];

const ORDER_PREFS_KEY = 'kite-screener:order-prefs';
const DEFAULT_ORDER_PREFS = {
  side: 'BUY',
  product: 'CNC',
  orderType: 'LIMIT',
};

function readOrderPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_PREFS_KEY) || '{}');
    return {
      side: SIDES.includes(parsed.side) ? parsed.side : DEFAULT_ORDER_PREFS.side,
      product: PRODUCTS.includes(parsed.product) ? parsed.product : DEFAULT_ORDER_PREFS.product,
      orderType: ORDER_TYPES.some(({ id }) => id === parsed.orderType)
        ? parsed.orderType
        : DEFAULT_ORDER_PREFS.orderType,
    };
  } catch {
    return DEFAULT_ORDER_PREFS;
  }
}

function writeOrderPrefs(nextPrefs) {
  try {
    localStorage.setItem(ORDER_PREFS_KEY, JSON.stringify(nextPrefs));
  } catch {
    /* ignore storage errors */
  }
}

function bestBid(row) {
  return Number(row?.depth?.buy?.[0]?.price) || 0;
}
function bestAsk(row) {
  return Number(row?.depth?.sell?.[0]?.price) || 0;
}
function ltpOf(row) {
  return Number(row?.last_price) || 0;
}
function tickTimeOf(row) {
  return Number(row?.last_trade_time ?? row?.timestamp) || 0;
}
function tickReceivedAtOf(row) {
  return Number(row?._tickReceivedAt) || 0;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return '—';
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

export default function OrderTicket({ symbol, exchange, token, row, onClose }) {
  const initialPrefs = useMemo(readOrderPrefs, []);
  const [side, setSide] = useState(initialPrefs.side);
  const [product, setProduct] = useState(initialPrefs.product);
  const [orderType, setOrderType] = useState(initialPrefs.orderType);
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState(null);

  const ltp = ltpOf(row);
  const tickTime = tickTimeOf(row);
  const tickReceivedAt = tickReceivedAtOf(row);

  useEffect(() => {
    writeOrderPrefs({ side, product, orderType });
  }, [side, product, orderType]);

  // Reset the ticket whenever the selected symbol changes.
  useEffect(() => {
    setQuantity('');
    setPrice('');
    setTriggerPrice('');
    setPendingConfirm(false);
    setResult(null);
  }, [symbol, exchange]);

  // Prefill price from the book/LTP when switching to a priced order type.
  useEffect(() => {
    if (orderType === 'MARKET') return;
    const seed = orderType === 'LIMIT'
      ? (side === 'BUY' ? bestAsk(row) : bestBid(row)) || ltp
      : ltp;
    if (seed > 0) {
      if (orderType === 'LIMIT') setPrice((prev) => (prev ? prev : String(seed)));
      else setTriggerPrice((prev) => (prev ? prev : String(seed)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderType, side, symbol]);

  const draft = useMemo(
    () => buildOrder({
      exchange,
      tradingsymbol: symbol,
      transaction_type: side,
      product,
      order_type: orderType,
      quantity,
      price,
      trigger_price: triggerPrice,
    }),
    [exchange, symbol, side, product, orderType, quantity, price, triggerPrice],
  );

  const { errors, warnings } = useMemo(
    () => validateOrder(draft, { ltp, tickTime, receivedAt: tickReceivedAt }),
    [draft, ltp, tickTime, tickReceivedAt],
  );

  const orderValue = useMemo(() => {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return NaN;

    let unit = ltp;
    if (orderType === 'LIMIT') {
      const p = Number(price);
      if (Number.isFinite(p) && p > 0) unit = p;
    } else if (orderType === 'SL-M') {
      const t = Number(triggerPrice);
      if (Number.isFinite(t) && t > 0) unit = t;
    }
    if (!Number.isFinite(unit) || unit <= 0) {
      return estimateOrderValue(draft, ltp);
    }
    return qty * unit;
  }, [quantity, price, triggerPrice, orderType, ltp, draft]);

  const hasQty = Number(quantity) > 0;

  // Any change to the draft cancels a pending confirmation.
  useEffect(() => {
    setPendingConfirm(false);
    setResult(null);
  }, [draft]);

  // Escape closes the ticket from anywhere (same as the × button).
  useEffect(() => {
    if (!onClose) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const disabled = !hasSession() || !token || errors.length > 0 || placing;
  const needsPriceInput = orderType === 'LIMIT';
  const needsTriggerInput = orderType === 'SL-M';

  const submit = async () => {
    if (disabled) return;

    // Two-step: first click on a warning-bearing order asks for confirmation.
    if (warnings.length && !pendingConfirm) {
      setPendingConfirm(true);
      return;
    }

    setPlacing(true);
    setResult(null);
    const response = await placeOrder(draft, {
      ltp,
      tickTime,
      receivedAt: tickReceivedAt,
      allowWarnings: pendingConfirm,
    });
    setPlacing(false);
    setPendingConfirm(false);
    setResult(response);

    if (response.ok) {
      setQuantity('');
    }
  };

  const buttonLabel = placing
    ? 'Placing…'
    : pendingConfirm
      ? `Confirm ${side}`
      : side;

  const handleKeyDown = (event) => {
    // Enter submits (Buy/Sell), but let buttons handle their own Enter/click.
    if (event.key === 'Enter' && event.target?.tagName !== 'BUTTON') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section
      className={`order-ticket order-ticket-${side.toLowerCase()}`}
      onKeyDown={handleKeyDown}
    >
      <header className="order-ticket-head">
        <div className="order-ticket-title">
          <span className="order-ticket-symbol">{symbol}</span>
          <span className="order-ticket-exchange">{exchange}</span>
        </div>
        <div className={`order-ticket-total${hasQty ? ' visible' : ''}`}>
          <span className="order-ticket-total-label">Total</span>
          <span className="order-ticket-total-value">
            {hasQty && Number.isFinite(orderValue) ? formatMoney(orderValue) : '—'}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            className="order-ticket-close"
            onClick={onClose}
            title="Hide trade panel"
            aria-label="Hide trade panel"
          >
            ×
          </button>
        )}
      </header>

      <div className="order-ticket-row order-ticket-toggles">
        <div className="order-seg">
          {SIDES.map((value) => (
            <button
              key={value}
              type="button"
              className={`order-seg-btn ${side === value ? 'active' : ''} side-${value.toLowerCase()}`}
              onClick={() => setSide(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="order-seg">
          {PRODUCTS.map((value) => (
            <button
              key={value}
              type="button"
              className={`order-seg-btn ${product === value ? 'active' : ''}`}
              onClick={() => setProduct(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="order-seg">
          {ORDER_TYPES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`order-seg-btn ${orderType === id ? 'active' : ''}`}
              onClick={() => setOrderType(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="order-ticket-row order-ticket-inputs">
        <label className="order-field">
          <span>Qty</span>
          <input
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            onClick={(event) => event.target.select()}
          />
        </label>
        <label className={`order-field ${needsPriceInput ? '' : 'is-disabled'}`}>
          <span>Price</span>
          <input
            type="number"
            min="0"
            step="0.05"
            value={needsPriceInput ? price : ''}
            disabled={!needsPriceInput}
            placeholder={orderType === 'MARKET' ? 'MKT' : ''}
            onChange={(event) => setPrice(event.target.value)}
            onClick={(event) => event.target.select()}
          />
        </label>
        <label className={`order-field ${needsTriggerInput ? '' : 'is-disabled'}`}>
          <span>Trigger</span>
          <input
            type="number"
            min="0"
            step="0.05"
            value={needsTriggerInput ? triggerPrice : ''}
            disabled={!needsTriggerInput}
            onChange={(event) => setTriggerPrice(event.target.value)}
            onClick={(event) => event.target.select()}
          />
        </label>
      </div>

      <div className="order-ticket-row order-ticket-meta">
        <span>LTP {ltp > 0 ? ltp : '—'}</span>
        <button
          type="button"
          className={`order-place-btn side-${side.toLowerCase()} ${pendingConfirm ? 'confirm' : ''}`}
          onClick={submit}
          disabled={disabled}
        >
          {buttonLabel}
        </button>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="order-ticket-notes">
          {errors.map((message) => (
            <li key={`e-${message}`} className="order-note error">{message}</li>
          ))}
          {warnings.map((message) => (
            <li key={`w-${message}`} className="order-note warn">{message}</li>
          ))}
        </ul>
      )}

      {result && (
        <div className={`order-ticket-result ${result.ok ? 'ok' : 'fail'}`}>
          {result.ok ? `✓ ${result.message}${result.orderId ? ` (${result.orderId})` : ''}` : `✕ ${result.message}`}
        </div>
      )}

      <div className="order-ticket-book">
        <OrderBookPanel row={row} />
      </div>
    </section>
  );
}
