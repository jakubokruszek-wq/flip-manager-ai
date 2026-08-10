import { runManualOtodomScan, scanStatus } from "@/features/flip-finder/server/manual-scan";
type Context = { params: Promise<{ id: string }> };
export async function POST(_request: Request, { params }: Context) { try { const result = await runManualOtodomScan((await params).id); return Response.json(result, { status: result.status === "running" ? 202 : 200 }); } catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nie udało się wykonać skanu." }, { status: scanStatus(error) }); } }
