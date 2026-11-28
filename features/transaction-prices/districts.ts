import type { RcnSnapshot, StoredRcnCandidate } from './snapshot-types.ts';
export const RCN_DISTRICTS = ['Bałuty', 'Górna', 'Polesie', 'Śródmieście', 'Widzew'] as const;
export const RCN_AREA_BANDS = ['all', 'small', 'medium', 'large', 'extra'] as const;
export type RcnAreaBand = typeof RCN_AREA_BANDS[number];
export function inAreaBand(area: number, band: RcnAreaBand): boolean {
  return band === 'all' || (band === 'small' ? area < 35 : band === 'medium' ? area >= 35 && area < 50 : band === 'large' ? area >= 50 && area < 70 : area >= 70);
}
function median(values: number[]): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; }
function mean(values: number[]): number | null { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
export function districtSummary(snapshot: RcnSnapshot, band: RcnAreaBand = 'all', now = new Date()) {
  const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const candidates = snapshot.candidates.filter(row => row.strongSignal && row.buyMarket === 'secondary' && row.sellMarket === 'secondary' && row.sellDate >= cutoff.toISOString().slice(0, 10) && row.sellDate <= now.toISOString().slice(0, 10) && inAreaBand(row.area, band));
  return { importedAt: snapshot.importedAt, latestRegistryVersion: snapshot.latestRegistryVersion, sourceUrl: snapshot.sourceUrl, boundarySourceUrl: snapshot.boundarySourceUrl, archiveCount: snapshot.archiveCount, observationCount: snapshot.observationCount, unlocatedCandidateCount: snapshot.unlocatedCandidateCount, areaBand: band,
    districts: RCN_DISTRICTS.map(district => {
      const rows = candidates.filter(row => row.district === district); const enough = rows.length >= 5;
      const stat = (field: keyof Pick<StoredRcnCandidate, 'buyPricePerM2' | 'sellPricePerM2' | 'approxMonths' | 'priceIncreasePct'>) => enough ? median(rows.map(row => row[field])) : null;
      return { district, count: rows.length, smallSample: !enough, medianBuyPerM2: stat('buyPricePerM2'), medianSellPerM2: stat('sellPricePerM2'), averageBuyPerM2: enough ? mean(rows.map(row => row.buyPricePerM2)) : null, averageSellPerM2: enough ? mean(rows.map(row => row.sellPricePerM2)) : null, medianMonths: stat('approxMonths'), medianIncreasePct: stat('priceIncreasePct'), examples: rows.slice(0, 20) };
    }) };
}
export type RcnDistrictSummary = ReturnType<typeof districtSummary>;
