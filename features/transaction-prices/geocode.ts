import points from './data/rcn-addresses.json' with { type: 'json' };
import { normalizeRcnLocation } from './model.ts';
type AddressPoint = { street: string; building: string; latitude: number; longitude: number };
export function locateRcnAddress(address: string): { latitude: number; longitude: number; label: string; precision: 'address' | 'street' } | null {
  const normalized = address.trim().replace(/^Łódź\s*[,;]?\s*/iu, '').replace(/[,;]?\s*Łódź$/iu, '').trim();
  const match = /^(.*?)\s+(\d+[a-zA-Z]?(?:[/-]\d+[a-zA-Z]?)?)$/.exec(normalized);
  const street = normalizeRcnLocation(match ? match[1] : normalized);
  const building = match?.[2].toLocaleLowerCase('pl');
  const addresses = (points.addresses as AddressPoint[]).filter(point => normalizeRcnLocation(point.street) === street && (!building || point.building.toLocaleLowerCase('pl') === building));
  if (!addresses.length) return null;
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return { latitude: median(addresses.map(point => point.latitude)), longitude: median(addresses.map(point => point.longitude)), label: `${addresses[0].street}${building ? ` ${addresses[0].building}` : ''}, Łódź`, precision: building ? 'address' : 'street' };
}
