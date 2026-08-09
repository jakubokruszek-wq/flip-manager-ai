import type { ComponentProps } from "react"
import { Search } from "lucide-react"

import { cn } from "@/lib/utils"

function SearchField({ className, ...props }: ComponentProps<"input">) {
  return (
    <label className={cn("relative block w-full", className)}>
      <span className="sr-only">Szukaj</span>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input type="search" className="h-9 w-full rounded-xl border border-border/80 bg-surface-elevated/75 py-2 pr-3 pl-9 text-sm text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] outline-none transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground hover:border-gold/20 focus:border-ring focus:bg-surface-elevated focus:ring-3 focus:ring-ring/20" {...props} />
    </label>
  )
}

export { SearchField }
