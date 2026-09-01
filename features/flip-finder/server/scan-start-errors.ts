export function scanStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
}
