"use client";

import Image from "next/image";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type PropertyGalleryProps = {
  images: string[];
  title: string;
};

export function PropertyGallery({ images, title }: PropertyGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const selectedImage = images[selectedIndex];

  if (images.length === 0) {
    return (
      <section aria-labelledby="images" className="space-y-4">
        <h2 id="images" className="text-lg font-semibold">
          Zdjęcia
        </h2>
        <div className="flex aspect-[16/9] items-center justify-center rounded-xl border bg-muted/40 text-sm text-muted-foreground">
          Brak zdjęć w ogłoszeniu.
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="images" className="space-y-3">
      <h2 id="images" className="text-lg font-semibold">
        Zdjęcia
      </h2>

      <Button
        variant="outline"
        className="relative aspect-[16/10] h-auto w-full overflow-hidden p-0"
        aria-label="Otwórz pełny widok zdjęcia"
        onClick={() => setIsPreviewOpen(true)}
      >
        <Image
          src={selectedImage}
          alt={`Zdjęcie oferty: ${title || "nieruchomość"}`}
          fill
          sizes="(max-width: 768px) 100vw, 768px"
          className="object-cover"
          preload
        />
      </Button>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((image, index) => (
          <Button
            key={image}
            variant="outline"
            className="relative size-20 shrink-0 overflow-hidden p-0"
            aria-label={`Wybierz zdjęcie ${index + 1}`}
            aria-pressed={selectedIndex === index}
            onClick={() => setSelectedIndex(index)}
          >
            <Image
              src={image}
              alt=""
              fill
              sizes="80px"
              className="object-cover"
            />
          </Button>
        ))}
      </div>

      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="max-w-5xl bg-background p-3 sm:max-w-5xl" showCloseButton>
          <DialogTitle className="sr-only">Podgląd zdjęcia oferty</DialogTitle>
          <Image
            src={selectedImage}
            alt={`Pełny widok zdjęcia oferty: ${title || "nieruchomość"}`}
            width={1600}
            height={1200}
            sizes="(max-width: 1024px) 100vw, 1024px"
            className="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
