import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { db, usingCloud } from "../lib/db";
import { supabase } from "../lib/supabase";

export type LocalUser = { id: string; email: string | null; user_metadata: { display_name?: string } };

/** Set by AuthGate when Supabase is configured: the validated session for this account. */
export const SessionContext = createContext<Session | null>(null);

function fromSession(s: Session | null): LocalUser | null {
  if (!s) return null;
  const meta = (s.user.user_metadata ?? {}) as { display_name?: string; full_name?: string };
  return { id: s.user.id, email: s.user.email ?? null, user_metadata: { display_name: meta.display_name ?? meta.full_name } };
}

export function useAuth() {
  const session = useContext(SessionContext);
  const [localUser, setLocalUser] = useState<LocalUser | null>(null);
  const [loading, setLoading] = useState(!usingCloud);

  // Offline mode (no Supabase env): the original single-profile behavior.
  useEffect(() => {
    if (usingCloud) return;
    let cancelled = false;
    const load = async () => {
      try {
        const p = await db.profiles.get("local");
        if (cancelled) return;
        if (p) {
          setLocalUser({ id: p.id, email: p.email ?? null, user_metadata: { display_name: p.display_name ?? undefined } });
        } else {
          const ls = (() => { try { return localStorage.getItem("vc-user-name"); } catch { return null; } })();
          if (ls) setLocalUser({ id: "local", email: null, user_metadata: { display_name: ls } });
        }
      } catch {}
      if (!cancelled) setLoading(false);
    };
    void load();
    const onUpdate = () => { void load(); };
    window.addEventListener("vc-profile-update", onUpdate);
    window.addEventListener("storage", onUpdate);
    return () => { cancelled = true; window.removeEventListener("vc-profile-update", onUpdate); window.removeEventListener("storage", onUpdate); };
  }, []);

  const signOut = async () => {
    try { localStorage.removeItem("vc-onb-done"); } catch {}
    if (usingCloud) await supabase().auth.signOut();
    window.dispatchEvent(new Event("vc-profile-update"));
  };

  if (usingCloud) {
    return { user: fromSession(session), loading: false, signOut, token: session?.access_token ?? null, session };
  }
  return { user: localUser, loading, signOut, token: null as string | null, session: null as Session | null };
}
