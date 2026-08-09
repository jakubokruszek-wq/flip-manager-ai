"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Sidebar } from "@/components/layout/sidebar";
import { IconButton } from "@/components/ui/icon-button";
import { SearchField } from "@/components/ui/search-field";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { AlertsBell } from "@/features/alerts/components/alerts-bell";
import { cn } from "@/lib/utils";

type TopNavProps = {
  title?: string;
};

export function TopNav({ title = "Dashboard" }: TopNavProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-4 border-b border-border/80 bg-background/75 px-4 backdrop-blur-xl sm:px-6">
        <IconButton
          label={mobileMenuOpen ? "Zamknij nawigację" : "Otwórz nawigację"}
          className="lg:hidden"
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          {mobileMenuOpen ? (
            <X className="h-4 w-4" />
          ) : (
            <Menu className="h-4 w-4" />
          )}
        </IconButton>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-muted-foreground lg:hidden">
            Flip Manager
          </p>
          <h2 className="hidden truncate text-sm font-semibold tracking-tight text-foreground lg:block">
            {title}
          </h2>
        </div>

        <div className="hidden max-w-md flex-1 lg:flex">
          <SearchField placeholder="Szukaj..." />
        </div>

        <div className="flex items-center gap-1">
          <AlertsBell />
          <ThemeToggle />
        </div>
      </header>

      <div
        className={cn(
          "fixed inset-0 z-40 lg:hidden",
          mobileMenuOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!mobileMenuOpen}
      >
        <button
          type="button"
          aria-label="Zamknij nakładkę nawigacji"
          className={cn(
            "absolute inset-0 bg-black/40 transition-opacity",
            mobileMenuOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setMobileMenuOpen(false)}
        />

        <div
          className={cn(
            "absolute inset-y-0 left-0 w-[min(18rem,85vw)] transition-transform duration-300 ease-out",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <Sidebar onNavigate={() => setMobileMenuOpen(false)} />
        </div>
      </div>
    </>
  );
}
