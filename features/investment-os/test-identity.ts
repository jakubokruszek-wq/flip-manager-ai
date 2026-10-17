/** Legacy synthetic IDs are permanently excluded from real Deal Room routes. No TEST activation flags. */
export const isTestListingId=(id:string)=>id.toLowerCase().startsWith("deadbeef-");
export function testListingAllowed(id:string,actorId:string):boolean {void actorId;return !isTestListingId(id);}
export const investmentPath=(id:string)=>`/api/flip-finder/listings/${encodeURIComponent(id)}/investment`;
