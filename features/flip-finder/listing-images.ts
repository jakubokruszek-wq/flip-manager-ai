export function resolveListingImages(
  existingImages: string[],
  incomingThumbnailUrl: string | null,
  incomingImages?: string[],
): string[] {
  if (incomingImages?.length) {
    return incomingImages;
  }

  if (!incomingThumbnailUrl) {
    return existingImages;
  }

  return [incomingThumbnailUrl];
}
