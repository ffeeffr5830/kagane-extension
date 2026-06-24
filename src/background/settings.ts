/**
 * Kagane Downloader — Settings Storage Module
 *
 * Phase 6, Sub-Task 6.1
 *
 * Typed settings interface with chrome.storage.local persistence
 * and defaults merging.
 */

// ─── Types ─────────────────────────────────────────────

export interface AppSettings {
  format: 'images' | 'cbz' | 'pdf';
  maxConcurrentChapters: number;
  maxConcurrentImages: number;
  maxRetries: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  format: 'images',
  maxConcurrentChapters: 3,
  maxConcurrentImages: 5,
  maxRetries: 3,
};

// ─── Storage helpers ──────────────────────────────────

/**
 * Read settings from chrome.storage.local, merging with defaults.
 */
export async function getSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(result.settings || {}) } as AppSettings;
}

/**
 * Merge partial settings into current and persist to storage.
 * Returns the fully merged settings object.
 */
export async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await chrome.storage.local.set({ settings: merged });
  return merged;
}
