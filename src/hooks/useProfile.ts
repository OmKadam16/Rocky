import { useCallback, useEffect, useState } from "react";
import { db } from "../lib/db";
import { getSecret, setSecret } from "../lib/secrets";

type ProfileData = {
  profile: {
    user_id: string;
    email: string | null;
    display_name: string | null;
    ai_mode: string;
    provider: string | null;
    model: string | null;
    voice: string | null;
    about_text: string | null;
    onboarding_done: boolean;
    onboarding_step: string | null;
    memory_model_ready: boolean | null;
    llm_key_mask: string;
    el_key_mask: string;
    browser_key_mask: string;
    has_llm_key: boolean;
    has_el_key: boolean;
    has_browser_key: boolean;
    llm_key_needs_reentry: boolean;
    el_key_needs_reentry: boolean;
    browser_key_needs_reentry: boolean;
  };
  preferences: {
    earliest_start_time: string;
    latest_end_time: string;
    buffer_minutes_after_fixed_events: number;
    preferred_study_hours: { start: string; end: string }[];
  };
};

function mask(k: string | null): string {
  if (!k) return "";
  const s = k.trim();
  if (s.length <= 8) return "•".repeat(s.length);
  return s.slice(0, 3) + "•".repeat(Math.max(6, s.length - 7)) + s.slice(-4);
}

export function useProfile(_token: string | null) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await db.profiles.get("local");
      const pref = await db.preferences.get(1);
      if (!p) { setData(null); return; }
      // Keys may live in the OS keychain on desktop, so never read the row directly.
      const [llmKey, elKey, browserKey] = await Promise.all([getSecret("llm_key"), getSecret("el_key"), getSecret("browser_key")]);
      setData({
        profile: {
          user_id: p.id,
          email: p.email,
          display_name: p.display_name,
          ai_mode: p.ai_mode,
          provider: p.provider,
          model: p.model,
          voice: p.voice,
          about_text: p.about_text,
          onboarding_done: p.onboarding_done,
          onboarding_step: (p as unknown as { onboarding_step?: string | null }).onboarding_step ?? null,
          memory_model_ready: (p as unknown as { memory_model_ready?: boolean | null }).memory_model_ready ?? null,
          llm_key_mask: mask(llmKey),
          el_key_mask: mask(elKey),
          browser_key_mask: mask(browserKey),
          has_llm_key: !!llmKey,
          has_el_key: !!elKey,
          has_browser_key: !!browserKey,
          llm_key_needs_reentry: false,
          el_key_needs_reentry: false,
          browser_key_needs_reentry: false,
        },
        preferences: {
          earliest_start_time: (pref?.earliest_start_time as string)?.slice(0, 5) ?? "07:00",
          latest_end_time: (pref?.latest_end_time as string)?.slice(0, 5) ?? "22:00",
          buffer_minutes_after_fixed_events: pref?.buffer_minutes_after_fixed_events ?? 15,
          preferred_study_hours: (pref as unknown as { preferred_study_hours?: { start: string; end: string }[] })?.preferred_study_hours ?? [],
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchProfile(); }, [fetchProfile]);

  const update = useCallback(async (patch: Record<string, unknown>) => {
    const p = (await db.profiles.get("local")) ?? ({ id: "local", display_name: null, ai_mode: "ai", onboarding_done: false } as any);
    const next: Record<string, unknown> = { ...p, id: "local" };
    if (patch.display_name !== undefined) next.display_name = patch.display_name as string | null;
    if (patch.ai_mode !== undefined) next.ai_mode = patch.ai_mode as string;
    if (patch.provider !== undefined) next.provider = patch.provider as string | null;
    if (patch.model !== undefined) next.model = patch.model as string | null;
    if (patch.voice !== undefined) next.voice = patch.voice as string | null;
    if (patch.about_text !== undefined) next.about_text = patch.about_text as string | null;
    if (patch.onboarding_done !== undefined) next.onboarding_done = !!patch.onboarding_done;
    if (patch.onboarding_step !== undefined) (next as Record<string, unknown>).onboarding_step = patch.onboarding_step as string | null;
    if (patch.memory_model_ready !== undefined) (next as Record<string, unknown>).memory_model_ready = patch.memory_model_ready as boolean | null;
    if (patch.email !== undefined) next.email = patch.email as string | null;
    // Sidebar reads the display name from localStorage; keys never go there.
    try {
      if (patch.display_name) localStorage.setItem("vc-user-name", String(patch.display_name));
    } catch {}
    await db.profiles.put(next as any);
    // setSecret writes the shared profile copy (all devices) + the keychain cache on desktop.
    if (patch.llm_key) await setSecret("llm_key", String(patch.llm_key));
    if (patch.el_key) await setSecret("el_key", String(patch.el_key));
    if (patch.browser_key) await setSecret("browser_key", String(patch.browser_key));
    if (patch.earliest_start_time || patch.latest_end_time || patch.buffer_minutes_after_fixed_events !== undefined || patch.preferred_study_hours !== undefined) {
      const pref = (await db.preferences.get(1)) ?? ({ id: 1 } as any);
      if (patch.earliest_start_time) pref.earliest_start_time = patch.earliest_start_time as string;
      if (patch.latest_end_time) pref.latest_end_time = patch.latest_end_time as string;
      if (patch.buffer_minutes_after_fixed_events !== undefined) pref.buffer_minutes_after_fixed_events = Number(patch.buffer_minutes_after_fixed_events);
      if (patch.preferred_study_hours !== undefined) (pref as Record<string, unknown>).preferred_study_hours = patch.preferred_study_hours as { start: string; end: string }[];
      await db.preferences.put(pref);
    }
    await fetchProfile();
    window.dispatchEvent(new Event("vc-profile-update"));
  }, [fetchProfile]);

  const completeOnboarding = useCallback(async (patch: Record<string, unknown>) => {
    await update({ ...patch, onboarding_done: true });
  }, [update]);

  return { data, loading, error, refresh: fetchProfile, update, completeOnboarding };
}
