import { timingSafeEqual } from "node:crypto";

import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  if (!isAuthorized(request)) {
    return Response.json({ message: "Brak uprawnień do przeliczenia filtra." }, { status: 401 });
  }

  try {
    const result = await recalculateFilterMatches((await params).id);

    return result
      ? Response.json(result)
      : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });
  } catch (error) {
    console.error("FLIP FINDER RECALCULATE ERROR:", error);
    return Response.json({ message: "Nie udało się przeliczyć wyników filtra." }, { status: 500 });
  }
}

function isAuthorized(request: Request): boolean {
  const configuredSecret = process.env.FLIP_FINDER_RECALCULATE_SECRET;
  const suppliedSecret = request.headers.get("x-flip-finder-recalculate-secret");

  if (!configuredSecret || !suppliedSecret) {
    return false;
  }

  const expected = Buffer.from(configuredSecret);
  const received = Buffer.from(suppliedSecret);

  return expected.length === received.length && timingSafeEqual(expected, received);
}
