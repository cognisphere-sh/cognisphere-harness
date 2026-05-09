import { create } from "zustand";
import { endpoints } from "./api";

interface AuthStore {
  user: string | null;
  status: "unknown" | "anon" | "authed";
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthStore>((set) => ({
  user: null,
  status: "unknown",
  refresh: async () => {
    try {
      const me = await endpoints.me();
      set({ user: me.user, status: me.user ? "authed" : "anon" });
    } catch {
      set({ user: null, status: "anon" });
    }
  },
  login: async (username, password) => {
    const res = await endpoints.login(username, password);
    set({ user: res.username, status: "authed" });
  },
  logout: async () => {
    await endpoints.logout().catch(() => {});
    set({ user: null, status: "anon" });
  },
}));
