import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { runManualOtodomScan, scanStatus, startManualOtodomScan } from "@/features/flip-finder/server/manual-scan";
import { scanStartErrorMessage } from "@/features/flip-finder/server/scan-start-errors";
import { runAfterResponse } from "@/features/facebook-watcher/run-after-response";
type Context = { params: Promise<{ id: string }> };
// Adapter work is scheduled after the 202 response, but the worker itself
// must finish inside Vercel Hobby's 60-second function ceiling.
export const maxDuration = 60;
export async function POST(_request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const filterId = (await params).id;
    const start = await startManualOtodomScan(filterId);
    if (!start.background) {
      const result = await runManualOtodomScan(filterId);
      return Response.json(result, { status: result.status === "running" ? 202 : 200 });
    }
    // The start response is deliberately independent from adapter duration.
    // The browser receives a run id immediately and polls the source_scans
    // rows that were reserved above, while Next/Vercel keeps the worker alive
    // through its request-scoped after()/waitUntil primitive.
    runAfterResponse(async () => {
      try {
        await runManualOtodomScan(filterId, { runId: start.runId, usePreparedRows: true, skipLock: true });
      } catch (error) {
        console.error("FLIP FINDER BACKGROUND SCAN FAILED:", { runId: start.runId, filterId, error });
      }
    });
    return Response.json(start, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nie udało się wykonać skanu.";
    return Response.json({ code: safeScanErrorCode(message), message: publicScanErrorMessage(message) }, { status: scanStatus(error) });
  }
}

function safeScanErrorCode(message: string): string {
  if (message === "COLLECTOR_OFFLINE") return message;
  if (message === "COLLECTOR_READINESS_UNAVAILABLE") return message;
  if (message === "Skan tego filtra już trwa.") return "SCAN_ALREADY_RUNNING";
  if (message === "Nie znaleziono filtra.") return "FILTER_NOT_FOUND";
  return "SCAN_START_FAILED";
}

function publicScanErrorMessage(message: string): string {
  return scanStartErrorMessage(message);
}
