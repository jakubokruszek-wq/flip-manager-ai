"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/top-nav";
import { getModuleTitle } from "@/config/modules";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const pageTitle = getModuleTitle(pathname);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <div className="hidden w-64 shrink-0 lg:fixed lg:inset-y-0 lg:flex">
        <Sidebar />
      </div>

      <div className="flex min-h-screen flex-1 flex-col lg:pl-64">
        <TopNav title={pageTitle} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
