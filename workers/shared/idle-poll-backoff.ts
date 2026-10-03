/**
 * Keeps an idle worker responsive to new jobs without polling Supabase at a
 * fixed rate forever when its queue is empty. A successful claim resets the
 * delay so a worker that has work continues to behave as before.
 */
export type IdlePollBackoff = {
  currentDelayMs(): number;
  recordEmptyClaim(): void;
  recordClaimWithJob(): void;
  recordRequestError(): void;
};

const DEFAULT_MAX_IDLE_DELAY_MS = 60_000;

export function createIdlePollBackoff(baseDelayMs: number, maxDelayMs = Math.max(DEFAULT_MAX_IDLE_DELAY_MS, baseDelayMs)): IdlePollBackoff {
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) throw new Error("baseDelayMs must be a positive integer");
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new Error("maxDelayMs must be an integer >= baseDelayMs");

  let delayMs = baseDelayMs;
  const increase = () => { delayMs = Math.min(maxDelayMs, delayMs * 2); };
  const reset = () => { delayMs = baseDelayMs; };
  return {
    currentDelayMs: () => delayMs,
    recordEmptyClaim: increase,
    recordClaimWithJob: reset,
    recordRequestError: increase,
  };
}
