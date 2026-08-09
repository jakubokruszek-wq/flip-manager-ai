import { listFacebookWatcher } from "@/features/facebook-watcher/server";
export async function GET() { try { return Response.json({ listings: await listFacebookWatcher() }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Nie udało się pobrać ofert." }, { status: 500 }); } }
