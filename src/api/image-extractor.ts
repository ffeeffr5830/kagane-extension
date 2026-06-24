/**
 * Image Extractor Module
 *
 * Bridges the plain-JS content-reader.js script with the TypeScript background worker.
 * Provides programmatic injection and token processing utilities.
 */

import { KaganeApiClient } from './client';

// ──────────────────────────────────────────
// Interfaces
// ──────────────────────────────────────────

export interface ExtractedPageData {
  bookId: string;
  imageUrls: string[];
  totalPages: number;
}

export interface ExtractionResult {
  success: boolean;
  data?: ExtractedPageData;
  error?: string;
}

// ──────────────────────────────────────────
// Image Extractor
// ──────────────────────────────────────────

/**
 * Manager for injecting content script and extracting image URLs
 * from a kagane.to reader page.
 */
export class ImageExtractor {
  /**
   * Inject content script into the active tab and wait for extraction result.
   * Uses chrome.scripting.executeScript to run the extraction code
   * (avoids needing a pre-declared content script for dynamic injection).
   */
  static async extractFromTab(
    tabId: number,
    seriesId: string,
    bookId: string,
  ): Promise<ExtractionResult> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractFromPage,
        args: [seriesId, bookId],
      });

      const rawResult = results?.[0]?.result as
        | { imageUrls: string[]; bookId: string; totalPages: number; error?: string }
        | { error: string }
        | undefined;

      if (!rawResult) {
        return { success: false, error: 'No result from injected script' };
      }

      if ('error' in rawResult && rawResult.error) {
        return { success: false, error: rawResult.error };
      }

      if ('imageUrls' in rawResult && rawResult.imageUrls.length > 0) {
        return {
          success: true,
          data: {
            bookId: rawResult.bookId ?? bookId,
            imageUrls: rawResult.imageUrls,
            totalPages: rawResult.totalPages,
          },
        };
      }

      return { success: false, error: 'No image URLs extracted' };
    } catch (err) {
      return {
        success: false,
        error: String(err),
      };
    }
  }

  /**
   * Process raw sessionStorage JSON into image URLs.
   * Can be used directly without tab injection.
   */
  static processTokens(
    tokensJson: string,
    seriesId: string,
    bookId: string,
  ): { imageUrls: string[]; totalPages: number } | null {
    try {
      const data = JSON.parse(tokensJson);
      const key = `${seriesId}:${bookId}`;
      let entry = data[key];

      // Fallback: if no exact match, try the only key available
      if (!entry) {
        const keys = Object.keys(data);
        if (keys.length === 1) {
          entry = data[keys[0]];
        }
      }

      if (!entry?.token || !entry?.cacheUrl || !entry?.pages) {
        return null;
      }

      const imageUrls = KaganeApiClient.buildImageUrls(
        entry.cacheUrl,
        entry.token,
        entry.pages,
        bookId,
      );

      return {
        imageUrls,
        totalPages: entry.pages.length,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Standalone function injected into the page via chrome.scripting.executeScript.
 * Extracts DRM tokens from sessionStorage and returns image URLs.
 * This must be a self-contained function (no imports).
 */
function extractFromPage(
  seriesId: string,
  bookId: string,
): { imageUrls: string[]; bookId: string; totalPages: number; error?: string } | { error: string } {
  try {
    const raw = sessionStorage.getItem('kagane_drm_tokens');
    if (!raw) {
      return { error: 'kagane_drm_tokens not found in sessionStorage' };
    }

    const data = JSON.parse(raw);
    const key = `${seriesId}:${bookId}`;
    let entry = data[key];

    // Fallback: single entry
    if (!entry) {
      const keys = Object.keys(data);
      if (keys.length === 1) {
        entry = data[keys[0]];
      }
    }

    if (!entry?.token || !entry?.cacheUrl || !entry?.pages) {
      return { error: 'No valid token entry found' };
    }

    const imageUrls = entry.pages.map(
      (page: { pageId: string; ext: string }) =>
        `${entry.cacheUrl}/api/v2/books/page/${bookId}/${page.pageId}.${page.ext}?token=${entry.token}`,
    );

    return {
      imageUrls,
      bookId,
      totalPages: entry.pages.length,
    };
  } catch (e) {
    return { error: String(e) };
  }
}
