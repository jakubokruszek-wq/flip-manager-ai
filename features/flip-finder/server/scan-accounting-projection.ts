import { mergeFacebookScanAccounting, parseFacebookScanAccounting, type FacebookScanAccounting } from "../../facebook-worker/scan-accounting.ts";

export type PersistedFacebookAccountingProjection = {
  accounting: FacebookScanAccounting | null;
  accountingMode: "AUTHORITATIVE" | "LEGACY";
  accountingError: "FACEBOOK_ACCOUNTING_INVARIANT_FAILED" | null;
};

/** Read-side contract for collector_scan_batches.result.accounting. */
export function projectPersistedFacebookAccounting(results: unknown[]): PersistedFacebookAccountingProjection {
  const errors = results.filter((result) => isRecord(result) && result.accountingError === "FACEBOOK_ACCOUNTING_INVARIANT_FAILED");
  const accountings = results.map((result) => isRecord(result) ? parseFacebookScanAccounting(result.accounting) : null).filter((value): value is FacebookScanAccounting => value !== null);
  if (results.length > 0 && errors.length === 0 && accountings.length === results.length) return { accounting: mergeFacebookScanAccounting(accountings), accountingMode: "AUTHORITATIVE", accountingError: null };
  return { accounting: null, accountingMode: "LEGACY", accountingError: errors.length > 0 ? "FACEBOOK_ACCOUNTING_INVARIANT_FAILED" : null };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
