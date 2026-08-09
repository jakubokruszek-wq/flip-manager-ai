import { sendPushToAll, testPayload } from "@/features/push/server";
export const runtime = "nodejs";
export async function POST() { try { return Response.json(await sendPushToAll(testPayload())); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Test Web Push nie powiódł się." }, { status: 503 }); } }
