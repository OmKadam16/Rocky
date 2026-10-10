import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The Supabase client. Rocky stores accounts and calendar data here so the
 * laptop and the phone see the same week. When the env vars are missing
 * (a fresh clone with no .env.local) the app falls back to the old
 * on-device database so it still runs.
 */

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();

export const isSupabaseConfigured = Boolean(url && anonKey && !url.includes("your-project"));

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!isSupabaseConfigured) throw new Error("Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).");
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    });
  }
  return client;
}

/** The signed-in user's id, or null. Reads the cached session (no network). */
export async function currentUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase().auth.getSession();
  return data.session?.user.id ?? null;
}

/**
 * Realtime channel names must be unique per subscription: calling
 * channel(name) twice returns the already-subscribed channel and adding a
 * listener to it throws, which blanks the app.
 */
export function uniqueChannel(base: string): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
  return `${base}:${id}`;
}
