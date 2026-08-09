import { authenticateCollectorDevice, CollectorAuthError, revokeCollectorDevice } from "@/features/collector/device-auth";

export async function GET(request: Request) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return Response.json({ message: "Brak tokenu urządzenia." }, { status: 401 });
  try {
    const device = await authenticateCollectorDevice(token);
    return Response.json({ connected: true, deviceId: device.id, deviceName: device.deviceName, lastUsedAt: device.lastUsedAt, revoked: false });
  } catch (error) {
    const status = error instanceof CollectorAuthError ? error.status : 500;
    return Response.json({ message: error instanceof Error ? error.message : "Nie udało się sprawdzić urządzenia." }, { status });
  }
}

export async function DELETE(request: Request) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return Response.json({ message: "Brak tokenu urządzenia." }, { status: 401 });
  }

  try {
    await revokeCollectorDevice(token);
    return new Response(null, { status: 204 });
  } catch (error) {
    const status = error instanceof CollectorAuthError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Nie udało się unieważnić tokenu.";
    return Response.json({ message }, { status });
  }
}

function bearerToken(value: string | null): string | null {
  const match = value ? /^Bearer\s+(.+)$/i.exec(value) : null;
  return match?.[1]?.trim() || null;
}
