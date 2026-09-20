export function resetFacebookGalleryMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const preserved = { ...metadata };
  delete preserved.galleryMediaIds;
  delete preserved.galleryStatus;
  delete preserved.galleryUpdatedAt;
  delete preserved.galleryError;
  return preserved;
}
