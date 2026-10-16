import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { dealRoomEnabled, DealRoomNotFound, readDealRoom, saveDealRoomAnswers } from "@/features/investment-os/server/deal-room-service";
import { DealRoomInputError } from "@/features/investment-os/deal-room-answers";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> { return handle(null, context); }
export async function POST(request: Request, context: Context): Promise<Response> { return handle(request, context); }
async function handle(request: Request | null, { params }: Context): Promise<Response> {
  let actor;
  try { actor = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  if (!dealRoomEnabled()) return Response.json({ enabled: false }, { status: request ? 404 : 200 });
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (!request) { const room = await readDealRoom(id, actor.id); return room ? Response.json({ enabled: true, room }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ code: "NOT_FOUND" }, { status: 404 }); }
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ code: "ORIGIN_MISMATCH" }, { status: 403 });
    if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ code: "JSON_REQUIRED" }, { status: 415 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 24_000) return Response.json({ code: "PAYLOAD_TOO_LARGE" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new DealRoomInputError("Nieprawidłowy JSON."); }
    return Response.json(await saveDealRoomAnswers(id, actor.id, body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DealRoomInputError) return Response.json({ message: error.message }, { status: 400 });
    if (error instanceof DealRoomNotFound) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    if (isInvestmentDealVersionConflict(error)) return Response.json({ code: "INVESTMENT_DEAL_VERSION_CONFLICT", message: "Analiza zmieniła się. Odśwież ją przed zapisem; szkic zachowano." }, { status: 409 });
    // Never log answer bodies, evidence URLs or database exception details.
    return Response.json({ code: "DEAL_ROOM_UNAVAILABLE", message: "Nie udało się zapisać rundy. Ponów ten sam zapis." }, { status: 503 });
  }
}
