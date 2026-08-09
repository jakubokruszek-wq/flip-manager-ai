import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function TabsList({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="tabs-list" className={cn("ui-tabs", className)} {...props} />
}

function TabsTrigger({ className, active = false, ...props }: ComponentProps<"button"> & { active?: boolean }) {
  return <button type="button" data-slot="tabs-trigger" data-state={active ? "active" : "inactive"} className={cn("ui-tab", active && "ui-tab-active", className)} {...props} />
}

export { TabsList, TabsTrigger }
