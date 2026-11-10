import { useMemo, useState } from 'react';

// Distinct, readable palette; extra slices wrap around the list.
const PALETTE = [
  '#2f6feb', '#1a7f37', '#bf8700', '#cf222e', '#8250df',
  '#3192aa', '#e16f24', '#57606a', '#d4a72c', '#6e7781',
];

const moneyFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function formatMoney(value) {
  return Number.isFinite(value) ? `₹${moneyFormatter.format(Math.round(value))}` : '—';
}

function planOf(row) {
  const name = row.scheme?.name || row.holding?.fund || '';
  if (/\bdirect\b/i.test(name)) return 'Direct';
  if (/\bregular\b/i.test(name)) return 'Regular';
  return 'Unspecified';
}

const DIMENSIONS = [
  { id: 'schemeType', label: 'Type', get: (row) => row.scheme?.schemeType },
  { id: 'subCategory', label: 'Category', get: (row) => row.scheme?.subCategory },
  { id: 'amc', label: 'AMC', get: (row) => row.scheme?.amc },
  { id: 'plan', label: 'Plan', get: planOf },
];

const R = 60;
const STROKE = 26;
const CIRC = 2 * Math.PI * R;
const SIZE = 2 * (R + STROKE / 2);
const CENTER = SIZE / 2;

export default function MfAllocationPie({ rows = [] }) {
  const [dimension, setDimension] = useState('schemeType');

  const { items, total } = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => {
      const value = Number(row.current) || 0;
      if (value <= 0) return;
      const dim = DIMENSIONS.find((d) => d.id === dimension) || DIMENSIONS[0];
      const key = String(dim.get(row) || 'Other').trim() || 'Other';
      map.set(key, (map.get(key) || 0) + value);
    });
    const sum = Array.from(map.values()).reduce((acc, v) => acc + v, 0);
    const list = Array.from(map.entries())
      .map(([label, value]) => ({
        label,
        value,
        pct: sum > 0 ? (value / sum) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value);
    return { items: list, total: sum };
  }, [rows, dimension]);

  if (!items.length) return null;

  let offset = 0;

  return (
    <div className="mf-alloc">
      <div className="mf-alloc-head">
        <span className="mf-alloc-title">Allocation</span>
        <div className="mf-alloc-toggle">
          {DIMENSIONS.map((dim) => (
            <button
              key={dim.id}
              type="button"
              className={`mf-alloc-tab${dimension === dim.id ? ' active' : ''}`}
              onClick={() => setDimension(dim.id)}
            >
              {dim.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mf-alloc-body">
        <svg
          className="mf-alloc-donut"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label="Portfolio allocation donut chart"
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={R}
            fill="none"
            stroke="#eaeef2"
            strokeWidth={STROKE}
          />
          {items.map((item, index) => {
            const len = (item.pct / 100) * CIRC;
            const dash = `${len} ${CIRC - len}`;
            const circle = (
              <circle
                key={item.label}
                cx={CENTER}
                cy={CENTER}
                r={R}
                fill="none"
                stroke={PALETTE[index % PALETTE.length]}
                strokeWidth={STROKE}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${CENTER} ${CENTER})`}
              >
                <title>{`${item.label}: ${item.pct.toFixed(1)}% (${formatMoney(item.value)})`}</title>
              </circle>
            );
            offset += len;
            return circle;
          })}
          <text className="mf-alloc-center-top" x={CENTER} y={CENTER - 4} textAnchor="middle">
            {items.length}
          </text>
          <text className="mf-alloc-center-sub" x={CENTER} y={CENTER + 12} textAnchor="middle">
            {items.length === 1 ? 'bucket' : 'buckets'}
          </text>
        </svg>

        <ul className="mf-alloc-legend">
          {items.map((item, index) => (
            <li key={item.label} className="mf-alloc-legend-item">
              <span
                className="mf-alloc-swatch"
                style={{ background: PALETTE[index % PALETTE.length] }}
              />
              <span className="mf-alloc-legend-label" title={item.label}>{item.label}</span>
              <span className="mf-alloc-legend-pct">{item.pct.toFixed(1)}%</span>
              <span className="mf-alloc-legend-value">{formatMoney(item.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
