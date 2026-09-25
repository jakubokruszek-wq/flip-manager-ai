import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { disablePushSubscription } from "@/features/push/server";
export async function DELETE(request: Request) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  } try { const body = await request.json(); if (typeof body.endpoint !== "string") throw new Error("Brak endpointu subskrypcji."); await disablePushSubscription(body.endpoint); return Response.json({ ok: true }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Wyłączenie nie powiodło się." }, { status: 400 }); } }
