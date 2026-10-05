import { useSyncExternalStore } from "react";

/**
 * The app's one theme.
 *
 * The header and the code runner used to keep separate copies: the header owned
 * the state and wrote the `dark` class from an effect, while the runner read the
 * class back off the DOM. Between those two moments the runner saw a light
 * document and built its editor with Monaco's light theme — which is why the
 * editor came up white in dark mode until the theme was toggled. One value,
 * applied before React renders, removes the seam.
 *
 * The `cc-theme` key is the one the formatter has always used.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "cc-theme";

function stored(): Theme | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "dark" || value === "light" ? value : null;
}

/** The stored choice, or the operating system's when nothing has been chosen. */
function preferred(): Theme {
  const saved = stored();
  if (saved) return saved;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let current: Theme = preferred();
const listeners = new Set<() => void>();

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  window.localStorage.setItem(STORAGE_KEY, theme);
}

// Applied at import time rather than from an effect, so the class is on <html>
// before the first render and nothing in the app can read a stale theme.
if (typeof document !== "undefined") apply(current);

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  if (theme === current) return;
  current = theme;
  apply(theme);
  for (const listener of listeners) listener();
}

export function toggleTheme(): void {
  setTheme(current === "dark" ? "light" : "dark");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current theme; the caller re-renders whenever it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
