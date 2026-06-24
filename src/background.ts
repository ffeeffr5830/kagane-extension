/**
 * Kagane Downloader — Service Worker (background.ts)
 *
 * MV3 background service worker entry point.
 * Built by Vite -> dist/assets/background.js
 *
 * Responsibilities (added in later phases):
 *   - Message routing from popup
 *   - API client calls (fetch series metadata)
 *   - Download queue management
 *   - Image URL extraction via content script
 *   - CBZ assembly via JSZip
 */

import { KaganeApiClient } from './api/client';
import { getSettings, updateSettings } from './background/settings';
import { DownloadQueue, type ChapterJob } from './background/download-queue';

const apiClient = new KaganeApiClient();

/** Active download queue instance (null when idle). */
let activeQueue: DownloadQueue | null = null;

/**
 * Stored image URLs extracted by content scripts from reader pages.
 * Keyed by bookId. Populated by 'reader:image-urls' messages.
 */
const extractedImageUrls = new Map<string, { imageUrls: string[]; totalPages: number; seriesId?: string }>();

/** Pending URL extraction promise resolvers, keyed by bookId. */
const pendingResolvers = new Map<string, (urls: string[]) => void>();

/**
 * Map of tabs that currently have a kagane.to reader/series page loaded.
 * tabId -> { seriesId, bookId, url }
 */
const knownTabs = new Map<number, { seriesId: string; bookId: string; url: string }>();

// ──────────────────────────────────────────
// Install / Initialize
// ──────────────────────────────────────────
function registerDNRRules() {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to/' },
          { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to' },
        ],
      },
      condition: {
        urlFilter: '||kstatic.to/',
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.IMAGE,
          chrome.declarativeNetRequest.ResourceType.SCRIPT,
          chrome.declarativeNetRequest.ResourceType.OTHER,
        ],
      },
    },
    {
      id: 2,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to/' },
          { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to' },
        ],
      },
      condition: {
        urlFilter: '||yuzuki.kagane.to/',
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.IMAGE,
          chrome.declarativeNetRequest.ResourceType.SCRIPT,
          chrome.declarativeNetRequest.ResourceType.OTHER,
        ],
      },
    },
    {
      id: 3,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to/' },
          { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.to' },
        ],
      },
      condition: {
        urlFilter: '||akari.kagane.to/',
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
          chrome.declarativeNetRequest.ResourceType.IMAGE,
          chrome.declarativeNetRequest.ResourceType.SCRIPT,
          chrome.declarativeNetRequest.ResourceType.OTHER,
        ],
      },
    },
  ];

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2, 3],
    addRules: rules,
  }).catch((err) => {
    console.error('[Kagane] Failed to update dynamic DNR rules:', err);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Kagane Downloader] Installed: ${details.reason}`);

  if (details.reason === 'install') {
    // Set default settings on first install
    chrome.storage.local.set({
      settings: {
        format: 'images', // 'images' | 'cbz'
        maxConcurrentChapters: 3,
        maxConcurrentImages: 5,
        maxRetries: 3,
      },
    });
  }

  // ─── DNR: Set Referer header for kagane.to CDN domains ───
  registerDNRRules();
});

// ──────────────────────────────────────────
// Keep-Alive (prevent SW termination during long downloads)
// ──────────────────────────────────────────
chrome.alarms.get('keep-alive', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('keep-alive', { periodInMinutes: 0.33 }); // ~20 seconds
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    // No-op keeps service worker alive
  }
});

// ─── DNR: Re-register at top level so rules apply on SW restart too ───
registerDNRRules();

// Keep DNR rules alive on browser start as well.
chrome.runtime.onStartup.addListener(() => {
  registerDNRRules();
});

// Track kagane.to tab lifetime so we know which tab to query.
chrome.tabs.onRemoved.addListener((tabId) => {
  knownTabs.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  if (!tab.url || !/kagane\.to/.test(tab.url)) {
    knownTabs.delete(tabId);
  }
});

// ──────────────────────────────────────────
// Extract series ID from URL
// ──────────────────────────────────────────

/**
 * Extract a series ID from a kagane.to URL.
 * Supports formats:
 *   https://kagane.to/series/{uuid}/...
 *   https://kagane.to/reader/{uuid}/{bookId}
 *   {id} (bare numeric or UUID string)
 */
function extractSeriesId(url: string): string | null {
  if (!url) return null;

  // Bare ID (numeric or UUID)
  if (/^[\w-]+$/.test(url)) return url;

  try {
    const u = new URL(url);
    // /series/{id}... or /reader/{id}/...
    const match = u.pathname.match(/\/(series|reader)\/([^/]+)/);
    if (match) return match[2];
  } catch {
    // Not a valid URL, try raw path
    const match = url.match(/\/(series|reader)\/([^/]+)/);
    if (match) return match[2];
  }

  return null;
}

// ──────────────────────────────────────────
// Image URL Extraction: open reader tabs to get DRM tokens
// ──────────────────────────────────────────

/** Small sleep helper for polling. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * For each book, locate an active kagane.to tab and ask its content script
 * (via the new iframe mechanism) to fetch image URLs for that chapter.
 * If no tab exists, open one in the foreground.
 *
 * Returns a map of bookId → imageUrls.
 */
async function extractImageUrlsForChapters(
  seriesId: string,
  books: { bookId: string; chapterNo: string }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const needExtraction = books.filter((b) => {
    const stored = extractedImageUrls.get(b.bookId);
    return !(stored && stored.imageUrls.length > 0);
  });

  // Reuse cached values for the others.
  for (const book of books) {
    const stored = extractedImageUrls.get(book.bookId);
    if (stored && stored.imageUrls.length > 0) {
      result.set(book.bookId, stored.imageUrls);
    }
  }

  if (needExtraction.length === 0) return result;

  // Extract one by one to avoid overloading the browser
  for (const book of needExtraction) {
    let tabId: number | undefined;
    try {
      const url = `https://kagane.to/series/${seriesId}/reader/${book.bookId}`;
      console.log(`[Kagane] Opening background tab for extraction: ${url}`);
      
      // Open inactive tab
      const tab = await chrome.tabs.create({
        url,
        active: false,
      });
      tabId = tab.id;

      if (tabId != null) {
        // Wait for content script to send URLs
        const urls = await new Promise<string[]>((resolve) => {
          const timeout = setTimeout(() => {
            console.warn(`[Kagane] Timeout extracting URLs for book ${book.bookId}`);
            pendingResolvers.delete(book.bookId);
            resolve([]);
          }, 25000); // 25s timeout per tab

          pendingResolvers.set(book.bookId, (extractedUrls) => {
            clearTimeout(timeout);
            pendingResolvers.delete(book.bookId);
            resolve(extractedUrls);
          });
        });

        if (urls.length > 0) {
          result.set(book.bookId, urls);
        }
      }
    } catch (err) {
      console.warn(`[Kagane] Failed to extract from tab for book ${book.bookId}:`, err);
    } finally {
      if (tabId != null) {
        try {
          await chrome.tabs.remove(tabId);
          console.log(`[Kagane] Closed extraction tab ${tabId}`);
        } catch (err) {
          console.warn(`[Kagane] Failed to close tab ${tabId}:`, err);
        }
      }
    }
  }

  return result;
}

async function findKaganeTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: ['https://kagane.to/*', 'https://www.kagane.to/*'] });
  // Prefer an already-known reader/series tab, otherwise any kagane.to tab.
  if (tabs.length === 0) return null;
  for (const t of tabs) {
    if (t.id != null && knownTabs.has(t.id)) return t;
  }
  return tabs[0];
}

async function openKaganeTab(seriesId: string): Promise<chrome.tabs.Tab | null> {
  try {
    const tab = await chrome.tabs.create({
      url: `https://kagane.to/series/${seriesId}`,
      active: false,
    });
    if (tab.id != null) {
      // Give it a moment to load so the content script is injected.
      await waitForContentScript(tab.id, 8000);
    }
    return tab;
  } catch (err) {
    console.warn('[Kagane] Failed to open tab:', err);
    return null;
  }
}

/**
 * Probe a tab until the content script responds (proves it's loaded &
 * listening). The script injects at document_idle so we give it up to
 * `timeoutMs` to settle.
 */
async function waitForContentScript(tabId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await chrome.tabs.sendMessage(tabId, { type: 'content-reader:ping' });
      // Some listeners may respond, some may not — we just need the
      // channel open with no error, so any reply (or absence of error)
      // confirms the receiver exists.
      if (probe !== undefined) return;
    } catch (_) {
      // No listener yet — wait and retry.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ──────────────────────────────────────────
// Message Router
// ──────────────────────────────────────────
export type BgMessage =
  | { type: 'ping' }
  | { type: 'fetch-series'; url: string }
  | { type: 'fetch-cover'; url: string }
  | { type: 'start-download'; seriesId: string; bookIds: string[]; format: 'images' | 'cbz' | 'pdf' }
  | { type: 'get-settings' }
  | { type: 'update-settings'; settings: Partial<Record<string, unknown>> }
  | { type: 'cancel-download' }
  | { type: 'get-progress' }
  | { type: 'reader:image-urls'; payload: { bookId: string; imageUrls: string[]; totalPages: number; seriesId: string } }
  | { type: 'reader:context'; payload: { seriesId: string; bookId: string; url: string } }
  | { type: 'chapter:fetch-urls'; payload: { seriesId: string; bookId: string } }
  | { type: 'content-reader:ping' };

export type BgResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

chrome.runtime.onMessage.addListener(
  (message: BgMessage, _sender, sendResponse: (response: BgResponse) => void) => {
    console.log('[Kagane Downloader] SW received:', message.type);

    switch (message.type) {
      case 'ping':
        sendResponse({ ok: true, data: { version: '1.0.0' } });
        break;

      case 'fetch-series': {
        const seriesId = extractSeriesId(message.url);
        if (!seriesId) {
          sendResponse({ ok: false, error: `Could not extract series ID from URL: ${message.url}` });
          break;
        }
        apiClient
          .getSeries(seriesId)
          .then((series) => {
            sendResponse({ ok: true, data: series });
          })
          .catch((err) => {
            sendResponse({ ok: false, error: String(err) });
          });
        return true; // Keep channel open for async
      }

      case 'start-download': {
        (async () => {
          try {
            const { seriesId, bookIds, format } = message as {
              type: 'start-download';
              seriesId: string;
              bookIds: string[];
              format: 'images' | 'cbz' | 'pdf';
            };

            // Fetch series to get book metadata
            const series = await apiClient.getSeries(seriesId);
            const settings = await getSettings();

            // Build ChapterJob objects for the requested books
            const books = series.seriesBooks.filter((b) => bookIds.includes(b.bookId));
            if (books.length === 0) {
              sendResponse({ ok: false, error: 'No matching books found for the given bookIds' });
              return;
            }

            // Sort by sortNo to maintain chapter order
            books.sort((a, b) => a.sortNo - b.sortNo);

            // Extract image URLs by opening reader tabs for each chapter
            const imageUrlsMap = await extractImageUrlsForChapters(
              seriesId,
              books.map((b) => ({ bookId: b.bookId, chapterNo: b.chapterNo })),
            );

            // Report which chapters failed extraction
            const missingChapters: string[] = [];
            for (const book of books) {
              if (!imageUrlsMap.has(book.bookId)) {
                missingChapters.push(`${book.chapterNo}`);
              }
            }
            if (missingChapters.length > 0) {
              console.warn(`[Kagane] No image URLs for chapters: ${missingChapters.join(', ')}`);
            }

            const jobs: ChapterJob[] = books.map((book) => ({
              bookId: book.bookId,
              seriesId: series.seriesId,
              seriesTitle: series.title,
              chapterNo: book.chapterNo,
              title: book.title,
              pageCount: book.pageCount,
              format: format || settings.format,
              status: 'queued' as const,
              progress: 0,
              imageUrls: imageUrlsMap.get(book.bookId) || [],
              downloadedImages: [],
            }));

            // Create new queue instance
            const queue = new DownloadQueue(
              settings.maxConcurrentChapters,
              settings.maxConcurrentImages,
            );

            // Cancel any previous download first
            if (activeQueue) {
              activeQueue.cancel();
            }
            activeQueue = queue;

            // Start processing (fire-and-forget)
            queue.addChapters(jobs);

            sendResponse({ ok: true, data: { jobCount: jobs.length } });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
        return true; // Keep channel open for async response
      }

      case 'get-settings': {
        getSettings()
          .then((settings) => sendResponse({ ok: true, data: settings }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'update-settings': {
        const partial = (message as { type: 'update-settings'; settings: Partial<Record<string, unknown>> }).settings;
        updateSettings(partial as Partial<import('./background/settings').AppSettings>)
          .then((merged) => sendResponse({ ok: true, data: merged }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'cancel-download': {
        if (activeQueue) {
          activeQueue.cancel();
          activeQueue = null;
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'No active download to cancel' });
        }
        break;
      }

      case 'get-progress': {
        if (activeQueue) {
          sendResponse({ ok: true, data: activeQueue.getProgress() });
        } else {
          sendResponse({ ok: true, data: null });
        }
        break;
      }

      case 'reader:image-urls': {
        const payload = (message as {
          type: 'reader:image-urls';
          payload: { bookId: string; imageUrls: string[]; totalPages: number; seriesId: string };
        }).payload;

        if (payload && payload.bookId && Array.isArray(payload.imageUrls)) {
          extractedImageUrls.set(payload.bookId, {
            imageUrls: payload.imageUrls,
            totalPages: payload.totalPages,
            seriesId: payload.seriesId,
          });
          console.log(`[Kagane] Stored ${payload.imageUrls.length} image URLs for book ${payload.bookId}. First URL: ${payload.imageUrls[0]}`);
          
          const resolver = pendingResolvers.get(payload.bookId);
          if (resolver) {
            resolver(payload.imageUrls);
          }
          
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Invalid reader:image-urls payload' });
        }
        break;
      }

      case 'reader:context': {
        const payload = (message as {
          type: 'reader:context';
          payload: { seriesId: string; bookId: string; url: string };
        }).payload;
        const tabId = _sender?.tab?.id;
        if (tabId != null && payload) {
          knownTabs.set(tabId, {
            seriesId: payload.seriesId,
            bookId: payload.bookId,
            url: payload.url,
          });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'content-reader:ping': {
        sendResponse({ ok: true, data: { pong: Date.now() } });
        break;
      }

      case 'chapter:fetch-urls': {
        // Forward to the existing receiver on whichever tab the popup's
        // open kagane.to tab is on. The message handler stays here so
        // external callers (other content scripts / popups) can use it.
        const payload = (message as {
          type: 'chapter:fetch-urls';
          payload: { seriesId: string; bookId: string };
        }).payload;
        (async () => {
          const tab = await findKaganeTab();
          if (!tab || tab.id == null) {
            sendResponse({ ok: false, error: 'No kagane.to tab available' });
            return;
          }
          try {
            const resp = await chrome.tabs.sendMessage(tab.id, {
              type: 'chapter:fetch-urls',
              payload,
            });
            sendResponse(resp ?? { ok: false, error: 'No response from content script' });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      case 'fetch-cover': {
        (async () => {
          try {
            const url = (message as { type: 'fetch-cover'; url: string }).url;
            const response = await fetch(url, {
              headers: {
                Referer: 'https://kagane.to/',
                Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
              },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} fetching cover`);
            }
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            const mime = blob.type || 'image/jpeg';
            const dataUrl = `data:${mime};base64,${base64}`;
            sendResponse({ ok: true, data: { dataUrl } });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
        return true;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${(message as { type: string }).type}` });
    }
  }
);

// Log SW startup (useful for debugging lifecycle)
console.log('[Kagane Downloader] Service worker started');
