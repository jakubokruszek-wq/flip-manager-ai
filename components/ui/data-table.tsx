import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function DataTableShell({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="data-table-shell" className={cn("ui-table-shell", className)} {...props} />
}

function DataTable({ className, ...props }: ComponentProps<"table">) {
  return <table data-slot="data-table" className={cn("ui-data-table w-full border-collapse text-left text-sm", className)} {...props} />
}

export { DataTable, DataTableShell }
