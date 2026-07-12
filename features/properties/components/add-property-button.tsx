"use client";

import { useRouter } from "next/navigation";
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
  const router = useRouter();

  return (
    <Button
      variant="default"
      onClick={() => router.push("/properties/new")}
    >
      {showPlus && <Plus className="h-4 w-4" />}
      {label}
    </Button>
  );
}