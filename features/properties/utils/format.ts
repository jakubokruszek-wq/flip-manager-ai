function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatCurrency(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return "—";
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return "—";
  return new Intl.NumberFormat("pl-PL", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value / 100);
}

export function formatFlipScore(value: number | null | undefined): string {
  return isFiniteNumber(value) ? value.toFixed(1) : "—";
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}
