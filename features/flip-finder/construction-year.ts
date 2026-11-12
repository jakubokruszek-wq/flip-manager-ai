type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

/** Explicit construction facts only; publication and renovation dates are never building years. */
export function constructionYear(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1700 && value <= 2100 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^((?:17|18|19|20|21)\d{2})(?:\s*(?:r\.?|rok))?$/iu);
  return match ? constructionYear(Number(match[1])) : null;
}

export function constructionYearFromSource(value: unknown, description?: string | null): number | null {
  const years = new Set<number>();
  const add = (value: unknown) => { const year = constructionYear(value); if (year !== null) years.add(year); };
  if (record(value)) {
    const own = record(value.itemOffered) ? value.itemOffered : value;
    for (const item of new Set([value, own])) {
      for (const key of ["yearBuilt", "year_built", "constructionYear", "yearOfConstruction"]) add(item[key]);
      const properties = Array.isArray(item.additionalProperty) ? item.additionalProperty : [item.additionalProperty];
      for (const property of properties) if (record(property) && typeof property.name === "string"
        && /^(?:rok\s+budowy|year\s+built|construction\s+year)$/iu.test(property.name.trim())) add(property.value);
    }
  }
  if (years.size > 0) return years.size === 1 ? [...years][0] : null;
  for (const match of (description ?? "").matchAll(/(?:^|[\n;])\s*rok\s+budowy\s*[:–-]?\s*((?:17|18|19|20|21)\d{2})(?!\d)/giu)) add(match[1]);
  return years.size === 1 ? [...years][0] : null;
}
