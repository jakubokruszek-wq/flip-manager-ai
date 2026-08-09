import type { ComponentProps, ReactNode } from "react"

import { cn } from "@/lib/utils"

type SectionProps = ComponentProps<"section"> & {
  title?: string
  description?: string
  action?: ReactNode
}

function Section({ title, description, action, className, children, ...props }: SectionProps) {
  return (
    <section className={cn("ui-section", className)} {...props}>
      {title || description || action ? (
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            {title ? <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  )
}

export { Section }
