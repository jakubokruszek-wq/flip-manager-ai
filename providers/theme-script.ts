export const THEME_STORAGE_KEY = "theme";
export const DEFAULT_THEME = "dark";

export function themeInitializationScript(): string {
  return `(() => {
    try {
      const storageKey = "${THEME_STORAGE_KEY}";
      const storedTheme = localStorage.getItem(storageKey);
      const theme = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "${DEFAULT_THEME}";
      const resolvedTheme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
      root.style.colorScheme = resolvedTheme;
    } catch { }
  })()`;
}
