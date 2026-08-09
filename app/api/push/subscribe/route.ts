import { savePushSubscription } from "@/features/push/server";
export async function POST(request: Request) { try { return Response.json(await savePushSubscription(await request.json(), request.headers.get("user-agent")), { status: 201 }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Subskrypcja nie powiodła się." }, { status: 400 }); } }
