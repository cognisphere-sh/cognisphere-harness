import { create } from "zustand";

type Theme = "light" | "dark";

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

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

export const useTheme = create<ThemeStore>((set, get) => {
  const initial = readInitial();
  apply(initial);
  return {
    theme: initial,
    toggle: () => {
      const next = get().theme === "dark" ? "light" : "dark";
      apply(next);
      set({ theme: next });
    },
    set: (t) => {
      apply(t);
      set({ theme: t });
    },
  };
});
