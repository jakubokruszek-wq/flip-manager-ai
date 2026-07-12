import Image from "next/image";
import { Building2 } from "lucide-react";

import { cn } from "@/lib/utils";

type PropertyImageCellProps = {
  imageUrl: string | null;
  address: string;
};

export function PropertyImageCell({
  imageUrl,
  address,
}: PropertyImageCellProps) {
  return (
    <div
      className={cn(
        "relative h-12 w-16 overflow-hidden rounded-lg border border-border bg-surface-muted",
      )}
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt={address}
          fill
          className="object-cover"
          sizes="64px"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Building2 className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
