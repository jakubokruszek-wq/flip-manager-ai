// Read-only manual/CI probe of the same bounded municipal client used by the API.
// A source outage is reported; it must never manufacture comparables.
import { fetchRcnStreet } from '../features/transaction-prices/wfs.ts';
import { buildTransactionComparison } from '../features/transaction-prices/model.ts';
import { buildResaleCandidates } from '../features/transaction-prices/resales.ts';
const street = await fetchRcnStreet('Tatrzańska');
const result = buildTransactionComparison({ city: 'Łódź', street: 'Tatrzańska', area: 37.64, price: 260000 }, street.rows,
  { market: 'secondary', now: new Date(), fetchedAt: street.fetchedAt, truncated: street.truncated });
console.log(JSON.stringify({ status: result.status, street: result.street, sampleCount: result.sampleCount,
  medianPricePerM2: result.medianPricePerM2, fetchedAt: result.fetchedAt, truncated: result.truncated,
  source: result.source, returnedRows: street.rows.length }, null, 2));

const resales = buildResaleCandidates({ city: "Łódź", street: "Tatrzańska" }, street.rows, { now: new Date(), fetchedAt: street.fetchedAt, truncated: street.truncated });
console.log(JSON.stringify({ resaleStatus: resales.status, candidateCount: resales.candidateCount, strongCandidateCount: resales.strongCandidateCount, truncated: resales.truncated, examples: resales.rows.slice(0, 3) }, null, 2));
