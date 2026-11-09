import { useEffect, useRef } from 'react';
import { getSymbol } from './ScreenerTable';
import { getSymbolNote, openNoteEditor } from '../screener/symbolNotes';

export default function SymbolContextMenu({
  menu,
  onClose,
  onHideSymbol,
  onUnhideSymbol,
  onRemoveFromWatchlist,
  isBookmarked,
  onToggleBookmark,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;

    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      onClose?.();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    const onScroll = () => onClose?.();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menu, onClose]);

  if (!menu?.row) return null;

  const symbol = getSymbol(menu.row);
  const bookmarked = isBookmarked?.(menu.row);

  const run = (action) => {
    action?.(menu.row);
    onClose?.();
  };

  const items = [];
  items.push({
    id: 'note',
    label: getSymbolNote(menu.row) ? 'Edit note' : 'Add note',
    action: () => run(openNoteEditor),
  });
  if (onUnhideSymbol) {
    items.push({ id: 'unhide', label: 'Unhide symbol', action: () => run(onUnhideSymbol) });
  } else if (onHideSymbol) {
    items.push({ id: 'hide', label: 'Hide symbol', action: () => run(onHideSymbol) });
  }
  if (onToggleBookmark) {
    items.push({
      id: 'bookmark',
      label: bookmarked ? 'Remove bookmark' : 'Add bookmark',
      action: () => run(onToggleBookmark),
    });
  }
  if (onRemoveFromWatchlist) {
    items.push({
      id: 'remove-watchlist',
      label: 'Remove from watchlist',
      action: () => run(onRemoveFromWatchlist),
    });
  }

  if (!items.length) return null;

  const maxLeft = Math.max(8, window.innerWidth - 200);
  const maxTop = Math.max(8, window.innerHeight - items.length * 36 - 16);
  const left = Math.min(menu.x, maxLeft);
  const top = Math.min(menu.y, maxTop);

  return (
    <div
      ref={menuRef}
      className="symbol-context-menu"
      style={{ left, top }}
      role="menu"
      aria-label={`Actions for ${symbol}`}
    >
      <div className="symbol-context-menu-head">{symbol}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="symbol-context-menu-item"
          role="menuitem"
          onClick={item.action}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
