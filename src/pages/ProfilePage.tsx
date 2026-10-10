import { useEffect, useState } from "react";
import { db } from "../lib/db";
import { useAuth } from "../hooks/useAuth";
import { useProfile } from "../hooks/useProfile";
import UpdateCard from "../components/UpdateCard";
import { DEFAULT_VOICE_ID, listVoices, type ElevenVoice } from "../lib/speech";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_MODELS,
  defaultModelFor,
  modelLabel,
  normalizeProvider,
  resolveModelId,
} from "../lib/models";
import { testElevenKey, testLlmKey } from "../lib/providerTest";
import { MEMORY_MODEL, checkOllama, hasMemoryModel } from "../lib/ollama";
import { runVoiceSelfTest, type VoiceCheckStage } from "../lib/voiceCheck";
import DevicesSection from "../components/DevicesSection";


const isVoiceId = (v: string) => /^[A-Za-z0-9]{16,}$/.test(v.trim());

/**
 * Clears everything identifying about the person on this device: the profile
 * row and every `vc-*` preference. Sign-out used to leave both behind, which on
 * a shared machine handed the next user the previous one's name, notes and
 * (before keys moved server-side) their API keys.
 */
async function clearLocalData() {
  await db.profiles.clear();
  try {
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith("vc-"))) {
      localStorage.removeItem(k);
    }
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export default function ProfilePage() {
  const { user, signOut } = useAuth();
  const { data, update } = useProfile(user ? "1" : null);

  const getLS = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const [userName, setUserName] = useState(() => getLS("vc-user-name", user?.user_metadata?.display_name as string ?? "Kai Mercer") || getLS("vc-user-name", "Kai Mercer"));
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [aboutText, setAboutText] = useState(() => getLS("vc-about", "I focus better in the morning and I'm a slow starter — ease me into the day. Nothing before 9, even if I look free."));
  const [aiMode, setAiMode] = useState<"ai" | "manual">(() => (getLS("vc-ai-mode", "ai") as any));
  const [provider, setProvider] = useState(() => normalizeProvider(getLS("vc-provider", DEFAULT_PROVIDER)));
  const [model, setModel] = useState(() => {
    const prov = normalizeProvider(getLS("vc-provider", DEFAULT_PROVIDER));
    return resolveModelId(getLS("vc-model", DEFAULT_MODEL), prov);
  });
  const [llmKey, setLlmKey] = useState("");
  const [llmKeyShown, setLlmKeyShown] = useState(false);
  const [elKey, setElKey] = useState("");
  const [elKeyShown, setElKeyShown] = useState(false);
  const [voice, setVoice] = useState(() => getLS("vc-voice", DEFAULT_VOICE_ID));
  const [llmOpen, setLlmOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voices, setVoices] = useState<ElevenVoice[]>([]);
  const [voicesError, setVoicesError] = useState("");
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [silenceMs, setSilenceMs] = useState(() => getLS("vc-silence-ms", "1200"));
  const [pEarliest, setPEarliest] = useState(() => getLS("vc-p-earliest", "09:00"));
  const [pLatest, setPLatest] = useState(() => getLS("vc-p-latest", "22:00"));
  const [pBuffer, setPBuffer] = useState(() => getLS("vc-p-buffer", "15"));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkStages, setCheckStages] = useState<VoiceCheckStage[] | null>(null);
  const [llmTest, setLlmTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [elTest, setElTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [elTesting, setElTesting] = useState(false);
  const [ollamaInfo, setOllamaInfo] = useState("");

  const hasProvider = !!provider;
  const providerModels = PROVIDER_MODELS[normalizeProvider(provider)] ?? PROVIDER_MODELS.OpenAI;

  useEffect(() => {
    const lsName = getLS("vc-user-name", "");
    if (lsName && lsName !== "Kai Mercer" && !data?.profile?.display_name) setUserName(lsName);
    if (user?.user_metadata?.display_name && !data?.profile?.display_name && !lsName) setUserName(user.user_metadata.display_name as string);
  }, [user]);

  useEffect(() => {
    if (data?.profile) {
      if (data.profile.display_name) { setUserName(data.profile.display_name); try { localStorage.setItem("vc-user-name", data.profile.display_name); } catch {} }
      if (data.profile.about_text) setAboutText(data.profile.about_text);
      if (data.profile.ai_mode) setAiMode(data.profile.ai_mode as any);
      if (data.profile.provider) {
        const prov = normalizeProvider(data.profile.provider);
        setProvider(prov);
        if (data.profile.model) setModel(resolveModelId(data.profile.model, prov));
      } else if (data.profile.model) {
        setModel(resolveModelId(data.profile.model, provider));
      }
      if (data.profile.voice) setVoice(data.profile.voice);
    }
    if (data?.preferences) {
      if (data.preferences.earliest_start_time) setPEarliest(data.preferences.earliest_start_time);
      if (data.preferences.latest_end_time) setPLatest(data.preferences.latest_end_time);
      if (data.preferences.buffer_minutes_after_fixed_events !== undefined) setPBuffer(String(data.preferences.buffer_minutes_after_fixed_events));
    }
  }, [data]);

  const initials = userName.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";
  const provNorm = normalizeProvider(provider || DEFAULT_PROVIDER);
  const profModel = `${provNorm} — ${modelLabel(resolveModelId(model, provNorm), provNorm)}`;
  const profVoice =
    voices.find((v) => v.voice_id === voice)?.name ??
    (!voice || voice === DEFAULT_VOICE_ID ? "Default voice" : isVoiceId(voice) ? "Custom voice" : voice);
  const llmKeyMask = data?.profile.has_llm_key ? data.profile.llm_key_mask : "Not set — add in onboarding";
  const elKeyMask = data?.profile.has_el_key ? data.profile.el_key_mask : "Not set";

  /** Returns true on success. Callers must only clear key fields when true. */
  const saveProfile = async (patch: Record<string, unknown>): Promise<boolean> => {
    if ((patch as any).display_name) try { localStorage.setItem("vc-user-name", String((patch as any).display_name)); } catch {}
    if ((patch as any).about_text) try { localStorage.setItem("vc-about", String((patch as any).about_text)); } catch {}
    setSaving(true);
    setSaveError("");
    try {
      await update(patch);
      window.dispatchEvent(new Event("vc-profile-update"));
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col pt-12 pl-[60px]">
      <div className="font-mono text-[11px] tracking-[0.16em] uppercase text-grey">Profile</div>
      <div className="flex min-h-0 flex-1 gap-14 overflow-y-auto pr-[60px] pb-10 items-start">
        <div className="min-w-0 max-w-[680px] flex-1">
          <div className="mt-[34px] flex items-center gap-[22px]">
            <div className="flex h-[62px] w-[62px] flex-none items-center justify-center rounded-full border border-line bg-done font-mono text-[15px] tracking-[0.06em] text-grey">{initials}</div>
            <div className="min-w-0 flex-1">
              {!nameEditing ? (
                <div className="flex items-baseline gap-[14px]">
                  <div className="text-[30px] font-medium tracking-[-0.018em]">{userName}</div>
                  <button onClick={() => { setNameDraft(userName); setNameEditing(true); }} className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">Edit</button>
                </div>
              ) : (
                <div className="flex items-center gap-[14px]">
                  <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" className="min-w-0 flex-1 border-0 border-b border-line-strong bg-transparent pb-[6px] font-sans text-[28px] font-medium tracking-[-0.018em] text-ink outline-none" />
                  <button onClick={async () => { const v = nameDraft.trim(); if (v) { setUserName(v); await saveProfile({ display_name: v }); } setNameEditing(false); }} className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-accent-deep">Save</button>
                  <button onClick={() => setNameEditing(false)} className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">Cancel</button>
                </div>
              )}
            </div>
            <div className="flex flex-none items-center gap-5">
              <button onClick={async () => { await clearLocalData(); await signOut(); location.reload(); }} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-[9px] font-mono text-[10.5px] tracking-[0.14em] uppercase text-ink-soft hover:border-ink hover:text-ink">Sign out</button>
            </div>
          </div>
          <div className="mt-[18px] flex gap-[22px] font-mono text-[10.5px] tracking-[0.1em] text-grey-soft">
            <button onClick={async () => {
              // Secrets must never reach the export file: it lands in Downloads,
              // where it is world-readable and usually cloud-synced.
              const { llm_key_enc, el_key_enc, ...profile } = ((await db.profiles.get("local")) ?? {}) as Record<string, unknown>;
              void llm_key_enc; void el_key_enc;
              const all = {
                profile,
                preferences: await db.preferences.get(1),
                fixed: await db.fixed_commitments.toArray(),
                tasks: await db.tasks.toArray(),
                blocks: await db.scheduled_blocks.toArray(),
              };
              const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }));
              const a = document.createElement("a"); a.href = url; a.download = "rocky-data.json"; a.click();
            }} className="cursor-pointer hover:text-ink-muted">Export my data</button>
            <button onClick={async () => {
              if (!confirm("Delete account and all calendar data? This cannot be undone.")) return;
              await clearLocalData();
              await db.preferences.clear(); await db.fixed_commitments.clear(); await db.tasks.clear(); await db.scheduled_blocks.clear();
              try { localStorage.clear(); } catch {}
              location.reload();
            }} className="cursor-pointer hover:text-ink-muted">Delete account</button>
          </div>

          <div className="mt-11 flex items-baseline justify-between border-b border-line pb-3">
            <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">Assistant</div>
            <div className="flex gap-2">
              {(["ai", "manual"] as const).map((k) => {
                const label = k === "ai" ? "AI" : "Manual";
                const on = aiMode === k;
                return (
                  <button key={k} onClick={async () => { setAiMode(k); await saveProfile({ ai_mode: k }); }} className="cursor-pointer rounded-[3px] border px-[13px] py-[6px] font-mono text-[10px] tracking-[0.14em] uppercase" style={{ borderColor: on ? "var(--color-ink)" : "var(--color-line-strong)", background: on ? "var(--color-ink)" : "transparent", color: on ? "var(--color-canvas)" : "var(--color-grey)" }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {aiMode !== "manual" ? (
            <div className="mt-5 flex flex-col gap-[10px]">
              <div className="flex items-center gap-5 rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Model</div>
                  <div className="mt-2 text-[16px] font-medium">{profModel}</div>
                </div>
                <button onClick={() => { setLlmOpen((v) => !v); setVoiceOpen(false); }} className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-[14px] py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink">Change</button>
              </div>
              {llmOpen && (
                <div className="flex flex-col gap-[22px] rounded-[3px] border border-line-strong bg-done p-[22px] animate-vcin">
                  <div className="flex gap-[18px]">
                    <label className="flex flex-1 flex-col gap-[10px]">
                      <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Provider</span>
                      <select
                        value={provider}
                        onChange={(e) => {
                          const p = normalizeProvider(e.target.value);
                          setProvider(p);
                          setModel(defaultModelFor(p));
                          setLlmTest(null);
                        }}
                        className="h-11 w-full cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-card px-[13px] font-sans text-[15px] text-ink outline-none"
                      >
                        <option value="">Choose a provider</option>
                        {PROVIDERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-1 flex-col gap-[10px]">
                      <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Model</span>
                      {hasProvider ? (
                        <select value={model} onChange={(e) => { setModel(e.target.value); setLlmTest(null); }} className="h-11 w-full cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-card px-[13px] font-sans text-[15px] text-ink outline-none">
                          <option value="">Choose a model</option>
                          {providerModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                      ) : (
                        <div className="flex h-11 items-center rounded-[3px] border border-dashed border-line-strong px-[13px] text-[14px] text-grey-soft">Pick a provider first</div>
                      )}
                    </label>
                  </div>
                  <label className="flex flex-col gap-[10px]">
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">API key</span>
                    <div className="flex items-center gap-3 border-b border-line-strong pb-[9px]">
                      <input type={llmKeyShown ? "text" : "password"} value={llmKey} onChange={(e) => { setLlmKey(e.target.value); setLlmTest(null); }} placeholder="Paste your API key" className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[14px] text-ink outline-none" />
                      <button onClick={() => setLlmKeyShown((v) => !v)} className="flex-none cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">{llmKeyShown ? "Hide" : "Show"}</button>
                    </div>
                    <span className="font-mono text-[10.5px] text-grey-soft">{llmKeyMask} — device only, never sent to Supabase</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setLlmTesting(true);
                          setLlmTest(null);
                          const r = await testLlmKey(provider, model, llmKey);
                          setLlmTesting(false);
                          setLlmTest(r);
                        }}
                        disabled={llmTesting || !llmKey.trim()}
                        className="w-fit cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60"
                      >
                        {llmTesting ? "Testing…" : "Test key"}
                      </button>
                      {llmTest && <span className={`font-mono text-[11px] ${llmTest.ok ? "text-accent-deep" : "text-warm"}`}>{llmTest.message}</span>}
                    </div>
                  </label>
                  <div className="flex items-center gap-4">
                    <button onClick={async () => { try { localStorage.setItem("vc-provider", provider); localStorage.setItem("vc-model", model); } catch {} if (await saveProfile({ provider, model, llm_key: llmKey || undefined })) { setLlmKey(""); setLlmOpen(false); } }} disabled={saving} className="cursor-pointer rounded-[3px] bg-ink px-[22px] py-[11px] text-[14px] font-medium text-canvas hover:bg-accent disabled:opacity-60">Save</button>
                    <button onClick={() => setLlmOpen(false)} className="cursor-pointer font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">Cancel</button>
                    {saveError && <span className="font-mono text-[11px] text-warm">{saveError}</span>}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-5 rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Voice</div>
                  <div className="mt-2 flex items-baseline gap-3">
                    <span className="text-[16px] font-medium">{profVoice}</span>
                    <span className="font-mono text-[11px] text-grey-mid">ElevenLabs · {elKeyMask}</span>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const next = !voiceOpen;
                    setVoiceOpen(next);
                    setLlmOpen(false);
                    if (next && !voices.length && !voicesLoading) {
                      setVoicesLoading(true);
                      setVoicesError("");
                      listVoices()
                        .then(setVoices)
                        .catch((e) => setVoicesError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setVoicesLoading(false));
                    }
                  }}
                  className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-[14px] py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink"
                >Change</button>
              </div>
              {voiceOpen && (
                <div className="flex flex-col gap-[22px] rounded-[3px] border border-line-strong bg-done p-[22px] animate-vcin">
                  <label className="flex flex-col gap-[10px]">
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">ElevenLabs key</span>
                    <div className="flex items-center gap-3 border-b border-line-strong pb-[9px]">
                      <input type={elKeyShown ? "text" : "password"} value={elKey} onChange={(e) => { setElKey(e.target.value); setElTest(null); }} placeholder="Paste a new key to replace it" className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[14px] text-ink outline-none" />
                      <button onClick={() => setElKeyShown((v) => !v)} className="flex-none cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">{elKeyShown ? "Hide" : "Show"}</button>
                    </div>
                    <span className="font-mono text-[10.5px] text-grey-soft">Needs speech-to-text and text-to-speech — device only, never sent to Supabase.</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setElTesting(true);
                          setElTest(null);
                          const r = await testElevenKey(elKey);
                          setElTesting(false);
                          setElTest(r);
                        }}
                        disabled={elTesting || !elKey.trim()}
                        className="w-fit cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60"
                      >
                        {elTesting ? "Testing…" : "Test key"}
                      </button>
                      {elTest && <span className={`font-mono text-[11px] ${elTest.ok ? "text-accent-deep" : "text-warm"}`}>{elTest.message}</span>}
                    </div>
                  </label>
                  <div className="overflow-hidden rounded-[3px] border border-line bg-card">
                    {voicesLoading ? (
                      <div className="px-[15px] py-3 font-mono text-[11px] text-grey">Loading your voices…</div>
                    ) : voicesError ? (
                      <div className="px-[15px] py-3 font-mono text-[11px] leading-[1.5] text-warm">{voicesError}</div>
                    ) : voices.length === 0 ? (
                      <div className="px-[15px] py-3 font-mono text-[11px] text-grey">No voices on this account yet.</div>
                    ) : (
                      voices.map((v) => {
                        const active = voice === v.voice_id;
                        return (
                          <button key={v.voice_id} onClick={() => setVoice(v.voice_id)} className="flex w-full cursor-pointer items-center gap-[14px] border-b border-line-panel px-[15px] py-3 text-left last:border-0" style={{ background: active ? "var(--color-accent-bg)" : "transparent" }}>
                            <span className="h-[7px] w-[7px] flex-none rounded-full border" style={{ background: active ? "var(--color-accent)" : "transparent", borderColor: active ? "var(--color-accent)" : "var(--color-grey-soft)" }} />
                            <span className="min-w-0 flex-1 truncate text-[14.5px]" style={{ color: active ? "var(--color-ink)" : "var(--color-ink-soft)" }}>{v.name}</span>
                            {v.description && <span className="flex-none truncate font-mono text-[10.5px] text-grey-soft">{v.description}</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                  <label className="flex flex-col gap-[10px]">
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">End-of-turn silence</span>
                    <select
                      value={silenceMs}
                      onChange={(e) => {
                        setSilenceMs(e.target.value);
                        try {
                          localStorage.setItem("vc-silence-ms", e.target.value);
                        } catch {}
                      }}
                      className="h-11 w-full cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-card px-[13px] font-sans text-[15px] text-ink outline-none"
                    >
                      <option value="800">0.8s — quick</option>
                      <option value="1200">1.2s — default</option>
                      <option value="2000">2.0s — patient</option>
                      <option value="2600">2.6s — very patient</option>
                    </select>
                    <span className="font-mono text-[10.5px] text-grey-soft">How long Rocky waits after you stop talking before it answers.</span>
                  </label>
                  <div className="flex flex-col gap-[10px] rounded-[3px] border border-line bg-card px-[15px] py-[13px]">
                    <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Voice check</span>
                    <span className="font-mono text-[10.5px] text-grey-soft">Proves the saved keys work end to end: planner thinks, voice speaks.</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async () => {
                          setChecking(true);
                          setCheckStages(null);
                          try {
                            setCheckStages(await runVoiceSelfTest());
                          } finally {
                            setChecking(false);
                          }
                        }}
                        disabled={checking}
                        className="w-fit cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60"
                      >
                        {checking ? "Checking…" : "Run voice check"}
                      </button>
                    </div>
                    {checkStages && (
                      <div className="flex flex-col gap-1.5">
                        {checkStages.map((s) => (
                          <div key={s.id} className="flex items-baseline gap-2 font-mono text-[11px] leading-[1.5]">
                            <span className={s.ok ? "text-accent-deep" : "text-warm"}>{s.ok ? "✓" : "✕"}</span>
                            <span className="text-grey">{s.label} —</span>
                            <span className={s.ok ? "text-grey" : "text-warm"}>{s.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <button onClick={async () => { try { localStorage.setItem("vc-silence-ms", silenceMs); } catch {} if (await saveProfile({ voice, el_key: elKey || undefined })) { setElKey(""); setVoiceOpen(false); } }} disabled={saving} className="cursor-pointer rounded-[3px] bg-ink px-[22px] py-[11px] text-[14px] font-medium text-canvas hover:bg-accent disabled:opacity-60">Save</button>
                    <button onClick={() => setVoiceOpen(false)} className="cursor-pointer font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">Cancel</button>
                    {saveError && <span className="font-mono text-[11px] text-warm">{saveError}</span>}
                  </div>
                </div>
              )}
              <div className="rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Memory model (optional)</div>
                <div className="mt-2 text-[15px] font-medium text-ink-soft">
                  {data?.profile.memory_model_ready ? "Ready — Qwen 3.5 2B on this laptop." : `Not set up — ${MEMORY_MODEL}, about 2.7 GB.`}
                </div>
                <div className="mt-1 font-mono text-[11px] leading-[1.5] text-grey">Saves what you read on this laptop so you can ask about it later. Stays on this laptop.</div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={async () => {
                      setOllamaInfo("Checking…");
                      const s = await checkOllama();
                      if (s.state === "ready") {
                        setOllamaInfo(hasMemoryModel(s.models) ? `Ollama running · model present (${s.models.slice(0, 3).join(", ")})` : `Ollama running · model missing (${s.models.length} models)`);
                        if (hasMemoryModel(s.models)) await saveProfile({ memory_model_ready: true });
                      } else if (s.state === "cors-blocked") {
                        setOllamaInfo("Browser blocked the localhost check (CORS), but Ollama may still be running. Use the desktop app to verify.");
                      } else {
                        setOllamaInfo("Ollama isn’t running. Set it up in Onboarding or the Memory page.");
                      }
                    }}
                    className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink"
                  >
                    Check memory
                  </button>
                  {ollamaInfo && <span className="font-mono text-[11px] text-grey">{ollamaInfo}</span>}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-[3px] border border-dashed border-line-strong px-[22px] py-5">
              <div className="text-[15px] leading-[1.55] text-ink-muted text-pretty">You&apos;re running it by hand. Switch to AI above to add a model and a voice — voice planning, rescheduling and assignment chunking come back on.</div>
            </div>
          )}

          <div className="mt-11 border-b border-line pb-3 font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">Things Jarvis should know about you</div>
          <div className="mt-[18px]">
            <textarea value={aboutText} onChange={(e) => setAboutText(e.target.value)} onBlur={() => void saveProfile({ about_text: aboutText })} placeholder="I focus better in the morning. Don't put anything before 9 even if I look free." className="box-border min-h-[116px] w-full resize-y rounded-[3px] border border-line-strong bg-card px-[17px] py-[15px] font-sans text-[15px] leading-[1.6] text-ink outline-none" />
            <div className="mt-[10px] font-mono text-[10.5px] text-grey-soft">Read before every plan it makes — synced to backend.</div>
          </div>

          <div className="mt-11 border-b border-line pb-3 font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">Scheduling</div>
          <div className="mt-[22px] flex flex-col gap-6">
            <div className="flex gap-[34px]">
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Earliest start</span>
                <input type="time" value={pEarliest} onChange={(e) => { setPEarliest(e.target.value); void saveProfile({ earliest_start_time: e.target.value }); }} className="w-[118px] border-0 border-b border-line-strong bg-transparent pb-[9px] font-mono text-[17px] text-ink outline-none" />
              </label>
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Latest end</span>
                <input type="time" value={pLatest} onChange={(e) => { setPLatest(e.target.value); void saveProfile({ latest_end_time: e.target.value }); }} className="w-[118px] border-0 border-b border-line-strong bg-transparent pb-[9px] font-mono text-[17px] text-ink outline-none" />
              </label>
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Buffer after fixed</span>
                <select value={pBuffer} onChange={(e) => { setPBuffer(e.target.value); void saveProfile({ buffer_minutes_after_fixed_events: Number(e.target.value) }); }} className="w-[118px] cursor-pointer appearance-none border-0 border-b border-line-strong bg-transparent pb-[9px] font-mono text-[17px] text-ink outline-none">
                  <option value="0">none</option>
                  <option value="10">10 min</option>
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="mt-[34px] w-[300px] flex-none pb-10">
          <div className="border-b border-line pb-3 font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">Connections</div>
          <div className="mt-[18px] flex flex-col gap-2">
            <div className="rounded-[3px] border border-line px-[18px] py-[15px] opacity-60">
              <div className="flex items-baseline gap-[14px]">
                <div className="min-w-0 flex-1 text-[15px] text-ink-muted">Google Calendar</div>
                <div className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-grey-faint">Soon</div>
              </div>
              <div className="mt-[6px] font-mono text-[10.5px] leading-[1.5] text-grey-soft text-pretty">Two-way sync with your existing calendar</div>
            </div>
            <div className="rounded-[3px] border border-line px-[18px] py-[15px] opacity-60">
              <div className="flex items-baseline gap-[14px]">
                <div className="min-w-0 flex-1 text-[15px] text-ink-muted">Canvas</div>
                <div className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-grey-faint">Soon</div>
              </div>
              <div className="mt-[6px] font-mono text-[10.5px] leading-[1.5] text-grey-soft text-pretty">Pull assignment deadlines straight from your courses</div>
            </div>
          </div>


          <div className="mt-9 border-b border-line pb-3 font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">Devices</div>
          <div className="mt-[18px]">
            <DevicesSection />
          </div>

          <div className="mt-9 border-b border-line pb-3 font-mono text-[10.5px] tracking-[0.14em] uppercase text-grey-mid">App</div>
          <div className="mt-[18px]">
            <UpdateCard />
          </div>
        </div>
      </div>
    </div>
  );
}
