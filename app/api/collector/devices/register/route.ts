import { timingSafeEqual } from "node:crypto";

import { CollectorAuthError, registerCollectorDevice } from "@/features/collector/device-auth";

export async function POST(request: Request) {
  const pairingSecret = process.env.FLIP_COLLECTOR_PAIRING_SECRET;
  const providedSecret = request.headers.get("x-flip-collector-pairing-secret");

  if (!pairingSecret) {
    console.error("COLLECTOR PAIRING CONFIG ERROR: FLIP_COLLECTOR_PAIRING_SECRET is missing.");
    return Response.json({ message: "Parowanie urządzenia nie jest jeszcze skonfigurowane." }, { status: 503 });
  }

  if (!providedSecret || !secureEquals(pairingSecret, providedSecret)) {
    return Response.json({ message: "Nieprawidłowy sekret parowania." }, { status: 401 });
  }

  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      throw new CollectorAuthError(400, "Nieprawidłowe dane urządzenia.");
    }

    const deviceName = requiredText(body.deviceName, "Nazwa urządzenia");
    const installationId = requiredText(body.installationId, "Identyfikator instalacji");
    const device = await registerCollectorDevice({ deviceName, installationId });

    return Response.json(
      { deviceId: device.deviceId, deviceToken: device.token },
      { status: 201 },
    );
  } catch (error) {
    const status = error instanceof CollectorAuthError ? error.status : 400;
    const message = error instanceof Error ? error.message : "Nie udało się sparować urządzenia.";
    return Response.json({ message }, { status });
  }
}

function secureEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CollectorAuthError(400, `${field} jest wymagana.`);
  }

  return value.trim();
}
