import { distanceMeters, validCenter, type RcnCenter } from './geo.ts';
import type { RcnResaleResult } from './resales.ts';
import type { RcnSnapshot } from './snapshot-types.ts';
export type RcnNearbyResult = RcnResaleResult & { rows: Array<RcnResaleResult['rows'][number] & { distanceMeters: number }>; center: RcnCenter; importedAt: string; latestRegistryVersion: string };
export function nearbyResales(snapshot: RcnSnapshot, center: RcnCenter, now = new Date()): RcnNearbyResult {
  if (!validCenter(center)) throw new Error('INVALID_LOCATION_OR_RADIUS');
  const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const rows = snapshot.candidates.filter(row => row.strongSignal && row.sellDate >= cutoff.toISOString().slice(0, 10) && row.sellDate <= now.toISOString().slice(0, 10) && Number.isFinite(row.latitude) && Number.isFinite(row.longitude))
    .map(row => { const { latitude, longitude, district: _district, ...publicRow } = row; void _district; return { ...publicRow, distanceMeters: distanceMeters(center, { latitude, longitude }) }; })
    .filter(row => row.distanceMeters <= center.radiusMeters).sort((a, b) => a.distanceMeters - b.distanceMeters || b.sellDate.localeCompare(a.sellDate));
  return { status: rows.length ? 'ready' : 'no_candidates', source: { title: 'Rejestr Cen Nieruchomości — Łódź', url: snapshot.sourceUrl }, street: null, candidateCount: rows.length, strongCandidateCount: rows.length, rows: rows.slice(0, 100).map(row => ({ ...row, distanceMeters: Math.round(row.distanceMeters) })), fetchedAt: snapshot.importedAt, truncated: false, center, importedAt: snapshot.importedAt, latestRegistryVersion: snapshot.latestRegistryVersion };
}
