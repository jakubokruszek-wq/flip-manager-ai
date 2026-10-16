/** Routing only, never authorization. Shared with the browser; no server configuration. */
export const isTestListingId=(id:string)=>id.toLowerCase().startsWith("deadbeef-");
export const investmentPath=(id:string)=>isTestListingId(id)?`/api/deal-room/test/${encodeURIComponent(id)}`:`/api/flip-finder/listings/${encodeURIComponent(id)}/investment`;
