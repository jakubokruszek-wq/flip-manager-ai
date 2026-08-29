import { createPairingChallenge, pairingCookieName } from "@/features/collector/pairing";

export async function POST() {
  try {
    const { challenge, cookie, maxAge } = createPairingChallenge();
    return Response.json({ challenge, expiresIn: maxAge }, { headers: { "Set-Cookie": `${pairingCookieName()}=${cookie}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax` } });
  } catch {
    return Response.json({ message: "Parowanie urządzenia nie jest jeszcze skonfigurowane." }, { status: 503 });
  }
}
