export type RcnCenter = { latitude: number; longitude: number; radiusMeters: number };
export function validCenter(center: RcnCenter): boolean {
  return Number.isFinite(center.latitude) && Number.isFinite(center.longitude) && center.latitude >= 51.55 && center.latitude <= 51.95 && center.longitude >= 19.1 && center.longitude <= 19.8 && Number.isInteger(center.radiusMeters) && center.radiusMeters >= 250 && center.radiusMeters <= 10000;
}
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180; const dlat = (b.latitude - a.latitude) * rad; const dlon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}
export function pointInRing(longitude: number, latitude: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > latitude) !== (yj > latitude) && longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInPolygon(longitude: number, latitude: number, rings: number[][][]): boolean {
  return !!rings.length && pointInRing(longitude, latitude, rings[0]) && !rings.slice(1).some(ring => pointInRing(longitude, latitude, ring));
}
