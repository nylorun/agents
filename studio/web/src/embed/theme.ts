import type { StudioTheme } from "@nylorun/agents/studio-embed";

/** Applies the embedder's theme: `.dark` on `<html>`, and its colors as CSS variables. */
export function applyTheme(theme: StudioTheme, root: HTMLElement = document.documentElement): void {
  root.classList.toggle("dark", theme.mode === "dark");
  const colors: Record<string, string | undefined> = {
    "--background": theme.background,
    "--foreground": theme.foreground,
    "--primary": theme.accent,
    "--sidebar-primary": theme.accent,
  };
  for (const [name, value] of Object.entries(colors)) {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}
