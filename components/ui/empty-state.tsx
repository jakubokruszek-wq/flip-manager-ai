import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type EmptyStateProps = {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn("ui-empty-state", className)}>
      {icon ? <div className="mb-3 text-gold">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
