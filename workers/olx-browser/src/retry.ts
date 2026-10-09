export async function withTransientRetry<T>(operation: (attempt: number) => Promise<T>, retries = 1, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      lastError = error;
      if (error instanceof ControlledOlxFailure || attempt > retries) throw error;
      await delay(attempt * 2_000, signal);
    }
  }
  throw lastError;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ControlledOlxFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlledOlxFailure";
    this.code = code;
  }
}
