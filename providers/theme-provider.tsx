"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { DEFAULT_THEME, THEME_STORAGE_KEY } from "@/providers/theme-script";

export type Theme = "light" | "dark" | "system";
type ResolvedTheme = Exclude<Theme, "system">;

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_CHANGE_EVENT = "flip-manager-theme-change";

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
};

export function ThemeProvider({ children, defaultTheme = DEFAULT_THEME }: ThemeProviderProps) {
  const theme = useSyncExternalStore(subscribe, getClientTheme, () => defaultTheme);
  const resolvedTheme = resolveTheme(theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme, true);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, setTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme musi być użyte wewnątrz ThemeProvider.");
  }

  return context;
}

function subscribe(onStoreChange: () => void): () => void {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  mediaQuery.addEventListener("change", onStoreChange);

  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
    mediaQuery.removeEventListener("change", onStoreChange);
  };
}

function getClientTheme(): Theme {
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(storedTheme) ? storedTheme : DEFAULT_THEME;
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (typeof window === "undefined") {
    return theme === "system" ? "dark" : theme;
  }

  return theme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : theme;
}

function applyTheme(theme: Theme, disableTransitions = false): void {
  const resolvedTheme = resolveTheme(theme);
  const root = document.documentElement;
  let transitionStyle: HTMLStyleElement | null = null;

  if (disableTransitions) {
    transitionStyle = document.createElement("style");
    transitionStyle.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.appendChild(transitionStyle);
  }

  root.classList.remove("light", "dark");
  root.classList.add(resolvedTheme);
  root.style.colorScheme = resolvedTheme;

  if (transitionStyle) {
    window.getComputedStyle(transitionStyle).getPropertyValue("opacity");
    transitionStyle.remove();
  }
}

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}
