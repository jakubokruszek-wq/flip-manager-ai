"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type PropertyDeleteControlProps = {
  propertyId: string;
  onDeleted: () => void;
  compact?: boolean;
};

export function PropertyDeleteControl({ propertyId, onDeleted, compact = false }: PropertyDeleteControlProps) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/properties/${propertyId}`, { method: "DELETE" });
      const payload: unknown = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        throw new Error(payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : "Nie udało się usunąć nieruchomości.");
      }
      setOpen(false);
      onDeleted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Nie udało się usunąć nieruchomości.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} size={compact ? "icon-sm" : "sm"} variant="destructive">
        {compact ? <span aria-hidden="true">×</span> : "Usuń"}
        {compact ? <span className="sr-only">Usuń nieruchomość</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Usunąć nieruchomość?</DialogTitle>
            <DialogDescription>Czy na pewno chcesz usunąć tę nieruchomość? Tej operacji nie można cofnąć.</DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={deleting} onClick={() => void remove()} variant="destructive">{deleting ? "Usuwanie…" : "Usuń nieruchomość"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
