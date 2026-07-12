"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type PropertyDialogProps = {
  trigger: React.ReactNode;
};

export function PropertyDialog({ trigger }: PropertyDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Dodaj nieruchomość</DialogTitle>
        </DialogHeader>

        <div className="py-6">
          Tutaj za chwilę pojawi się formularz.
        </div>
      </DialogContent>
    </Dialog>
  );
}