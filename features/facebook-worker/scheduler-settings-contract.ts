export const DEFAULT_WATCHER_SCAN_INTERVAL_MINUTES = 60;
export const MIN_WATCHER_SCAN_INTERVAL_MINUTES = 5;
export const MAX_WATCHER_SCAN_INTERVAL_MINUTES = 24 * 60;
export const WATCHER_SCAN_INTERVAL_PRESETS = [5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1_440] as const;

export class WatcherScanIntervalValidationError extends Error {
  constructor(message = "Interwał skanów Watchera musi być liczbą całkowitą od 5 do 1440 minut.") {
    super(message);
    this.name = "WatcherScanIntervalValidationError";
  }
}

export function parseWatcherScanInterval(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isInteger(numeric) || numeric < MIN_WATCHER_SCAN_INTERVAL_MINUTES || numeric > MAX_WATCHER_SCAN_INTERVAL_MINUTES) {
    throw new WatcherScanIntervalValidationError();
  }
  return numeric;
}

export function storedWatcherScanInterval(value: unknown): number {
  try { return parseWatcherScanInterval(value); }
  catch { return DEFAULT_WATCHER_SCAN_INTERVAL_MINUTES; }
}
