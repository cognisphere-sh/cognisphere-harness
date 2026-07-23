import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

const KEY = "pi-theme";

function readInitial(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // ignore
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(t: Theme): void {
  const cl = document.documentElement.classList;
  if (t === "dark") cl.add("dark");
  else cl.remove("dark");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // ignore
  }
}

let theme: Theme = readInitial();
apply(theme);
const listeners = new Set<() => void>();

function setTheme(t: Theme): void {
  apply(t);
  theme = t;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme() {
  const t = useSyncExternalStore(subscribe, () => theme);
  return {
    theme: t,
    toggle: () => setTheme(theme === "dark" ? "light" : "dark"),
    set: setTheme,
  };
}
