"use client";

import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

type AddPropertyButtonProps = {
  label: string;
  showPlus?: boolean;
};

export function AddPropertyButton({
  label,
  showPlus = true,
}: AddPropertyButtonProps) {
  const handleClick = () => {
    // Formularz dodawania zostanie podłączony w kolejnej iteracji.
  };

  return (
    <Button variant="primary" onClick={handleClick}>
      {showPlus ? <Plus className="h-4 w-4" aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}
