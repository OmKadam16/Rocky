import { useEffect, useState } from "react";

type Theme = "light" | "dark";

function getInitial(): Theme {
  const stored = localStorage.getItem("vc-theme") as Theme | null;
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    return getInitial();
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem("vc-theme", theme);
  }, [theme]);

  // Keep every mounted instance (app, onboarding, sign-in) on the same theme.
  useEffect(() => {
    const sync = (next: Theme) => setTheme((cur) => (cur === next ? cur : next));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "vc-theme" && (e.newValue === "dark" || e.newValue === "light")) sync(e.newValue);
    };
    const onCustom = (e: Event) => {
      const next = (e as CustomEvent<Theme>).detail;
      if (next === "dark" || next === "light") sync(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("vc-theme-change", onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("vc-theme-change", onCustom);
    };
  }, []);

  const toggle = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        window.dispatchEvent(new CustomEvent("vc-theme-change", { detail: next }));
      } catch {}
      return next;
    });
  };

  return { theme, toggle };
}
