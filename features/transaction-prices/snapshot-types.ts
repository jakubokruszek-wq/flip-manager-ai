import type { RcnResaleCandidate } from './resales';
export type StoredRcnCandidate = RcnResaleCandidate & { latitude: number; longitude: number; district: string | null };
export type RcnSnapshot = {
  schemaVersion: 1; importedAt: string; latestRegistryVersion: string; sourceUrl: string; boundarySourceUrl: string;
  archiveCount: number; observationCount: number; locatedCandidateCount: number; unlocatedCandidateCount: number;
  candidates: StoredRcnCandidate[];
};
