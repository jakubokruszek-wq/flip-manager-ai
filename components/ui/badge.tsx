import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva("ui-badge", {
  variants: {
    variant: {
      default: "border-gold/25 bg-gold/10 text-gold",
      neutral: "",
      success: "border-success/25 bg-success/10 text-success",
      warning: "border-warning/25 bg-warning/10 text-warning",
      danger: "border-danger/25 bg-danger/10 text-danger",
    },
  },
  defaultVariants: { variant: "neutral" },
})

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
