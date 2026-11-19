import { createContext, type ReactNode, useCallback, useContext, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export interface User { id: number; name: string; email: string; avatarUrl?: string | null }
interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: User | null }>("/auth/me"), staleTime: Infinity, retry: false });

  const setUser = useCallback((user: User | null) => {
    // never show one account's cached data to another, but keep the live "me" query
    // (clearing it detaches the observer and the screen would not switch)
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    qc.setQueryData(["me"], { user });
  }, [qc]);

  useEffect(() => {
    const onOut = () => setUser(null);
    window.addEventListener("pm:signed-out", onOut);
    return () => window.removeEventListener("pm:signed-out", onOut);
  }, [setUser]);

  const value: AuthState = {
    user: me.data?.user ?? null,
    loading: me.isLoading,
    signIn: async (email, password) => setUser((await api.post<{ user: User }>("/auth/login", { email, password })).user),
    signUp: async (name, email, password) => setUser((await api.post<{ user: User }>("/auth/register", { name, email, password })).user),
    signOut: async () => {
      await api.post("/auth/logout").catch(() => undefined);
      setUser(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
