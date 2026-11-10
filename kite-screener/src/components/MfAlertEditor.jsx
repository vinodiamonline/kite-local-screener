import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setMfAlert } from '../screener/mfAlerts';

// Small dialog to set "NAV at or above" / "at or below" thresholds for a fund.
export default function MfAlertEditor({ isin, name, nav, alert, onClose }) {
  const [above, setAbove] = useState(alert?.above ?? '');
  const [below, setBelow] = useState(alert?.below ?? '');
  const firstRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => firstRef.current?.focus());
  }, []);

  const save = () => {
    setMfAlert(isin, { above, below });
    onClose();
  };
  const remove = () => {
    setMfAlert(isin, {});
    onClose();
  };

  return createPortal(
    <div
      className="note-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`NAV alert for ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'Enter') save();
      }}
    >
      <div className="note-editor-backdrop" onClick={onClose} />
      <div className="note-editor-panel">
        <div className="note-editor-head">
          <span className="note-editor-title">NAV alert · {name}</span>
          <button type="button" className="note-editor-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="mf-alert-current">
          Current NAV <strong>{Number.isFinite(nav) ? nav.toFixed(2) : '—'}</strong>.
          Alerts are checked each time you open or refresh your holdings.
        </p>
        <div className="mf-alert-fields">
          <label>
            <span>Alert when NAV ≥</span>
            <input
              ref={firstRef}
              type="number"
              min="0"
              step="0.01"
              value={above}
              onChange={(event) => setAbove(event.target.value)}
              placeholder="e.g. upper target"
            />
          </label>
          <label>
            <span>Alert when NAV ≤</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={below}
              onChange={(event) => setBelow(event.target.value)}
              placeholder="e.g. buy-the-dip level"
            />
          </label>
        </div>
        <div className="note-editor-actions">
          {alert && (
            <button type="button" className="note-editor-btn note-editor-delete" onClick={remove}>Remove</button>
          )}
          <span className="note-editor-hint">Leave a field empty to skip it</span>
          <button type="button" className="note-editor-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="note-editor-btn note-editor-save" onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
