/** Merge websocket tick fields into a table/chart row. */
export function mergeLiveTickRow(row, tick) {
  if (!row || row.type === 'separator' || !tick) return row;

  const next = { ...row };

  if (Number.isFinite(tick.last_price)) next.last_price = tick.last_price;
  if (Number.isFinite(tick.change_percent)) next.change_percent = tick.change_percent;
  if (Number.isFinite(tick.change)) {
    next.change = tick.change;
    next.net_change = tick.change;
  }
  if (Number.isFinite(tick.volume)) next.volume = tick.volume;
  if (Number.isFinite(tick.open)) next.open = tick.open;
  if (Number.isFinite(tick.high)) next.high = tick.high;
  if (Number.isFinite(tick.low)) next.low = tick.low;
  if (Number.isFinite(tick.close)) {
    next.close = tick.close;
    if (next.prev_close == null || next.prev_close === '') next.prev_close = tick.close;
  }
  if (Number.isFinite(tick.buy_quantity)) next.buy_quantity = tick.buy_quantity;
  if (Number.isFinite(tick.sell_quantity)) next.sell_quantity = tick.sell_quantity;
  if (Number.isFinite(tick.average_price)) next.average_price = tick.average_price;
  if (Number.isFinite(tick.last_quantity)) next.last_quantity = tick.last_quantity;
  if (tick.timestamp) next.last_trade_time = tick.timestamp;
  if (Number.isFinite(tick._recvAt)) next._tickReceivedAt = tick._recvAt;
  if (tick.depth) next.depth = tick.depth;

  return next;
}
