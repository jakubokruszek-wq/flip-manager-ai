import { importProperty } from "@/features/importer/server";
import { extractFacebookProperty } from "@/features/facebook-watcher/extract-facebook-property";
import { normalizeFacebookUrl } from "@/features/facebook-watcher/normalize-facebook-listing";
import { analyzeFacebookImages } from "@/features/facebook-watcher/analyze-facebook-images";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url } = body;

    if (typeof url !== "string") {
      return Response.json(
        { error: "Adres ogłoszenia jest wymagany." },
        { status: 400 }
      );
    }

    const facebookUrl = normalizeFacebookUrl(url);
    if (facebookUrl) {
      const postText = typeof body.postText === "string" ? body.postText.trim() : "";
      const images = Array.isArray(body.images) ? body.images.filter((value: unknown): value is string => typeof value === "string") : [];
      if (!postText && images.length === 0) {
        return Response.json({ code: "FACEBOOK_CONTENT_REQUIRED", normalizedUrl: facebookUrl, message: "Facebook nie udostępnił treści tego ogłoszenia." });
      }
      const vision = images.length ? await analyzeFacebookImages(images, postText) : null;
      const combinedText = [postText, vision?.visibleText].filter(Boolean).join("\n");
      const base = await extractFacebookProperty({ url: facebookUrl, postText: combinedText, publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : undefined, images });
      const extracted = vision ? { ...base, city: base.city ?? vision.city, district: base.district ?? vision.district, neighborhood: base.neighborhood ?? vision.neighborhood, street: base.street ?? vision.street, price: base.price ?? vision.price, area: base.area ?? vision.area, rooms: base.rooms ?? vision.rooms, floor: base.floor ?? vision.floor, totalFloors: base.totalFloors ?? vision.totalFloors, condition: base.condition ?? vision.condition, sellerType: base.sellerType ?? vision.sellerType, confidence: Math.max(base.confidence, vision.confidence) } : base;
      return Response.json({ source: "facebook", title: extracted.title, price: extracted.price, area: extracted.area, rooms: extracted.rooms, floor: extracted.floor === null ? null : String(extracted.floor), buildingType: null, ownership: null, rent: null, address: extracted.street ?? extracted.neighborhood ?? extracted.district, district: extracted.district, city: extracted.city, description: extracted.description, images: extracted.images, originalUrl: facebookUrl, facebookMeta: { neighborhood: extracted.neighborhood, totalFloors: extracted.totalFloors, marketType: extracted.marketType, condition: extracted.condition, sellerType: extracted.sellerType, publishedAt: body.publishedAt ?? null, confidence: extracted.confidence, flags: extracted.flags } });
    }

    const property = await importProperty(url);

    return Response.json(property);
  } catch (error) {
    console.error("IMPORT ERROR:", error);

    return Response.json(
      {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
        code: error && typeof error === "object" && "code" in error ? error.code ?? null : null,
      },
      { status: 500 }
    );
  }
}
