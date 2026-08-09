import { createWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";

export async function GET() { try { return Response.json({ groups: await listWatchedFacebookGroups() }); } catch (error) { return failure(error); } }
export async function POST(request: Request) { try { return Response.json({ group: await createWatchedFacebookGroup(await request.json()) }, { status: 201 }); } catch (error) { return failure(error, 400); } }
function failure(error: unknown, status = 500) { return Response.json({ error: error instanceof Error ? error.message : "Operacja grupy nie powiodła się." }, { status }); }
