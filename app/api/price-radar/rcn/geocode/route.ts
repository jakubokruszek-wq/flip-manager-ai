import { operatorAuthorizationResponse, requireOperator } from '@/features/auth/operator';
import { locateRcnAddress } from '@/features/transaction-prices/geocode';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  const address = (new URL(request.url).searchParams.get('address') ?? '').trim();
  if (address.length < 2 || address.length > 200 || /[\p{Cc}<>*?]/u.test(address)) return Response.json({ message: 'Podaj ulicę lub adres w Łodzi.' }, { status: 400, headers });
  const point = locateRcnAddress(address);
  if (!point) return Response.json({ message: 'Nie znaleziono punktu dla tego adresu w zbiorze RCN. Spróbuj samej nazwy ulicy albo lokalizacji telefonu.' }, { status: 404, headers });
  return Response.json(point, { headers });
}
