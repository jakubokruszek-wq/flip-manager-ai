export const FACEBOOK_POST_PROCESSING_DEADLINE_MS = 20_000;
export const FACEBOOK_BOUNDED_PROCESSING_SOURCE_ID = "2928219830782023";
export const FACEBOOK_BOUNDED_PROCESSING_CONCURRENCY = 2;

export class FacebookPostProcessingDeadlineError extends Error {
  readonly postId: string;
  readonly deadlineMs: number;

  constructor(postId: string, deadlineMs: number) {
    super(`FACEBOOK_POST_PROCESSING_DEADLINE_EXCEEDED: post ${postId}, ${deadlineMs}ms`);
    this.name = "FacebookPostProcessingDeadlineError";
    this.postId = postId;
    this.deadlineMs = deadlineMs;
  }
}

export async function mapFacebookPostsWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  process: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("INVALID_FACEBOOK_POST_CONCURRENCY");
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await process(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

export function facebookPostDeadlineForSource(sourceUrl: string): number | null {
  try {
    return new URL(sourceUrl).pathname.includes(`/groups/${FACEBOOK_BOUNDED_PROCESSING_SOURCE_ID}`)
      ? FACEBOOK_POST_PROCESSING_DEADLINE_MS
      : null;
  } catch {
    return null;
  }
}

export async function runFacebookPostWithDeadline<T>(
  postId: string,
  operation: () => Promise<T>,
  onDeadline: () => Promise<void>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((reason: Error) => void) | undefined;
  let timedOut = false;
  const work = operation().catch((error) => {
    if (timedOut) throw new FacebookPostProcessingDeadlineError(postId, deadlineMs);
    throw error;
  });
  // Keep a rejection handler attached after Promise.race settles. Closing the
  // Playwright page aborts the underlying operation, which may reject later.
  void work.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      timedOut = true;
      void onDeadline().finally(() => rejectDeadline?.(new FacebookPostProcessingDeadlineError(postId, deadlineMs)));
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    rejectDeadline = undefined;
  }
}
