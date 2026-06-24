/**
 * Unit tests for client.ts — KaganeApiClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KaganeApiClient } from '../client';

// ──────────────────────────────────────────
// Mock data
// ──────────────────────────────────────────

const MOCK_SERIES_RESPONSE: Record<string, unknown> = {
  series_id: '42',
  title: 'Mock Series',
  description: 'A mocked series for testing',
  format: 'Manhwa',
  content_rating: 'Safe',
  publication_status: 'Ongoing',
  upload_status: 'Active',
  original_language: 'ko',
  translated_language: 'en',
  title_language: 'en',
  current_books: 15,
  total_views: 500000,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  source_id: '',
  tracker_id: '',
  genres: [],
  tags: [],
  series_alternate_titles: [],
  series_books: [],
  series_covers: [],
  series_links: [],
  series_staff: [],
};

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('KaganeApiClient', () => {
  let client: KaganeApiClient;

  beforeEach(() => {
    client = new KaganeApiClient({
      baseUrl: 'https://yuzuki.kagane.to/api/v2',
      timeout: 5000,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSeries()', () => {
    it('returns a normalized Series on successful fetch', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(MOCK_SERIES_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const series = await client.getSeries('42');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(series.seriesId).toBe('42');
      expect(series.title).toBe('Mock Series');
      expect(series.format).toBe('Manhwa');
      expect(series.currentBooks).toBe(15);

      mockFetch.mockRestore();
    });

    it('retries on network failure up to maxRetries and succeeds', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch');

      // First two calls fail, third succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_SERIES_RESPONSE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const series = await client.getSeries('42');

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(series.seriesId).toBe('42');
      expect(series.title).toBe('Mock Series');

      mockFetch.mockRestore();
    });

    it('throws after exhausting all retry attempts', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch');
      mockFetch.mockRejectedValue(new Error('Persistent failure'));

      await expect(client.getSeries('42')).rejects.toThrow(
        'Persistent failure',
      );

      expect(mockFetch).toHaveBeenCalledTimes(3);

      mockFetch.mockRestore();
    });
  });

  describe('buildImageUrls()', () => {
    it('constructs correct URL array from token data', () => {
      const cacheUrl = 'https://cache.kagane.to';
      const token = 'abc123token';
      const pages = [
        { pageNo: 1, pageId: 'page_001', ext: 'jpg' },
        { pageNo: 2, pageId: 'page_002', ext: 'png' },
        { pageNo: 3, pageId: 'page_003', ext: 'webp' },
      ];
      const bookId = 'book_99';

      const urls = KaganeApiClient.buildImageUrls(cacheUrl, token, pages, bookId);

      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe(
        'https://cache.kagane.to/api/v2/books/page/book_99/page_001.jpg?token=abc123token',
      );
      expect(urls[1]).toBe(
        'https://cache.kagane.to/api/v2/books/page/book_99/page_002.png?token=abc123token',
      );
      expect(urls[2]).toBe(
        'https://cache.kagane.to/api/v2/books/page/book_99/page_003.webp?token=abc123token',
      );
    });
  });
});
