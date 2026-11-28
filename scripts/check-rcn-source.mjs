// Read-only manual/CI probe of the same bounded municipal client used by the API.
// A source outage is reported; it must never manufacture comparables.
import { fetchRcnStreet } from '../features/transaction-prices/wfs.ts';
import { buildTransactionComparison } from '../features/transaction-prices/model.ts';
const street = await fetchRcnStreet('Tatrzańska');
const result = buildTransactionComparison({ city: 'Łódź', street: 'Tatrzańska', area: 37.64, price: 260000 }, street.rows,
  { market: 'secondary', now: new Date(), fetchedAt: street.fetchedAt, truncated: street.truncated });
console.log(JSON.stringify({ status: result.status, street: result.street, sampleCount: result.sampleCount,
  medianPricePerM2: result.medianPricePerM2, fetchedAt: result.fetchedAt, truncated: result.truncated,
  source: result.source, returnedRows: street.rows.length }, null, 2));
