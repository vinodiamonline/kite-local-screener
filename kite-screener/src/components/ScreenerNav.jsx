import {
  BOOKMARKS_SCREENER_ID,
  CATEGORIES,
  DASHBOARD_SCREENER_ID,
  HIDDEN_SCREENER_ID,
  HOLDINGS_SCREENER_ID,
  POSITIONS_SCREENER_ID,
  MUTUAL_FUNDS_SCREENER_ID,
  MF_SAVED_SCREENER_ID,
  MF_HOLDINGS_SCREENER_ID,
  ETF_PICKS_SCREENER_ID,
} from '../screener/presets';
import { SCREENERS } from '../screener/presets';
import { MAX_WATCHLISTS, watchlistScreenerId } from '../screener/watchlists';

export default function ScreenerNav({
  bookmarkCount,
  hiddenCount,
  positionCount = 0,
  holdingsCount = 0,
  watchlists,
  activeScreenerId,
  setActiveScreenerId,
  activeCategory,
  setActiveCategory,
  onCreateWatchlist,
  onRenameWatchlist,
  onDeleteWatchlist,
  savedFundCount = 0,
  mfHoldingsCount = 0,
}) {
  const visible = SCREENERS.filter((screener) => screener.category === activeCategory);

  return (
    <aside className="screener-nav">
      <div className="nav-group">
        <div className="nav-section">
          <div className="wl-header">
            <span>Bookmarks</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === BOOKMARKS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(BOOKMARKS_SCREENER_ID)}
              >
                <span className="wl-item-name">All Bookmarks</span>
                <span className="wl-item-count">{bookmarkCount}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="nav-section">
          <div className="wl-header">
            <span>Watchlists</span>
            <button
              type="button"
              className="wl-new"
              disabled={watchlists.length >= MAX_WATCHLISTS}
              onClick={onCreateWatchlist}
              title={watchlists.length >= MAX_WATCHLISTS ? 'Maximum watchlists reached' : 'New watchlist'}
            >
              + New
            </button>
          </div>

          <div className="wl-list">
            {watchlists.map((list) => {
              const id = watchlistScreenerId(list.id);
              const active = activeScreenerId === id;
              return (
                <div key={list.id} className={`wl-item${active ? ' active' : ''}`}>
                  <button
                    type="button"
                    className="wl-item-main"
                    onClick={() => setActiveScreenerId(id)}
                  >
                    <span className="wl-item-name">{list.name}</span>
                    <span className="wl-item-count">{list.items.length}</span>
                  </button>
                  <span className="wl-item-actions">
                    <button
                      type="button"
                      title="Rename"
                      onClick={() => onRenameWatchlist(list.id, list.name)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => onDeleteWatchlist(list.id, list.name)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="nav-section">
          <div className="wl-header">
            <span>Portfolio</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === POSITIONS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(POSITIONS_SCREENER_ID)}
              >
                <span className="wl-item-name">Positions</span>
                <span className="wl-item-count">{positionCount}</span>
              </button>
            </div>
            <div className={`wl-item wl-item-fixed${activeScreenerId === HOLDINGS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(HOLDINGS_SCREENER_ID)}
              >
                <span className="wl-item-name">Holdings</span>
                <span className="wl-item-count">{holdingsCount}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="nav-section">
          <div className="wl-header">
            <span>Mutual Funds</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === MUTUAL_FUNDS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(MUTUAL_FUNDS_SCREENER_ID)}
              >
                <span className="wl-item-name">Fund Screener</span>
              </button>
            </div>
            <div className={`wl-item wl-item-fixed${activeScreenerId === MF_HOLDINGS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(MF_HOLDINGS_SCREENER_ID)}
              >
                <span className="wl-item-name">My Holdings</span>
                {mfHoldingsCount > 0 && <span className="wl-item-count">{mfHoldingsCount}</span>}
              </button>
            </div>
            <div className={`wl-item wl-item-fixed${activeScreenerId === MF_SAVED_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(MF_SAVED_SCREENER_ID)}
              >
                <span className="wl-item-name">Saved Funds</span>
                <span className="wl-item-count">{savedFundCount}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="nav-section nav-section-compact">
          <div className="wl-header">
            <span>Dashboard</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === DASHBOARD_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(DASHBOARD_SCREENER_ID)}
              >
                <span className="wl-item-name">Dashboard</span>
              </button>
            </div>
          </div>
        </div>

        <div className="nav-section nav-section-compact">
          <div className="wl-header">
            <span>ETFs</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === ETF_PICKS_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(ETF_PICKS_SCREENER_ID)}
              >
                <span className="wl-item-name">ETF Picks</span>
              </button>
            </div>
          </div>
        </div>

        <div className="nav-section">
          <div className="wl-header">
            <span>Hidden</span>
          </div>
          <div className="wl-list wl-list-bookmarks">
            <div className={`wl-item wl-item-fixed${activeScreenerId === HIDDEN_SCREENER_ID ? ' active' : ''}`}>
              <button
                type="button"
                className="wl-item-main"
                onClick={() => setActiveScreenerId(HIDDEN_SCREENER_ID)}
              >
                <span className="wl-item-name">Hidden Symbols</span>
                <span className="wl-item-count">{hiddenCount}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="nav-section nav-section-screeners">
        <div className="wl-header">
          <span>Screeners</span>
        </div>

        <div className="tabs">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              className={activeCategory === category ? 'active' : ''}
              onClick={() => {
                setActiveCategory(category);
                setActiveScreenerId(SCREENERS.find((screener) => screener.category === category)?.id);
              }}
            >
              {category}
            </button>
          ))}
        </div>

        <div className="preset-list">
          {visible.map((screener) => (
            <button
              key={screener.id}
              type="button"
              className={activeScreenerId === screener.id ? 'preset active' : 'preset'}
              onClick={() => setActiveScreenerId(screener.id)}
            >
              <span>{screener.title}</span>
              <small>{screener.description}</small>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
