import Image from "next/image";
import { cn } from "@/lib/utils";

export function CompanyBrand({ className }: { className?: string }) {
  return <Image src="/brand/metron-company.jpg" alt="MetrON — Nieruchomości i Inwestycje" width={256} height={256} className={cn("h-auto w-40 max-w-full rounded-xl", className)} />;
}
