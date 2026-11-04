import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { listFacebookWatcher } from "@/features/facebook-watcher/server";
export const dynamic = "force-dynamic";
const headers={"Cache-Control":"private, no-store"};
export async function GET() {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  } try { return Response.json({ listings: await listFacebookWatcher() },{headers}); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Nie udało się pobrać ofert." }, { status: 500, headers }); } }
