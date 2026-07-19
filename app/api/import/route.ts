import { importProperty } from "@/features/importer/server";

export async function POST(request: Request) {
  try {
    const { url } = await request.json();

    if (typeof url !== "string") {
      return Response.json(
        { error: "Adres ogłoszenia jest wymagany." },
        { status: 400 }
      );
    }

    const property = await importProperty(url);

    return Response.json(property);
  } catch (error) {
    console.error("IMPORT ERROR:", error);

    return Response.json(
      {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        code: (error as any)?.code ?? null,
      },
      { status: 500 }
    );
  }
}
