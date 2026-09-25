import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { runManualOtodomScan, scanStatus } from "@/features/flip-finder/server/manual-scan";
import { scanStartErrorMessage } from "@/features/flip-finder/server/scan-start-errors";
type Context = { params: Promise<{ id: string }> };
export async function POST(_request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  } try { const result = await runManualOtodomScan((await params).id); return Response.json(result, { status: result.status === "running" ? 202 : 200 }); } catch (error) { const message = error instanceof Error ? error.message : "Nie udało się wykonać skanu."; return Response.json({ code: safeScanErrorCode(message), message: publicScanErrorMessage(message) }, { status: scanStatus(error) }); } }

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
