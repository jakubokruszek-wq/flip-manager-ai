import data from './data/rcn-snapshot.json' with { type: 'json' };
import type { RcnSnapshot } from './snapshot-types';
export function rcnSnapshot(): RcnSnapshot {
  const snapshot = data as RcnSnapshot;
  if (!snapshot.importedAt || snapshot.archiveCount < 4 || !snapshot.observationCount) throw new Error('RCN_DATASET_UNAVAILABLE');
  return snapshot;
}
