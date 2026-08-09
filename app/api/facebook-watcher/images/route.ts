import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { ensureFacebookImageBucket, FACEBOOK_IMAGE_BUCKET } from "@/features/facebook-watcher/server/facebook-image-storage";

const MAX_SIZE = 8 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("images").filter((value): value is File => value instanceof File);
    if (!files.length) return Response.json({ error: "Dodaj co najmniej jedno zdjęcie." }, { status: 400 });
    if (files.length > 12) return Response.json({ error: "Możesz dodać maksymalnie 12 zdjęć." }, { status: 400 });
    for (const file of files) if (!ALLOWED.has(file.type) || file.size > MAX_SIZE) return Response.json({ error: "Obsługiwane są JPG, PNG i WebP do 8 MB." }, { status: 400 });
    const supabase = createFacebookWatcherAdminClient();
    await ensureFacebookImageBucket(supabase);
    const urls: string[] = [];
    for (const file of files) {
      const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
      const uploaded = await supabase.storage.from(FACEBOOK_IMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (uploaded.error) throw uploaded.error;
      urls.push(supabase.storage.from(FACEBOOK_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl);
    }
    return Response.json({ urls }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Nie udało się przesłać zdjęć." }, { status: 500 }); }
}
