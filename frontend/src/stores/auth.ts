import { create } from "zustand";
import { ApiError } from "@/lib/api";
import { authApi } from "@/lib/repls";
import type { User } from "@/lib/types";

interface AuthState {
  user: User | null;
  isLoaded: boolean;
  initialize: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  register: (body: { email: string; username: string; password: string; display_name?: string }) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoaded: false,
  initialize: async () => {
    if (get().isLoaded) return;
    try {
      const user = await authApi.me();
      set({ user, isLoaded: true });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn("auth/me failed", e);
      set({ user: null, isLoaded: true });
    }
  },
  login: async (login, password) => {
    const user = await authApi.login(login, password);
    set({ user, isLoaded: true });
  },
  register: async (body) => {
    const user = await authApi.register(body);
    set({ user, isLoaded: true });
  },
  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({ user: null });
    }
  },
}));
