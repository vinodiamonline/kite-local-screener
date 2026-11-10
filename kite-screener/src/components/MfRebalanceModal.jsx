import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  computeRebalance,
  groupHoldings,
  loadRebalanceTargets,
  saveRebalanceTargets,
} from '../screener/mfRebalance';

const DIMENSIONS = [
  { id: 'fund', label: 'Fund' },
  { id: 'subCategory', label: 'Category' },
  { id: 'schemeType', label: 'Type' },
];

const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmt = (v) => `₹${money.format(Math.round(Math.abs(v)))}`;
const round1 = (v) => Math.round(v * 10) / 10;

export default function MfRebalanceModal({ rows, onClose }) {
  const [dimension, setDimension] = useState('subCategory');
  const [allTargets, setAllTargets] = useState(() => loadRebalanceTargets());
  const [extra, setExtra] = useState('');
  const [mode, setMode] = useState('full');

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const groups = useMemo(() => groupHoldings(rows, dimension), [rows, dimension]);
  const targets = allTargets[dimension] || {};
  const hasTargets = groups.some((g) => targets[g.key] != null);
  const targetSum = groups.reduce((sum, g) => sum + (Number(targets[g.key]) || 0), 0);
  const valid = Math.abs(targetSum - 100) < 0.05;

  const result = useMemo(
    () => computeRebalance(groups, targets, Number(extra) || 0, mode),
    [groups, targets, extra, mode],
  );

  const updateTargets = (next) => {
    const merged = { ...allTargets, [dimension]: next };
    setAllTargets(merged);
    saveRebalanceTargets(merged);
  };
  const setTarget = (key, value) => {
    const next = { ...targets };
    if (value === '') delete next[key];
    else next[key] = Number(value);
    updateTargets(next);
  };
  const fillCurrent = () => {
    const total = groups.reduce((s, g) => s + g.value, 0) || 1;
    const next = {};
    groups.forEach((g) => { next[g.key] = round1((g.value / total) * 100); });
    // Push rounding drift into the largest bucket so the total is exactly 100.
    const drift = round1(100 - Object.values(next).reduce((a, b) => a + b, 0));
    if (groups[0]) next[groups[0].key] = round1(next[groups[0].key] + drift);
    updateTargets(next);
  };
  const fillEqual = () => {
    const each = round1(100 / (groups.length || 1));
    const next = {};
    groups.forEach((g) => { next[g.key] = each; });
    if (groups[0]) next[groups[0].key] = round1(each + 100 - each * groups.length);
    updateTargets(next);
  };

  return createPortal(
    <div className="fundamentals-modal-overlay" role="dialog" aria-modal="true" aria-label="Rebalance portfolio">
      <div className="fundamentals-modal-backdrop" onClick={onClose} />
      <div className="fundamentals-modal-panel mf-rebal-panel">
        <header className="fundamentals-modal-head">
          <div>
            <h3 className="fundamentals-modal-title">Rebalance</h3>
            <span className="fundamentals-modal-subtitle">
              Set a target mix; see how much to add or trim. Targets are saved in this browser.
            </span>
          </div>
          <button type="button" className="fundamentals-modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="mf-rebal-body">
          <div className="mf-rebal-controls">
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
            <button type="button" className="mf-rebal-link" onClick={fillCurrent}>Use current mix</button>
            <button type="button" className="mf-rebal-link" onClick={fillEqual}>Equal weights</button>
            <label className="mf-rebal-extra">
              <span>New money ₹</span>
              <input
                type="number"
                min="0"
                step="1000"
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                placeholder="0"
              />
            </label>
            <div className="mf-alloc-toggle" title="Add-only never sells, so it avoids exit load and tax">
              <button
                type="button"
                className={`mf-alloc-tab${mode === 'full' ? ' active' : ''}`}
                onClick={() => setMode('full')}
              >
                Buy &amp; sell
              </button>
              <button
                type="button"
                className={`mf-alloc-tab${mode === 'addOnly' ? ' active' : ''}`}
                onClick={() => setMode('addOnly')}
              >
                Add only
              </button>
            </div>
          </div>

          <table className="mfi-table mf-rebal-table">
            <thead>
              <tr>
                <th>{DIMENSIONS.find((d) => d.id === dimension)?.label}</th>
                <th className="mfi-num">Current</th>
                <th className="mfi-num">Now %</th>
                <th className="mfi-num">Target %</th>
                <th className="mfi-num">Action</th>
                <th className="mfi-num">After %</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => {
                const act = valid ? r.action : 0;
                const tiny = Math.abs(act) < 1;
                return (
                  <tr key={r.key}>
                    <td className="mfi-ellipsis" title={r.label}>{r.label}</td>
                    <td className="mfi-num">{fmt(r.value)}</td>
                    <td className="mfi-num">{r.currentPct.toFixed(1)}%</td>
                    <td className="mfi-num">
                      <input
                        className="mf-rebal-input"
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={targets[r.key] ?? ''}
                        onChange={(event) => setTarget(r.key, event.target.value)}
                        placeholder="—"
                      />
                    </td>
                    <td className={`mfi-num ${!valid || tiny ? '' : act > 0 ? 'cell-up' : 'cell-down'}`}>
                      {!valid ? '—' : tiny ? 'Hold' : `${act > 0 ? 'Buy' : 'Sell'} ${fmt(act)}`}
                    </td>
                    <td className="mfi-num">{valid ? `${r.afterPct.toFixed(1)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="mfi-num">{fmt(result.current)}</td>
                <td className="mfi-num">100%</td>
                <td className={`mfi-num ${valid ? '' : 'cell-down'}`}>{round1(targetSum)}%</td>
                <td className="mfi-num" colSpan={2}>
                  {Number(extra) > 0 ? `After: ${fmt(result.total)}` : ''}
                </td>
              </tr>
            </tfoot>
          </table>

          {!hasTargets && (
            <p className="mfi-note">Enter target % for each row, or start from “Use current mix”.</p>
          )}
          {hasTargets && !valid && (
            <p className="mfi-note mf-rebal-warn">Targets add up to {round1(targetSum)}% — they must total 100%.</p>
          )}
          {valid && mode === 'addOnly' && (
            <p className="mfi-note">
              Add-only splits the new money across under-weight rows, so nothing is sold. With too little new
              money the mix moves toward the target but may not reach it.
            </p>
          )}
          {valid && mode === 'full' && (
            <p className="mfi-note">Selling can trigger exit load and capital-gains tax; check those before acting.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
