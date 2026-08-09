"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { TopNav } from "@/components/layout/top-nav";
import { getModuleTitle } from "@/config/modules";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const pageTitle = getModuleTitle(pathname);

  return (
    <div className="flex min-h-screen overflow-x-hidden bg-transparent text-foreground">
      <div className="hidden w-64 shrink-0 lg:fixed lg:inset-y-0 lg:flex">
        <Sidebar />
      </div>

      <div className="flex min-h-screen flex-1 flex-col lg:pl-64">
        <TopNav title={pageTitle} />
        <main className="flex-1 overflow-y-auto pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-0">
          <div className="mx-auto w-full max-w-7xl px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-8 sm:px-6 sm:py-8">
            {children}
          </div>
        </main>
      </div>
      <MobileBottomNav />
    </div>
  );
}
