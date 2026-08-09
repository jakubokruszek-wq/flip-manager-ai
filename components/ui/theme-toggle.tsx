"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { useTheme } from "@/providers/theme-provider";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  if (!mounted) {
    return (
      <IconButton label="Przełącz motyw" disabled className="opacity-0">
        <Sun className="h-4 w-4" />
      </IconButton>
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <IconButton
      label={isDark ? "Włącz tryb jasny" : "Włącz tryb ciemny"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </IconButton>
  );
}

function subscribe() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}
