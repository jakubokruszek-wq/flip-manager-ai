import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function ChartSurface({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="chart-surface" className={cn("ui-chart", className)} {...props} />
}

export { ChartSurface }
