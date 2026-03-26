import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  workspaceId: string | null;
  setAuth: (token: string, user: AuthUser, workspaceId: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      workspaceId: null,
      setAuth: (token, user, workspaceId) => set({ token, user, workspaceId }),
      logout: () => set({ token: null, user: null, workspaceId: null }),
    }),
    {
      name: "copilot-auth",
      partialize: (state) => ({ token: state.token, user: state.user, workspaceId: state.workspaceId }),
    }
  )
);
