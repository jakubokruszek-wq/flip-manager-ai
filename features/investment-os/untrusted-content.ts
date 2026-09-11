import { fingerprint } from "./engine.ts";

export type UntrustedContent = { kind: "UNTRUSTED_DATA"; source: string; content: string; contentHash: string; instructionsAreData: true };
export function asUntrustedContent(source: string, content: string): UntrustedContent {
  if (!source.trim()) throw new Error("UNTRUSTED_SOURCE_REQUIRED");
  const bounded = content.slice(0, 100_000);
  return { kind: "UNTRUSTED_DATA", source: source.slice(0, 200), content: bounded, contentHash: fingerprint({ source, content: bounded }), instructionsAreData: true };
}
