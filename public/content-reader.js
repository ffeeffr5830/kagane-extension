// Kagane Downloader — Content Reader Script
// Injected into kagane.to pages.
//
// Responsibilities:
//   1. Auto-extract image URLs for a chapter by watching sessionStorage
//      (kagane_drm_tokens) for the reader page — preferred signal.
//   2. Fall back to scanning <img> elements already in the DOM.
//   3. Respond to `chapter:fetch-urls` requests from the service worker by
//      opening a hidden iframe to the reader URL, waiting for the host
//      site's JS to populate sessionStorage inside it, and returning URLs.
//   4. Notify the SW about reader pages so the popup can detect the
//      current series/book context.
//
// MUST be plain JavaScript (no import/export) per MV3 content script rules.

(function () {
  'use strict';

  console.log('[Kagane Downloader] Content reader injected');

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────

  function extractIdsFromUrl() {
    var pathname = window.location.pathname;
    // /series/{id}/reader/{bookId}
    var m = pathname.match(/\/series\/([^/]+)\/reader\/([^/]+)/);
    if (m) return { seriesId: m[1], bookId: m[2] };
    // /reader/{bookId}
    m = pathname.match(/\/reader\/([^/]+)/);
    if (m) return { seriesId: '', bookId: m[1] };
    // /series/{id}  (series page — useful for letting SW know what's open)
    m = pathname.match(/\/series\/([^/]+)/);
    if (m) return { seriesId: m[1], bookId: '' };
    return null;
  }

  function buildUrlsFromTokens(tokens, bookId) {
    if (!tokens || typeof tokens !== 'object') return [];
    var keys = Object.keys(tokens);
    if (keys.length === 0) return [];

    var matchedKey = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(bookId) !== -1) {
        matchedKey = keys[i];
        break;
      }
    }
    if (!matchedKey) {
      matchedKey = keys[0];
    }

    var entry = tokens[matchedKey];
    if (!entry || !entry.token || !entry.cacheUrl || !Array.isArray(entry.pages) || entry.pages.length === 0) {
      return [];
    }

    // Clone and sort pages by page number to guarantee correct order
    var pages = entry.pages.slice();
    pages.sort(function (a, b) {
      var noA = a.page_no !== undefined ? a.page_no : a.pageNo;
      var noB = b.page_no !== undefined ? b.page_no : b.pageNo;
      return (noA || 0) - (noB || 0);
    });

    return pages.map(function (page) {
      var pId = page.page_id || page.pageId;
      var pExt = page.ext || 'webp';
      return entry.cacheUrl +
        '/api/v2/books/page/' +
        bookId +
        '/' +
        pId +
        '.' +
        pExt +
        '?token=' +
        entry.token;
    });
  }

  /** Read tokens from a given Storage-like object. */
  function readTokensFrom(storage) {
    try {
      var raw = storage.getItem('kagane_drm_tokens');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function extractImageSrcs() {
    var images = document.querySelectorAll('img.reader-image[src]');
    if (images.length > 0) {
      return Array.from(images)
        .map(function (img) { return img.getAttribute('src') || ''; })
        .filter(function (src) { return src.startsWith('http'); });
    }
    var candidates = document.querySelectorAll('img[src*="kstatic"]');
    if (candidates.length > 0) {
      return Array.from(candidates)
        .map(function (img) { return img.getAttribute('src') || ''; })
        .filter(function (src) { return src.startsWith('http'); });
    }
    return [];
  }

  function sendImageUrls(bookId, seriesId, urls) {
    if (!urls || urls.length === 0) return;
    chrome.runtime.sendMessage({
      type: 'reader:image-urls',
      payload: {
        bookId: bookId,
        seriesId: seriesId || '',
        imageUrls: urls,
        totalPages: urls.length,
      },
    });
  }

  // ──────────────────────────────────────────
  // Auto-detect: send book context + URLs as soon as sessionStorage has them
  // ──────────────────────────────────────────

  function autoDetectAndSend(maxWaitMs) {
    if (maxWaitMs === undefined) maxWaitMs = 45000;

    var ids = extractIdsFromUrl();
    if (!ids) {
      console.warn('[Kagane Downloader] Could not extract IDs from URL:', window.location.href);
      return;
    }

    // Tell the SW which series/book is currently loaded in this tab — useful
    // for the popup and for the chapter-fetch flow.
    chrome.runtime.sendMessage({
      type: 'reader:context',
      payload: {
        seriesId: ids.seriesId || '',
        bookId: ids.bookId || '',
        url: window.location.href,
      },
    });

    if (!ids.bookId) return; // Series page, no chapter to extract.

    var startedAt = Date.now();
    var done = false;

    function finishWith(urls, source) {
      if (done) return;
      done = true;
      if (urls.length > 0) {
        console.log('[Kagane Downloader] Extracted', urls.length, 'URLs via', source, 'for', ids.bookId);
        sendImageUrls(ids.bookId, ids.seriesId, urls);
      } else {
        console.log('[Kagane Downloader] No URLs extracted via', source, 'for', ids.bookId);
      }
    }

    function tick() {
      if (done) return;

      // Prefer sessionStorage — populated exactly once by host JS after
      // its image-loading pipeline runs.
      var tokens = readTokensFrom(window.sessionStorage);
      if (tokens) {
        var urls = buildUrlsFromTokens(tokens, ids.bookId);
        if (urls.length > 0) {
          finishWith(urls, 'sessionStorage');
          return;
        }
      }

      // Fall back to DOM <img> scan.
      var srcs = extractImageSrcs();
      if (srcs.length > 0) {
        finishWith(srcs, 'dom');
        return;
      }

      if (Date.now() - startedAt < maxWaitMs) {
        setTimeout(tick, 500);
      } else {
        finishWith([], 'timeout');
      }
    }

    tick();
  }

  autoDetectAndSend();

  // ──────────────────────────────────────────
  // On-demand fetch: hidden iframe to reader URL inside the current tab
  // ──────────────────────────────────────────

  /**
   * Open a sandboxed-but-allow-same-origin iframe inside the current page.
   * The reader page lives in the same kagane.to origin so its sessionStorage
   * is separate from ours, but its JS writes to its own sessionStorage which
   * we read cross-frame.
   */
  function fetchUrlsViaHiddenFrame(seriesId, bookId, timeoutMs) {
    if (timeoutMs === undefined) timeoutMs = 45000;
    return new Promise(function (resolve, reject) {
      var existing = document.getElementById('__kagane_hidden_frame__');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

      var iframe = document.createElement('iframe');
      iframe.id = '__kagane_hidden_frame__';
      iframe.src = 'https://kagane.to/series/' + encodeURIComponent(seriesId) +
                   '/reader/' + encodeURIComponent(bookId);
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('tabindex', '-1');
      iframe.style.cssText =
        'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;' +
        'border:0;opacity:0;pointer-events:none;';

      var settled = false;
      var iframePoll = null;
      var parentPoll = null;
      var hardTimeout = null;

      function cleanup() {
        if (iframePoll) { clearInterval(iframePoll); iframePoll = null; }
        if (parentPoll) { clearInterval(parentPoll); parentPoll = null; }
        if (hardTimeout) { clearTimeout(hardTimeout); hardTimeout = null; }
        if (iframe.parentNode) {
          try { iframe.parentNode.removeChild(iframe); } catch (_) {}
        }
      }

      function resolveOnce(urls) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(urls);
      }

      function rejectOnce(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      function attemptFromIframeStorage() {
        try {
          var win = iframe.contentWindow;
          if (!win || !win.sessionStorage) return false;
          var tokens = readTokensFrom(win.sessionStorage);
          if (!tokens) return false;
          var urls = buildUrlsFromTokens(tokens, bookId);
          if (urls.length > 0) {
            resolveOnce(urls);
            return true;
          }
        } catch (_) {}
        return false;
      }

      function attemptFromParentStorage() {
        try {
          var tokens = readTokensFrom(window.sessionStorage);
          if (!tokens) return;
          var urls = buildUrlsFromTokens(tokens, bookId);
          if (urls.length > 0) resolveOnce(urls);
        } catch (_) {}
      }

      iframe.onload = function () {
        if (iframePoll) clearInterval(iframePoll);
        iframePoll = setInterval(attemptFromIframeStorage, 400);

        if (parentPoll) clearInterval(parentPoll);
        parentPoll = setInterval(attemptFromParentStorage, 600);
      };

      iframe.onerror = function () {
        rejectOnce(new Error('Reader iframe failed to load'));
      };

      (document.body || document.documentElement).appendChild(iframe);

      hardTimeout = setTimeout(function () {
        rejectOnce(new Error('Reader iframe timed out'));
      }, timeoutMs);
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;

    // Liveness probe used by the service worker before sending real work.
    if (msg.type === 'content-reader:ping') {
      sendResponse({ ok: true, data: { pong: Date.now() } });
      return false;
    }

    if (msg.type !== 'chapter:fetch-urls') return false;

    var payload = msg.payload || {};
    var seriesId = payload.seriesId;
    var bookId = payload.bookId;
    if (!seriesId || !bookId) {
      sendResponse({ ok: false, error: 'Missing seriesId/bookId' });
      return false;
    }

    fetchUrlsViaHiddenFrame(seriesId, bookId)
      .then(function (urls) {
        sendResponse({ ok: true, data: { bookId: bookId, imageUrls: urls } });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });

    return true; // Async response.
  });
})();
