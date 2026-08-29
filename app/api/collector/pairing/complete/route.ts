import { CollectorAuthError, registerCollectorDevice } from "@/features/collector/device-auth";
import { pairingCookieName, verifyPairingChallenge } from "@/features/collector/pairing";

export async function POST(request: Request) {
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${pairingCookieName()}=`))?.slice(pairingCookieName().length + 1) ?? null;
  try {
    const body = await request.json() as { challenge?: unknown; deviceName?: unknown; installationId?: unknown };
    if (typeof body.challenge !== "string" || !verifyPairingChallenge(cookie, body.challenge)) return Response.json({ message: "Nieprawidłowy lub wygasły challenge." }, { status: 401 });
    if (typeof body.deviceName !== "string" || !body.deviceName.trim() || typeof body.installationId !== "string" || !body.installationId.trim()) throw new CollectorAuthError(400, "Nazwa urządzenia i instalacja są wymagane.");
    const device = await registerCollectorDevice({ deviceName: body.deviceName.trim(), installationId: body.installationId.trim() });
    return Response.json({ deviceId: device.deviceId, deviceToken: device.token }, { status: 201, headers: { "Set-Cookie": `${pairingCookieName()}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  } catch (error) {
    const status = error instanceof CollectorAuthError ? error.status : 400;
    return Response.json({ message: error instanceof Error ? error.message : "Nie udało się sparować urządzenia." }, { status });
  }
}
