export class InvestmentDealVersionConflict extends Error {
  constructor() { super("INVESTMENT_DEAL_VERSION_CONFLICT"); this.name = "InvestmentDealVersionConflict"; }
}

export function isInvestmentDealVersionConflict(error: unknown): boolean {
  if (error instanceof InvestmentDealVersionConflict) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown };
  return value.message === "INVESTMENT_DEAL_VERSION_CONFLICT" || value.code === "INVESTMENT_DEAL_VERSION_CONFLICT";
}

export type VersionedDealCandidate<T> = {
  value: T;
  expectedVersion: number;
  sourceUpdatedAt: string | null;
  unchanged?: boolean;
};

export type StoredVersionedDeal<T> = { value: T; sourceUpdatedAt: string | null };

/**
 * Retries a versioned initializer after a database CAS miss. A same-input winner
 * is returned (the listing_id unique key makes initialization idempotent); if
 * source inputs changed meanwhile, the caller recomputes from a fresh snapshot.
 */
export async function initializeDealWithCas<T>(dependencies: {
  compute: () => Promise<VersionedDealCandidate<T>>;
  commit: (candidate: VersionedDealCandidate<T>) => Promise<number>;
  readCurrent: () => Promise<StoredVersionedDeal<T> | null>;
  maxAttempts?: number;
}): Promise<T> {
  const maxAttempts = dependencies.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = await dependencies.compute();
    if (candidate.unchanged) return candidate.value;
    try {
      await dependencies.commit(candidate);
      return candidate.value;
    } catch (error) {
      if (!isInvestmentDealVersionConflict(error)) throw error;
      const current = await dependencies.readCurrent();
      if (current && current.sourceUpdatedAt === candidate.sourceUpdatedAt) return current.value;
    }
  }
  throw new InvestmentDealVersionConflict();
}

/** Converts a zero-row database CAS result into an explicit stale-write conflict. */
export async function commitDealCas(commit: () => Promise<number | null>): Promise<number> {
  const nextVersion = await commit();
  if (nextVersion === null) throw new InvestmentDealVersionConflict();
  return nextVersion;
}
