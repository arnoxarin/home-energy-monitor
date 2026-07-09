import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "voltwatch-theme";

type Origin = { x: number; y: number } | null;
type Ctx = {
  theme: Theme;
  setTheme: (t: Theme, origin?: Origin) => void;
  toggle: (origin?: Origin) => void;
};
const ThemeContext = createContext<Ctx | undefined>(undefined);

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", t === "dark");
  document.documentElement.style.colorScheme = t;
}

function commitTheme(t: Theme, origin: Origin) {
  if (typeof document === "undefined") {
    applyTheme(t);
    return;
  }
  const root = document.documentElement;
  const x = origin?.x ?? window.innerWidth - 40;
  const y = origin?.y ?? 40;
  root.style.setProperty("--tt-x", `${x}px`);
  root.style.setProperty("--tt-y", `${y}px`);

  // @ts-expect-error - View Transitions API is not in all TS libs yet
  const startViewTransition: undefined | ((cb: () => void) => unknown) =
    document.startViewTransition?.bind(document);

  const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  if (!startViewTransition || prefersReduced) {
    applyTheme(t);
    return;
  }
  startViewTransition(() => applyTheme(t));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const initialized = useRef(false);

  useEffect(() => {
    let initial: Theme = "light";
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (stored === "light" || stored === "dark") {
        initial = stored;
      } else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
        initial = "dark";
      }
    } catch {
      // ignore
    }
    setThemeState(initial);
    applyTheme(initial);
    initialized.current = true;
  }, []);

  const setTheme = (t: Theme, origin: Origin = null) => {
    setThemeState(t);
    if (initialized.current) {
      commitTheme(t, origin);
    } else {
      applyTheme(t);
    }
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
  };

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        toggle: (origin) => setTheme(theme === "dark" ? "light" : "dark", origin ?? null),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
