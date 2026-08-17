export async function runFacebookJobCompletion<Result>(
  fetchResult: () => Promise<Result>,
  complete: (result: Result) => Promise<unknown>,
): Promise<Result> {
  const result = await fetchResult();
  await complete(result);
  return result;
}

export async function waitForFacebookTargetJob<Job>(input: {
  signal: AbortSignal;
  pollIntervalMs: number;
  claim: (signal: AbortSignal) => Promise<{ job: Job | null }>;
  wait?: (milliseconds: number) => Promise<void>;
  onEmpty?: () => void;
}): Promise<Job | null> {
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (!input.signal.aborted) {
    const { job } = await input.claim(input.signal);
    if (job) return job;
    input.onEmpty?.();
    await wait(input.pollIntervalMs);
  }
  return null;
}
