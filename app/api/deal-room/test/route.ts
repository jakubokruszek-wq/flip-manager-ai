import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { testCases, testModeAllowed } from "@/features/investment-os/test-mode";
import { prepareTestCases } from "@/features/investment-os/server/test-mode-service";
export async function GET() {
  try {
    const actor = await requireOperator();
    if (!testModeAllowed(actor.id)) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    return Response.json({ cases: testCases(actor.id) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return operatorAuthorizationResponse(error); }
}
export async function POST(request: Request) {
  let actor;
  try { actor = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  if (!testModeAllowed(actor.id)) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ code: "ORIGIN_MISMATCH" }, { status: 403 });
  try { return Response.json({ cases: await prepareTestCases(actor.id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch { return Response.json({ code: "TEST_PREPARATION_FAILED" }, { status: 503 }); }
}
