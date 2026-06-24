/**
 * Kagane API Client — fetch-based HTTP client with retry logic.
 *
 * Port of the Python KaganeAPIClient using the Web Fetch API
 * (no curl-cffi dependency needed in a browser extension).
 */

import { type Series, normalizeSeries } from './types';

// ──────────────────────────────────────────
// Config
// ──────────────────────────────────────────

export interface ApiConfig {
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Maximum number of retry attempts on failure */
  maxRetries: number;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  baseUrl: 'https://yuzuki.kagane.to/api/v2',
  timeout: 15_000,
  maxRetries: 3,
};

// ──────────────────────────────────────────
// API Client
// ──────────────────────────────────────────

export class KaganeApiClient {
  private config: ApiConfig;

  constructor(config?: Partial<ApiConfig>) {
    this.config = { ...DEFAULT_API_CONFIG, ...config };
  }

  /**
   * Core request method with retry logic.
   * Uses AbortController for timeout and fetch for HTTP.
   * Retries up to `maxRetries` times on any failure.
   */
  private async request<T>(endpoint: string): Promise<T> {
    const url = `${this.config.baseUrl}${endpoint}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = (await response.json()) as T;
        return data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't delay on the last attempt
        if (attempt < this.config.maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error(`Request to ${endpoint} failed after ${this.config.maxRetries} attempts`);
  }

  /**
   * Fetch a series by its ID and return a normalized Series object.
   */
  async getSeries(seriesId: string): Promise<Series> {
    const data = await this.request<Record<string, unknown>>(`/series/${seriesId}`);
    return normalizeSeries(data);
  }

  /**
   * Construct image URLs from DRM token data.
   *
   * URL pattern:
   *   {cacheUrl}/api/v2/books/page/{bookId}/{pageId}.{ext}?token={token}
   *
   * Used to process content-script extracted sessionStorage data.
   */
  static buildImageUrls(
    cacheUrl: string,
    token: string,
    pages: Array<{ pageNo: number; pageId: string; ext: string }>,
    bookId: string,
  ): string[] {
    return pages.map((page) => {
      return `${cacheUrl}/api/v2/books/page/${bookId}/${page.pageId}.${page.ext}?token=${token}`;
    });
  }
}
