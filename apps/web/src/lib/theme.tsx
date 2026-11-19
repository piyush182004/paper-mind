import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
type Resolved = "light" | "dark";
interface ThemeState { preference: ThemePref; resolved: Resolved; setPreference: (p: ThemePref) => void }

const KEY = "pm-theme";
const Ctx = createContext<ThemeState | null>(null);
export const useTheme = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
};

const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const readPref = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked: follow the system
  }
};
const resolve = (p: ThemePref): Resolved => (p === "system" ? (media().matches ? "dark" : "light") : p);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPref] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readPref()));

  useEffect(() => {
    const apply = () => {
      const r = resolve(preference);
      setResolved(r);
      document.documentElement.dataset.theme = r;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", r === "dark" ? "#07090f" : "#f4f6fa");
    };
    apply();
    if (preference !== "system") return;
    const m = media();
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [preference]);

  const setPreference = (p: ThemePref) => {
    setPref(p);
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* storage blocked: preference lasts for this visit */
    }
  };
  return <Ctx.Provider value={{ preference, resolved, setPreference }}>{children}</Ctx.Provider>;
}
