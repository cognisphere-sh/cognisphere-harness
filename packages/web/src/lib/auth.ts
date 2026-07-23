import { useSyncExternalStore } from "react";
import { endpoints } from "./api";

interface AuthState {
  user: string | null;
  status: "unknown" | "anon" | "authed";
}

let state: AuthState = { user: null, status: "unknown" };
const listeners = new Set<() => void>();

function set(next: AuthState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const actions = {
  refresh: async () => {
    try {
      const me = await endpoints.me();
      set({ user: me.user, status: me.user ? "authed" : "anon" });
    } catch {
      set({ user: null, status: "anon" });
    }
  },
  login: async (username: string, password: string) => {
    const res = await endpoints.login(username, password);
    set({ user: res.username, status: "authed" });
  },
  logout: async () => {
    await endpoints.logout().catch(() => {});
    set({ user: null, status: "anon" });
  },
};

export function useAuth() {
  const s = useSyncExternalStore(subscribe, () => state);
  return { ...s, ...actions };
}
