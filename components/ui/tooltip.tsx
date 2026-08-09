import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

function Tooltip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  return <span className={cn("group/tooltip relative inline-flex", className)}><span>{children}</span><span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-56 -translate-x-1/2 rounded-lg border border-border/80 bg-popover px-2.5 py-1.5 text-xs text-popover-foreground opacity-0 shadow-xl transition-opacity group-hover/tooltip:opacity-100">{content}</span></span>
}

export { Tooltip }
