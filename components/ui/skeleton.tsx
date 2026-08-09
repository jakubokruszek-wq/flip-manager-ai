import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("ui-skeleton", className)} {...props} />
}

export { Skeleton }
