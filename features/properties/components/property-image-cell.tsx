"use client";

import { useState } from "react";
import Image from "next/image";
import { Building2 } from "lucide-react";

import { cn } from "@/lib/utils";

type PropertyImageCellProps = {
  imageUrl: string | null;
  address: string;
  className?: string;
  sizes?: string;
};

const ALLOWED_IMAGE_HOSTS = new Set([
  "ireland.apollo.olxcdn.com",
  "img1.staticmorizon.com.pl",
]);

function isSupportedImageUrl(imageUrl: string | null): imageUrl is string {
  if (!imageUrl?.trim()) {
    return false;
  }

  try {
    const url = new URL(imageUrl);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.search === "" &&
      (ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) || (
        /^[a-z0-9]+\.supabase\.co$/.test(url.hostname.toLowerCase()) &&
        url.pathname.startsWith("/storage/v1/object/public/facebook-watcher-images/")
      ))
    );
  } catch {
    return false;
  }
}

function PropertyImage({ imageUrl, address, sizes = "64px" }: PropertyImageCellProps) {
  const [failedToLoad, setFailedToLoad] = useState(false);

  if (!isSupportedImageUrl(imageUrl) || failedToLoad) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Building2 className="h-4 w-4" aria-hidden="true" />
      </div>
    );
  }

  return (
    <Image
      src={imageUrl}
      alt={address}
      fill
      className="object-cover"
      sizes={sizes}
      onError={() => setFailedToLoad(true)}
    />
  );
}

export function PropertyImageCell({
  imageUrl,
  address,
  className,
  sizes,
}: PropertyImageCellProps) {
  return (
    <div
      className={cn(
        "relative h-12 w-16 overflow-hidden rounded-lg border border-border bg-surface-muted",
        className,
      )}
    >
      <PropertyImage key={imageUrl ?? "empty"} imageUrl={imageUrl} address={address} sizes={sizes} />
    </div>
  );
}
