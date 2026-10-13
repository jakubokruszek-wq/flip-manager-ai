/**
 * Bearer check for the operator endpoints (/status, /run-once). Without a
 * configured token (>= 32 characters) the endpoints do not exist. Comparison
 * is done on SHA-256 digests so its duration does not depend on the input.
 */
export async function isAuthorizedAdmin(request: Request, configuredToken: string | undefined): Promise<boolean> {
  const expected = configuredToken?.trim() ?? "";
  if (expected.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;
  const [left, right] = await Promise.all([digest(expected), digest(presented)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
