/**
 * Unit tests for settings module — defaults, merging, persistence.
 *
 * Phase 6, Sub-Task 6.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../settings';
import type { AppSettings } from '../settings';

// ─── Mock chrome.storage.local ────────────────────────

function mockChromeStorage(stored: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = { ...stored };

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(
          (keys: string | string[] | Record<string, unknown> | null,
           callback?: (items: Record<string, unknown>) => void) => {
            if (typeof keys === 'string') {
              const result = { [keys]: storage[keys] ?? null };
              callback?.(result);
              return Promise.resolve(result);
            }
            const result = { ...storage };
            callback?.(result);
            return Promise.resolve(result);
          },
        ),
        set: vi.fn(
          (items: Record<string, unknown>,
           callback?: () => void) => {
            Object.assign(storage, items);
            callback?.();
            return Promise.resolve();
          },
        ),
      },
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

describe('getSettings', () => {
  it('returns DEFAULT_SETTINGS when storage is empty', async () => {
    mockChromeStorage({});
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored values with defaults (stored wins)', async () => {
    mockChromeStorage({
      settings: { format: 'cbz', maxConcurrentChapters: 5 },
    });
    const settings = await getSettings();
    expect(settings.format).toBe('cbz');
    expect(settings.maxConcurrentChapters).toBe(5);
    expect(settings.maxConcurrentImages).toBe(DEFAULT_SETTINGS.maxConcurrentImages);
    expect(settings.maxRetries).toBe(DEFAULT_SETTINGS.maxRetries);
  });

  it('handles partial stored data gracefully', async () => {
    mockChromeStorage({
      settings: { format: 'cbz' },
    });
    const settings = await getSettings();
    expect(settings.format).toBe('cbz');
    expect(settings.maxConcurrentChapters).toBe(3); // default
    expect(settings.maxRetries).toBe(3);             // default
  });
});

describe('updateSettings', () => {
  it('merges partial update into current settings', async () => {
    mockChromeStorage({});
    const merged = await updateSettings({ maxConcurrentImages: 10 });
    expect(merged.maxConcurrentImages).toBe(10);
    expect(merged.format).toBe('images'); // default preserved
  });

  it('persists merged settings to storage', async () => {
    mockChromeStorage({});
    await updateSettings({ maxRetries: 5 });
    // Verify by reading back
    const result = await getSettings();
    expect(result.maxRetries).toBe(5);
    expect(result.format).toBe('images');
  });

  it('overwrites existing values (not deep merge)', async () => {
    mockChromeStorage({
      settings: { format: 'cbz', maxConcurrentChapters: 10, maxRetries: 1 },
    });
    const merged = await updateSettings({ format: 'images' });
    expect(merged.format).toBe('images');
    expect(merged.maxConcurrentChapters).toBe(10); // unchanged
    expect(merged.maxRetries).toBe(1);              // unchanged
  });

  it('returns the full merged settings object', async () => {
    mockChromeStorage({});
    const result = await updateSettings({ format: 'cbz' });
    expect(result).toHaveProperty('format', 'cbz');
    expect(result).toHaveProperty('maxConcurrentChapters');
    expect(result).toHaveProperty('maxConcurrentImages');
    expect(result).toHaveProperty('maxRetries');
  });
});
