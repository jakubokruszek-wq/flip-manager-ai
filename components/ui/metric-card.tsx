import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type MetricCardProps = {
  label: string
  value: ReactNode
  detail?: ReactNode
  className?: string
}

function MetricCard({ label, value, detail, className }: MetricCardProps) {
  return (
    <div className={cn("ui-metric", className)}>
      <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
      <div className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</div>
      {detail ? <div className="mt-1.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

export { MetricCard }
