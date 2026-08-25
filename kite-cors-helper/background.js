import { buildLocalScreenerRules } from './rules/builder.js';
import { getInstrumentDumpEntries } from './instrumentDump.js';



const LOCAL_SCREENER_PATH = '/local-screener';

const LOCAL_SCREENER_URL = `https://kite.zerodha.com${LOCAL_SCREENER_PATH}`;

const ENABLED_KEY = 'kite-local-screener-enabled';

// Hosts the mutual-fund data proxy is allowed to fetch. The app runs in the
// MAIN world on kite.zerodha.com, so cross-origin fetches to these public data
// sources are blocked by CORS there — we proxy them through the service worker.
const MF_PROXY_HOSTS = new Set(['www.amfiindia.com', 'portal.amfiindia.com', 'api.mfapi.in', 'finapi.upvaly.com']);

async function proxyMfFetch(rawUrl, accept) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !MF_PROXY_HOSTS.has(url.hostname)) {
    throw new Error(`MF proxy host not allowed: ${url.hostname}`);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
    headers: { accept: accept || '*/*' },
  });

  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}


async function isEnabled() {

  const stored = await chrome.storage.local.get(ENABLED_KEY);

  return stored[ENABLED_KEY] !== false;

}



async function applyRules() {

  const enabled = await isEnabled();

  const existing = await chrome.declarativeNetRequest.getDynamicRules();

  const removeRuleIds = existing.map((rule) => rule.id);



  await chrome.declarativeNetRequest.updateDynamicRules({

    removeRuleIds,

    addRules: buildLocalScreenerRules(enabled),

  });

}



function isLocalScreenerUrl(urlString) {

  try {

    const url = new URL(urlString);

    return url.hostname === 'kite.zerodha.com' && url.pathname.startsWith(LOCAL_SCREENER_PATH);

  } catch {

    return false;

  }

}



// During an extension reload or tab close, chrome.scripting/tabs calls can
// reject because the target tab no longer exists. These are expected and noisy,
// so callers use this to swallow them instead of surfacing an uncaught error.
function isTabGoneError(error) {

  const msg = error && error.message ? error.message : '';

  return /No tab with id|The tab was closed|No frame with id|Frame with ID|No window with id|Cannot access/i.test(msg);

}



async function injectLocalScreener(tabId) {

  if (!(await isEnabled())) return;

  // Both webNavigation.onCompleted and the content script's activation message
  // can fire for the same page load. Injecting app.js twice into the MAIN world
  // re-declares its top-level identifiers ("Identifier '…' has already been
  // declared"). Set an atomic in-page flag first and bail if it is already set —
  // page JS is single-threaded, so the two guard funcs cannot interleave.
  const [{ result: alreadyInjected } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (window.__kiteLocalScreenerInjected) return true;
      window.__kiteLocalScreenerInjected = true;
      return false;
    },
  });

  if (alreadyInjected) return;

  await chrome.scripting.executeScript({

    target: { tabId },

    world: 'MAIN',

    func: () => {

      if (document.getElementById('kite-local-screener-mounted')) return;



      document.documentElement.style.height = '100%';

      document.body.innerHTML = '';

      document.body.style.margin = '0';

      document.body.style.height = '100%';

      document.body.style.overflow = 'hidden';



      const marker = document.createElement('div');

      marker.id = 'kite-local-screener-mounted';

      marker.style.display = 'none';

      document.body.appendChild(marker);



      const root = document.createElement('div');

      root.id = 'root';

      root.style.minHeight = '100vh';

      document.body.appendChild(root);

    },

  });



  await chrome.scripting.insertCSS({

    target: { tabId },

    files: ['app/assets/app.css'],

  });



  await chrome.scripting.executeScript({

    target: { tabId },

    files: ['app/assets/app.js'],

    world: 'MAIN',

  });

}



chrome.runtime.onInstalled.addListener(async () => {

  await applyRules();

});



chrome.runtime.onStartup.addListener(async () => {

  await applyRules();

});



chrome.webNavigation.onCompleted.addListener(async (details) => {

  if (details.frameId !== 0) return;

  if (!isLocalScreenerUrl(details.url)) return;



  try {

    await injectLocalScreener(details.tabId);

  } catch (error) {

    if (!isTabGoneError(error)) console.error('Failed to inject local screener', error);

  }

});



chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  (async () => {

    try {

    if (message.type === 'openLocalScreener') {

      await chrome.tabs.create({ url: LOCAL_SCREENER_URL });

      sendResponse({ ok: true, url: LOCAL_SCREENER_URL });

      return;

    }



    if (message.type === 'setEnabled') {

      await chrome.storage.local.set({ [ENABLED_KEY]: Boolean(message.enabled) });

      await applyRules();

      sendResponse({ ok: true, enabled: await isEnabled() });

      return;

    }



    if (message.type === 'getEnabled') {

      sendResponse({ ok: true, enabled: await isEnabled() });

      return;

    }



    if (message.type === 'activateLocalScreener' && _sender.tab?.id) {

      await injectLocalScreener(_sender.tab.id);

      sendResponse({ ok: true });

      return;

    }



    if (message.type === 'getEnctoken') {

      try {

        const [enctoken, userId] = await Promise.all([

          chrome.cookies.get({ url: 'https://kite.zerodha.com', name: 'enctoken' }),

          chrome.cookies.get({ url: 'https://kite.zerodha.com', name: 'user_id' }),

        ]);

        sendResponse({

          ok: true,

          enctoken: enctoken?.value || '',

          userId: userId?.value || '',

        });

      } catch (error) {

        sendResponse({ ok: false, error: error?.message || 'Failed to read Kite session cookie' });

      }

      return;

    }



    if (message.type === 'getInstrumentDump') {

      try {

        const entries = await getInstrumentDumpEntries();

        sendResponse({ ok: true, entries });

      } catch (error) {

        sendResponse({ ok: false, error: error?.message || 'Failed to load instrument dump' });

      }

      return;

    }

    if (message.type === 'mfFetch') {
      try {
        const result = await proxyMfFetch(message.url, message.accept);
        sendResponse({ ok: result.ok, status: result.status, text: result.text });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'MF fetch failed' });
      }
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });

    } catch (error) {

      if (!isTabGoneError(error)) console.error('Local screener background message handler failed', error);

      try { sendResponse({ ok: false, error: (error && error.message) || 'Background handler error' }); } catch (_e) { /* message channel already closed */ }

    }

  })();



  return true;

});

