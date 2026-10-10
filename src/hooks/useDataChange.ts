import { useEffect, useRef } from "react";

/**
 * Calls `onChange` (debounced) whenever calendar data changes, on this device
 * or on another one (the phone) via Supabase Realtime. See supaDb.emitDataChange.
 */
export function useDataChange(onChange: () => void, tables?: readonly string[], delayMs = 200) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = tables?.join(",") ?? "*";

  useEffect(() => {
    const wanted = key === "*" ? null : new Set(key.split(","));
    let timer: number | undefined;
    const handler = (e: Event) => {
      const table = (e as CustomEvent<{ table?: string }>).detail?.table;
      if (wanted && table && !wanted.has(table)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => cb.current(), delayMs);
    };
    window.addEventListener("vc-data-change", handler);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("vc-data-change", handler);
    };
  }, [key, delayMs]);
}
