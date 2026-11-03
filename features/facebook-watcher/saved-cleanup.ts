/** Strict instant boundary shared by preview and apply. Never falls back to clearing all. */
export function savedCutoff(value: unknown, now = Date.now()): string {
  if (typeof value !== "string") throw new Error("INVALID_SAVED_CUTOFF");
  const time=Date.parse(value);
  if (!Number.isFinite(time)||time<=0||time>now||new Date(time).toISOString()!==value) throw new Error("INVALID_SAVED_CUTOFF");
  return value;
}
export type SavedCleanupResult={before:string;token:string;total:number;protectedCount:number;listingIds:string[];applied:boolean};
