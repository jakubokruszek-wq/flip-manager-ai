export async function withTransientRetry<T>(operation: (attempt: number) => Promise<T>, retries = 1): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (error instanceof ControlledOlxFailure || attempt > retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

export class ControlledOlxFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlledOlxFailure";
    this.code = code;
  }
}
