import { operatorAuthorizationResponse, requireOperator } from '@/features/auth/operator';
import { validCenter } from '@/features/transaction-prices/geo';
import { nearbyResales } from '@/features/transaction-prices/nearby';
import { rcnSnapshot } from '@/features/transaction-prices/snapshot';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  const params = new URL(request.url).searchParams;
  const center = { latitude: Number(params.get('latitude') ?? NaN), longitude: Number(params.get('longitude') ?? NaN), radiusMeters: Number(params.get('radius') ?? NaN) };
  if (!validCenter(center)) return Response.json({ message: 'Wybierz punkt w Łodzi i promień od 250 do 10000 m.' }, { status: 400, headers });
  try { return Response.json(nearbyResales(rcnSnapshot(), center), { headers }); }
  catch { return Response.json({ message: 'Zbiór transakcji RCN jest chwilowo niedostępny.' }, { status: 503, headers }); }
}
