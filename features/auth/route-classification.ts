export const ROUTE_AUTH_CLASSES = [
  "PUBLIC_READ",
  "HUMAN_OPERATOR",
  "SIGNED_EXTENSION",
  "SIGNED_WORKER",
  "CRON_SECRET",
  "OPERATOR_SECRET",
] as const;

export type RouteAuthClass = (typeof ROUTE_AUTH_CLASSES)[number];
export type MutationMethod = "POST" | "PATCH" | "PUT" | "DELETE";

export type ClassifiedMutationRoute = Readonly<{
  method: MutationMethod;
  pattern: RegExp;
  template: string;
  auth: Exclude<RouteAuthClass, "PUBLIC_READ">;
}>;

function routes(auth: ClassifiedMutationRoute["auth"], definitions: Array<[MutationMethod, string, RegExp]>): ClassifiedMutationRoute[] {
  return definitions.map(([method, template, pattern]) => ({ method, template, pattern, auth }));
}

export const CLASSIFIED_MUTATION_ROUTES: readonly ClassifiedMutationRoute[] = [
  ...routes("SIGNED_EXTENSION", [
    ["POST", "/api/collector/devices/register", /^\/api\/collector\/devices\/register$/],
    ["DELETE", "/api/collector/devices/current", /^\/api\/collector\/devices\/current$/],
    ["POST", "/api/collector/heartbeat", /^\/api\/collector\/heartbeat$/],
    ["POST", "/api/collector/jobs/claim", /^\/api\/collector\/jobs\/claim$/],
    ["POST", "/api/collector/jobs/complete", /^\/api\/collector\/jobs\/complete$/],
    ["POST", "/api/collector/jobs/heartbeat", /^\/api\/collector\/jobs\/heartbeat$/],
    ["POST", "/api/collector/facebook/batches", /^\/api\/collector\/facebook\/batches$/],
    ["POST", "/api/collector/facebook/import", /^\/api\/collector\/facebook\/import$/],
    ["POST", "/api/collector/facebook/scans/[scanId]/fail", /^\/api\/collector\/facebook\/scans\/[^/]+\/fail$/],
    ["POST", "/api/collector/pairing/challenge", /^\/api\/collector\/pairing\/challenge$/],
    ["POST", "/api/collector/pairing/complete", /^\/api\/collector\/pairing\/complete$/],
    ["POST", "/api/collector/readiness", /^\/api\/collector\/readiness$/],
    ["POST", "/api/facebook-watcher/groups/discover", /^\/api\/facebook-watcher\/groups\/discover$/],
  ]),
  ...routes("SIGNED_WORKER", [
    ["POST", "/api/facebook-worker/claim", /^\/api\/facebook-worker\/claim$/],
    ["POST", "/api/facebook-worker/complete", /^\/api\/facebook-worker\/complete$/],
    ["POST", "/api/facebook-worker/fail", /^\/api\/facebook-worker\/fail$/],
    ["POST", "/api/facebook-worker/heartbeat", /^\/api\/facebook-worker\/heartbeat$/],
    ["POST", "/api/facebook-worker/image-revalidation/list", /^\/api\/facebook-worker\/image-revalidation\/list$/],
    ["POST", "/api/facebook-worker/image-revalidation/persist", /^\/api\/facebook-worker\/image-revalidation\/persist$/],
    ["POST", "/api/facebook-worker/image-revalidation/vision", /^\/api\/facebook-worker\/image-revalidation\/vision$/],
    ["POST", "/api/facebook-worker/post-cache", /^\/api\/facebook-worker\/post-cache$/],
    ["POST", "/api/facebook-worker/vision", /^\/api\/facebook-worker\/vision$/],
    ["POST", "/api/olx-worker/claim", /^\/api\/olx-worker\/claim$/],
    ["POST", "/api/olx-worker/complete", /^\/api\/olx-worker\/complete$/],
    ["POST", "/api/olx-worker/fail", /^\/api\/olx-worker\/fail$/],
    ["POST", "/api/olx-worker/heartbeat", /^\/api\/olx-worker\/heartbeat$/],
  ]),
  ...routes("CRON_SECRET", [
    ["POST", "/api/jobs/facebook-watch", /^\/api\/jobs\/facebook-watch$/],
    ["POST", "/api/jobs/listing-lifecycle", /^\/api\/jobs\/listing-lifecycle$/],
  ]),
  ...routes("OPERATOR_SECRET", [
    ["POST", "/api/facebook-watcher/orphans", /^\/api\/facebook-watcher\/orphans$/],
  ]),
  ...routes("HUMAN_OPERATOR", [
    ["PATCH", "/api/alerts/[id]", /^\/api\/alerts\/[^/]+$/],
    ["POST", "/api/facebook-watcher/groups", /^\/api\/facebook-watcher\/groups$/],
    ["PATCH", "/api/facebook-watcher/groups/[id]", /^\/api\/facebook-watcher\/groups\/[^/]+$/],
    ["DELETE", "/api/facebook-watcher/groups/[id]", /^\/api\/facebook-watcher\/groups\/[^/]+$/],
    ["POST", "/api/facebook-watcher/groups/discover/preview", /^\/api\/facebook-watcher\/groups\/discover\/preview$/],
    ["POST", "/api/facebook-watcher/groups/import", /^\/api\/facebook-watcher\/groups\/import$/],
    ["DELETE", "/api/facebook-watcher/history", /^\/api\/facebook-watcher\/history$/],
    ["POST", "/api/facebook-watcher/images", /^\/api\/facebook-watcher\/images$/],
    ["POST", "/api/facebook-watcher/import", /^\/api\/facebook-watcher\/import$/],
    ["PATCH", "/api/facebook-watcher/listings/[listingId]", /^\/api\/facebook-watcher\/listings\/[^/]+$/],
    ["POST", "/api/facebook-watcher/listings/[listingId]/gallery-repair", /^\/api\/facebook-watcher\/listings\/[^/]+\/gallery-repair$/],
    ["POST", "/api/facebook-watcher/listings/[listingId]/restore", /^\/api\/facebook-watcher\/listings\/[^/]+\/restore$/],
    ["DELETE", "/api/flip-finder/history", /^\/api\/flip-finder\/history$/],
    ["POST", "/api/flip-finder/investment/market-assumptions", /^\/api\/flip-finder\/investment\/market-assumptions$/],
    ["PUT", "/api/flip-finder/investment/settings", /^\/api\/flip-finder\/investment\/settings$/],
    ["POST", "/api/flip-finder/listings/[id]/gallery", /^\/api\/flip-finder\/listings\/[^/]+\/gallery$/],
    ["POST", "/api/flip-finder/listings/[id]/gallery/trace", /^\/api\/flip-finder\/listings\/[^/]+\/gallery\/trace$/],
    ["POST", "/api/flip-finder/listings/[id]/investment/initialize", /^\/api\/flip-finder\/listings\/[^/]+\/investment\/initialize$/],
    ["PUT", "/api/flip-finder/listings/[id]/investment", /^\/api\/flip-finder\/listings\/[^/]+\/investment$/],
    ["POST", "/api/flip-finder/listings/[id]/review", /^\/api\/flip-finder\/listings\/[^/]+\/review$/],
    ["POST", "/api/flip-finder/scans/[runId]/cancel", /^\/api\/flip-finder\/scans\/[^/]+\/cancel$/],
    ["POST", "/api/flip-finder/search-filters", /^\/api\/flip-finder\/search-filters$/],
    ["PATCH", "/api/flip-finder/search-filters/[id]", /^\/api\/flip-finder\/search-filters\/[^/]+$/],
    ["DELETE", "/api/flip-finder/search-filters/[id]", /^\/api\/flip-finder\/search-filters\/[^/]+$/],
    ["POST", "/api/flip-finder/search-filters/[id]/clear-results", /^\/api\/flip-finder\/search-filters\/[^/]+\/clear-results$/],
    ["POST", "/api/flip-finder/search-filters/[id]/duplicate", /^\/api\/flip-finder\/search-filters\/[^/]+\/duplicate$/],
    ["POST", "/api/flip-finder/search-filters/[id]/recalculate", /^\/api\/flip-finder\/search-filters\/[^/]+\/recalculate$/],
    ["POST", "/api/flip-finder/search-filters/[id]/scan", /^\/api\/flip-finder\/search-filters\/[^/]+\/scan$/],
    ["POST", "/api/flip-finder/search-filters/[id]/toggle", /^\/api\/flip-finder\/search-filters\/[^/]+\/toggle$/],
    ["POST", "/api/import", /^\/api\/import$/],
    ["POST", "/api/properties", /^\/api\/properties$/],
    ["PATCH", "/api/properties/[id]", /^\/api\/properties\/[^/]+$/],
    ["DELETE", "/api/properties/[id]", /^\/api\/properties\/[^/]+$/],
    ["POST", "/api/properties/import-from-finder", /^\/api\/properties\/import-from-finder$/],
    ["POST", "/api/push/subscribe", /^\/api\/push\/subscribe$/],
    ["DELETE", "/api/push/unsubscribe", /^\/api\/push\/unsubscribe$/],
    ["POST", "/api/push/test", /^\/api\/push\/test$/],
    ["POST", "/api/renovation-visualizer/generate", /^\/api\/renovation-visualizer\/generate$/],
    ["POST", "/api/renovation-visualizer", /^\/api\/renovation-visualizer$/],
  ]),
];

export function classifyMutationRoute(method: string, pathname: string): RouteAuthClass | null {
  return CLASSIFIED_MUTATION_ROUTES.find((route) => route.method === method && route.pattern.test(pathname))?.auth ?? null;
}
