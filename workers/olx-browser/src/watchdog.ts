/**
 * Detects a worker loop that stopped making progress (e.g. a hung browser or
 * socket the existing timeouts did not catch). Each loop step arms a budget;
 * if a budget expires, `onStall` runs — in production it exits the process so
 * the platform restarts the container and the job lease expires server-side.
 */
export function createStallWatchdog(options: {
  onStall(details: { step: string; budgetMs: number; overdueMs: number }): void;
  checkIntervalMs?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let armed: { step: string; budgetMs: number; deadline: number } | null = null;
  let fired = false;
  const timer = setInterval(() => check(), options.checkIntervalMs ?? 15_000);
  timer.unref();

  function check(): void {
    if (!armed || fired) return;
    const overdueMs = now() - armed.deadline;
    if (overdueMs <= 0) return;
    fired = true;
    options.onStall({ step: armed.step, budgetMs: armed.budgetMs, overdueMs });
  }

  return {
    arm(step: string, budgetMs: number): void {
      armed = { step, budgetMs, deadline: now() + budgetMs };
    },
    disarm(): void {
      armed = null;
    },
    check,
    stop(): void {
      clearInterval(timer);
      armed = null;
    },
  };
}

export type StallWatchdog = ReturnType<typeof createStallWatchdog>;
