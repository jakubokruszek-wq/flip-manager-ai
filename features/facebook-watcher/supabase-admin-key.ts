export function resolveSupabaseAdminKey(secretKey: string | undefined, legacyKey: string | undefined): string | null {
  const secret = secretKey?.trim();
  if (secret && isUsableSecretKey(secret)) return secret;
  const legacy = legacyKey?.trim();
  return legacy && isLegacyServiceRoleKey(legacy) ? legacy : null;
}

export function isUsableSecretKey(value: string): boolean {
  return value.startsWith("sb_secret_") && value.length >= 30;
}

function isLegacyServiceRoleKey(value: string): boolean {
  return value.length >= 100 && value.split(".").length === 3;
}
