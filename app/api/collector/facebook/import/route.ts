import { authenticateCollectorDevice, CollectorAuthError } from "@/features/collector/device-auth";
import { importFacebookCollectorPayload } from "@/features/collector/facebook-import";

export async function POST(request: Request) {
  const token = bearerToken(request.headers.get("authorization"));
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();

  if (!token) {
    return Response.json({ message: "Brak tokenu urządzenia." }, { status: 401 });
  }

  if (!idempotencyKey || idempotencyKey.length > 256) {
    return Response.json({ message: "Brak poprawnego klucza idempotencji." }, { status: 400 });
  }

  try {
    const device = await authenticateCollectorDevice(token);
    const result = await importFacebookCollectorPayload(
      device.id,
      idempotencyKey,
      await request.json(),
    );

    return Response.json(result, { status: result.status === "created" ? 201 : 200 });
  } catch (error) {
    const status = error instanceof CollectorAuthError ? error.status : 400;
    const message = error instanceof Error ? error.message : "Nie udało się zaimportować posta Facebooka.";
    console.error("COLLECTOR FACEBOOK IMPORT ERROR:", error instanceof Error ? error.message : error);
    return Response.json({ message }, { status });
  }
}

function bearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() || null;
}
