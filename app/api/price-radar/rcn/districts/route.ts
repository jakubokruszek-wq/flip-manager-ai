import { operatorAuthorizationResponse, requireOperator } from '@/features/auth/operator';
import { districtSummary, RCN_AREA_BANDS, type RcnAreaBand } from '@/features/transaction-prices/districts';
import { rcnSnapshot } from '@/features/transaction-prices/snapshot';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  const area = new URL(request.url).searchParams.get('area') ?? 'all';
  if (!RCN_AREA_BANDS.includes(area as RcnAreaBand)) return Response.json({ message: 'Wybierz przedział metrażu.' }, { status: 400, headers });
  try { return Response.json(districtSummary(rcnSnapshot(), area as RcnAreaBand), { headers }); }
  catch { return Response.json({ message: 'Podsumowania RCN są chwilowo niedostępne.' }, { status: 503, headers }); }
}
