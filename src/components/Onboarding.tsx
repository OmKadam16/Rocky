import { useEffect, useRef, useState } from "react";
import OpenAI from "openai";
import type { PageName } from "../types";
import { WEEKDAYS, type CommitmentKind, type Weekday } from "../types";
import { db, ensureSeed, usingCloud } from "../lib/db";
import { getSecret, setSecret } from "../lib/secrets";
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_BASE_URL,
  PROVIDER_MODELS,
  defaultModelFor,
  normalizeProvider,
  resolveModelId,
} from "../lib/models";
import { testElevenKey, testLlmKey } from "../lib/providerTest";
import {
  MEMORY_MODEL,
  checkOllama,
  hasMemoryModel,
  isDesktop as isDesktopBuild,
  pullModel,
  testModel,
  type PullProgress,
} from "../lib/ollama";
import { blobToDataUrl, downscaleToJpeg, rejectReason, MAX_IMAGES } from "../lib/images";
import { validateDayAnalysis, DAY_ANALYSIS_PROMPT } from "../lib/dayAnalysis";
import { stepToIndex, validateCommitmentDraft } from "../lib/onboardingLogic";
import { startTranscription } from "../lib/transcribe";
import ThemeToggle from "./ThemeToggle";

type Props = {
  onDone: (nextPage: PageName) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

const WEEKDAY_TO_NUM: Record<Weekday, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

type Draft = { id: string; name: string; kind: CommitmentKind; days: Weekday[]; start: string; end: string; notes: string };

function emptyDraft(): Draft {
  return { id: crypto.randomUUID(), name: "", kind: "Class", days: [], start: "09:00", end: "10:00", notes: "" };
}

async function saveStep(step: string | null, extra: Record<string, unknown> = {}) {
  await ensureSeed();
  const existing = ((await db.profiles.get("local")) ?? ({ id: "local" } as unknown)) as Record<string, unknown>;
  await db.profiles.put({
    ...existing,
    id: "local",
    onboarding_step: step,
    ...extra,
  } as never);
  try {
    window.dispatchEvent(new Event("vc-profile-update"));
  } catch {}
}

export default function Onboarding({ onDone, theme, onToggleTheme }: Props) {
  const [onb, setOnb] = useState(0);
  const [auName, setAuName] = useState(() => {
    try {
      return localStorage.getItem("vc-user-name") ?? "";
    } catch {
      return "";
    }
  });
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [model, setModel] = useState(() => defaultModelFor(DEFAULT_PROVIDER));
  const [llmKey, setLlmKey] = useState("");
  const [llmKeyShown, setLlmKeyShown] = useState(false);
  const [llmTest, setLlmTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [elKey, setElKey] = useState("");
  const [elKeyShown, setElKeyShown] = useState(false);
  const [elTest, setElTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [elTesting, setElTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Memory (optional)
  const [ollamaState, setOllamaState] = useState<"checking" | "ready" | "missing" | "cors">("checking");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaMsg, setOllamaMsg] = useState("");
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [pulling, setPulling] = useState(false);
  const [modelTestMsg, setModelTestMsg] = useState("");
  const [memoryReady, setMemoryReady] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState("");
  const [installProgress, setInstallProgress] = useState<number | null>(null);

  // Day
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dayText, setDayText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);
  const stopRec = useRef<(() => void) | null>(null);

  // Commitments
  const [drafts, setDrafts] = useState<Draft[]>([emptyDraft()]);
  const [saving, setSaving] = useState(false);

  const isDesktop = isDesktopBuild();

  // Resume: refresh mid-way lands on the same step. Sign-up name prefilled via profile.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureSeed();
        const p = ((await db.profiles.get("local")) ?? null) as unknown as Record<string, unknown> | null;
        if (!p || cancelled) return;
        const step = String((p as Record<string, unknown>).onboarding_step ?? "");
        const done = Boolean((p as Record<string, unknown>).onboarding_done);
        if (done) return;
        if (step) {
          const idx = stepToIndex(step);
          if (idx >= 1 && idx <= 4) setOnb(idx);
        }
        const dn = String((p as Record<string, unknown>).display_name ?? "");
        if (dn) {
          setAuName((cur) => cur || dn);
          try {
            if (!localStorage.getItem("vc-user-name")) localStorage.setItem("vc-user-name", dn);
          } catch {}
        }
        const prov = normalizeProvider(String((p as Record<string, unknown>).provider ?? DEFAULT_PROVIDER));
        setProvider(prov);
        const storedModel = String((p as Record<string, unknown>).model ?? "");
        setModel(storedModel ? resolveModelId(storedModel, prov) : defaultModelFor(prov));
        const about = String((p as Record<string, unknown>).about_text ?? "");
        if (about) setDayText((cur) => cur || about.slice(0, 2000));
        const mem = (p as Record<string, unknown>).memory_model_ready;
        if (mem === true) setMemoryReady(true);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep previews in sync with files.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  // Ollama status when Keys step shows.
  useEffect(() => {
    if (onb !== 2) return;
    let cancelled = false;
    setOllamaState("checking");
    setOllamaMsg("");
    void checkOllama().then((s) => {
      if (cancelled) return;
      if (s.state === "ready") {
        setOllamaState("ready");
        setOllamaModels(s.models);
        if (hasMemoryModel(s.models)) setMemoryReady(true);
      } else if (s.state === "cors-blocked") {
        setOllamaState("cors");
        setOllamaMsg("Browser blocked the localhost check (CORS), but Ollama may still be running. In the desktop app this check works — or press Check again.");
      } else {
        setOllamaState("missing");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onb]);

  const dots = [1, 2, 3, 4].map((i) => ({
    bg: i === onb ? "var(--color-accent)" : "transparent",
    border: i === onb ? "var(--color-accent)" : i < onb ? "var(--color-grey-soft)" : "var(--color-line-strong)",
  }));

  const goName = () => setOnb(1);

  const saveName = async () => {
    const v = auName.trim();
    if (!v) {
      setError("Enter a name");
      return;
    }
    setError(null);
    await ensureSeed();
    const existing = ((await db.profiles.get("local")) ?? ({ id: "local" } as unknown)) as Record<string, unknown>;
    await db.profiles.put({ ...existing, id: "local", display_name: v } as never);
    try {
      localStorage.setItem("vc-user-name", v);
    } catch {}
    await saveStep("keys", { display_name: v });
    setOnb(2);
  };

  const runLlmTest = async () => {
    setLlmTesting(true);
    setLlmTest(null);
    const r = await testLlmKey(provider, model, llmKey);
    // If a saved key already works and the box is empty, still count it.
    if (!r.ok && !llmKey.trim()) {
      const saved = await getSecret("llm_key").catch(() => null);
      if (saved?.trim()) {
        const r2 = await testLlmKey(provider, model, saved);
        setLlmTesting(false);
        setLlmTest(r2);
        return;
      }
    }
    setLlmTesting(false);
    setLlmTest(r);
  };

  const runElTest = async () => {
    setElTesting(true);
    setElTest(null);
    let key = elKey.trim();
    if (!key) {
      const saved = await getSecret("el_key").catch(() => null);
      if (saved?.trim()) key = saved;
    }
    const r = await testElevenKey(key);
    setElTesting(false);
    setElTest(r);
  };

  const keysOk = Boolean(llmTest?.ok && elTest?.ok);

  const checkOllamaAgain = async () => {
    setOllamaState("checking");
    setOllamaMsg("");
    const s = await checkOllama();
    if (s.state === "ready") {
      setOllamaState("ready");
      setOllamaModels(s.models);
      if (hasMemoryModel(s.models)) setMemoryReady(true);
    } else if (s.state === "cors-blocked") {
      setOllamaState("cors");
      setOllamaMsg("Browser blocked the localhost check (CORS), but Ollama may still be running. In the desktop app this check works — or press Check again.");
    } else {
      setOllamaState("missing");
    }
  };

  const installOllama = async () => {
    setInstallMsg("");
    setInstallProgress(null);
    type RockyBridge = {
      platform?: string;
      shell?: { openExternal: (u: string) => Promise<boolean> };
      ollama?: {
        installOfficial: (platform: string) => Promise<string>;
        onInstallProgress: (h: (p: { got: number; total: number; percent: number | null }) => void) => () => void;
      };
    };
    const bridge = ((window as unknown as { rocky?: RockyBridge }).rocky ?? {}) as RockyBridge;
    const platform = String(bridge?.platform ?? "");
    const isWin = platform.includes("win");
    const isMac = platform.includes("darwin");
    if (!isDesktop || (!isWin && !isMac)) {
      // Browser build: always link out (fallback path).
      try {
        if (bridge?.shell?.openExternal) await bridge.shell.openExternal("https://ollama.com/download");
        else window.open("https://ollama.com/download", "_blank", "noopener");
      } catch {
        window.open("https://ollama.com/download", "_blank", "noopener");
      }
      setInstallMsg("Opened ollama.com/download — install it once, then press Check again.");
      return;
    }
    // Electron: MAIN downloads the hardcoded official installer (renderer only passes platform).
    if (!bridge?.ollama?.installOfficial) {
      try {
        await bridge?.shell?.openExternal("https://ollama.com/download");
      } catch {}
      setInstallMsg("Opened ollama.com/download — install it once, then press Check again.");
      return;
    }
    setInstalling(true);
    const off = bridge.ollama.onInstallProgress?.((p) => {
      if (typeof p?.percent === "number") setInstallProgress(p.percent);
    });
    try {
      await bridge.ollama.installOfficial(platform);
      setInstallProgress(100);
      setInstallMsg("Installer launched — click through it once, then press Check again. Polling for Ollama…");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await checkOllama();
        if (s.state === "ready") {
          setOllamaState("ready");
          setOllamaModels(s.models);
          setInstallMsg("Ollama is running.");
          break;
        }
      }
    } catch (e) {
      setInstallMsg(e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220));
      try {
        await bridge?.shell?.openExternal("https://ollama.com/download");
      } catch {}
    } finally {
      try {
        off?.();
      } catch {}
      setInstalling(false);
      setInstallProgress(null);
    }
  };

  const downloadModel = async () => {
    setPulling(true);
    setPull(null);
    setModelTestMsg("");
    try {
      await pullModel(MEMORY_MODEL, (p) => setPull(p));
      setPull({ status: "Model ready", done: 1, total: 1 });
      setModelTestMsg("Model ready");
      const s = await checkOllama();
      if (s.state === "ready") {
        setOllamaModels(s.models);
        if (hasMemoryModel(s.models)) setMemoryReady(true);
        else setMemoryReady(true);
      } else {
        setMemoryReady(true);
      }
    } catch (e) {
      setModelTestMsg(e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220));
    } finally {
      setPulling(false);
    }
  };

  const testMemoryModel = async () => {
    setModelTestMsg("");
    try {
      const r = await testModel(MEMORY_MODEL);
      setModelTestMsg(`OK · ${r.ms} ms`);
      setMemoryReady(true);
    } catch (e) {
      setModelTestMsg(e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220));
    }
  };

  const saveKeys = async () => {
    if (!keysOk) return;
    if (llmKey.trim()) await setSecret("llm_key", llmKey.trim());
    // ElevenLabs key may already be saved; save what was typed.
    if (elKey.trim()) await setSecret("el_key", elKey.trim());
    try {
      if (provider) localStorage.setItem("vc-provider", provider);
      if (model) localStorage.setItem("vc-model", model);
    } catch {}
    await saveStep("day", { provider, model, memory_model_ready: memoryReady });
    setOnb(3);
  };

  const skipMemory = async () => {
    setMemoryReady(false);
    await saveStep(null, { memory_model_ready: false }).catch(() => {});
  };

  const toggleRec = () => {
    if (recording) {
      stopRec.current?.();
      stopRec.current = null;
      setRecording(false);
      return;
    }
    setDayError(null);
    const stop = startTranscription(
      {
        onFinal: (text) => {
          const t = text.trim();
          if (t) setDayText((cur) => (cur ? `${cur}\n${t}` : t));
        },
        onError: (m) => setDayError(m.slice(0, 220)),
        onEnd: () => {
          stopRec.current = null;
          setRecording(false);
        },
      },
      {},
    );
    if (!stop) {
      setDayError("No microphone available.");
      return;
    }
    stopRec.current = stop;
    setRecording(true);
  };

  const onPickImages = (list: FileList | null) => {
    if (!list) return;
    setDayError(null);
    const next = [...files, ...Array.from(list)];
    if (next.length > MAX_IMAGES) {
      setDayError(`Up to ${MAX_IMAGES} images.`);
      return;
    }
    for (const f of Array.from(list)) {
      const reason = rejectReason(f);
      if (reason) {
        setDayError(reason);
        return;
      }
    }
    setFiles(next);
  };

  async function callDayAnalysis(text: string, imageBlobs: Blob[], prov: string, mod: string, key: string): Promise<unknown> {
    const client = new OpenAI({
      apiKey: key,
      baseURL: PROVIDER_BASE_URL[normalizeProvider(prov)] ?? PROVIDER_BASE_URL.OpenAI,
      dangerouslyAllowBrowser: true,
      defaultHeaders: normalizeProvider(prov) === "Anthropic" ? { "anthropic-dangerous-direct-browser-access": "true" } : undefined,
    });
    const dataUrls: string[] = [];
    for (const b of imageBlobs) dataUrls.push(await blobToDataUrl(b));
    const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [
      { type: "text", text: `${DAY_ANALYSIS_PROMPT}\n\nUsual day:\n${text.slice(0, 4000)}` },
      ...dataUrls.map((u) => ({ type: "image_url" as const, image_url: { url: u } })),
    ];
    const req = (extra: Record<string, unknown>) =>
      client.chat.completions.create({
        model: resolveModelId(mod, prov),
        messages: [{ role: "user", content } as never],
        ...extra,
      } as never);
    let resp;
    try {
      resp = await req({ max_tokens: 1200 });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/max_tokens|max_completion_tokens/i.test(m)) resp = await req({ max_completion_tokens: 1500 });
      else throw e;
    }
    const raw = String(resp.choices[0]?.message?.content ?? "").trim();
    if (!raw) throw new Error("Empty model reply.");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const jsonText = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    return JSON.parse(jsonText);
  }

  const analyzeDay = async () => {
    const text = dayText.trim();
    if (!text && !files.length) {
      setDayError("Describe your day or add a photo first — or Skip.");
      return;
    }
    setAnalyzing(true);
    setDayError(null);
    try {
      let key = llmKey.trim() || (await getSecret("llm_key").catch(() => null))?.trim() || "";
      if (!key) throw new Error("Add your API key first (back in Keys).");
      // Downscale: never send originals. Reject anything still >2MB.
      const downsized: Blob[] = [];
      for (const f of files) {
        const b = await downscaleToJpeg(f);
        downsized.push(b);
      }
      let parsed: unknown = null;
      let lastErr = "";
      let sawValidationIssue = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await callDayAnalysis(attempt === 0 ? text : `${text}\n\nReturn JSON only.`, downsized, provider, model, key);
          const v = validateDayAnalysis(raw);
          if (v.ok) {
            parsed = v.value;
            break;
          }
          sawValidationIssue = true;
          lastErr = v.error;
        } catch (e) {
          lastErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        }
      }
      if (!parsed) {
        if (sawValidationIssue || /JSON|Unexpected|Missing summary|Missing commitments/i.test(lastErr)) {
          throw new Error("I couldn't read the times. Check the commitments on the next page.");
        }
        throw new Error(lastErr ? `Could not read that — ${lastErr} You can continue manually.` : "Could not read that — you can continue manually.");
      }
      const v = parsed as { summary: string; wake_time?: string; sleep_time?: string; preferred_study_hours?: { start: string; end: string }[]; commitments: { name: string; type: string; days_of_week: number[]; start_time: string; end_time: string; notes?: string }[] };
      await saveStep("commitments", {
        about_text: String(v.summary).slice(0, 2000),
      });
      // Persist day prefs now (db facade).
      try {
        const pref = ((await db.preferences.get(1)) ?? ({ id: 1 } as never)) as Record<string, unknown>;
        if (v.wake_time) (pref as Record<string, unknown>).earliest_start_time = v.wake_time;
        if (v.sleep_time) (pref as Record<string, unknown>).latest_end_time = v.sleep_time;
        (pref as Record<string, unknown>).preferred_study_hours = v.preferred_study_hours ?? [];
        await db.preferences.put(pref as never);
        const existing = ((await db.profiles.get("local")) ?? ({ id: "local" } as unknown)) as Record<string, unknown>;
        await db.profiles.put({ ...existing, id: "local", about_text: String(v.summary).slice(0, 2000) } as never);
      } catch {}
      // Prefill commitments: map to v1 kinds, keep originals in notes.
      const numToDay: Record<number, Weekday> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
      setDrafts(
        v.commitments.map((c) => {
          const t = String(c.type ?? "").toLowerCase();
          const kind: CommitmentKind = t === "class" ? "Class" : t === "work" ? "Work" : t === "gym" ? "Gym" : "Other";
          const days = (c.days_of_week ?? []).map((n) => numToDay[n]).filter(Boolean) as Weekday[];
          const orig = String(c.type ?? "");
          const notes = [String(c.notes ?? "").trim(), !["Class", "Work", "Gym", "Other"].includes(String(c.type ?? "")) && orig ? `Original type: ${orig}` : ""]
            .filter(Boolean)
            .join(" · ");
          return { id: crypto.randomUUID(), name: c.name, kind, days: WEEKDAYS.filter((d) => days.includes(d)), start: c.start_time, end: c.end_time, notes };
        }),
      );
      await saveStep("commitments", {});
      setOnb(4);
    } catch (e) {
      setDayError(e instanceof Error ? e.message.slice(0, 280) : String(e).slice(0, 280));
    } finally {
      setAnalyzing(false);
    }
  };

  const skipDay = async () => {
    if (!drafts.length) setDrafts([emptyDraft()]);
    await saveStep("commitments", {});
    setOnb(4);
  };

  const saveCommitments = async () => {
    for (const d of drafts) {
      const v = validateCommitmentDraft(d);
      if (!v.ok) {
        setError(v.error ?? "Check each row.");
        return;
      }
    }
    setError(null);
    setSaving(true);
    try {
      for (const d of drafts) {
        await db.fixed_commitments.put({
          id: d.id,
          name: d.name.trim(),
          type: d.kind,
          days_of_week: d.days.map((w) => WEEKDAY_TO_NUM[w]),
          start_time: d.start,
          end_time: d.end,
          color: null,
          other_label: null,
          notes: d.notes?.trim() || null,
          active_from: null,
          active_until: null,
        } as never);
      }
      await ensureSeed();
      const existing = ((await db.profiles.get("local")) ?? ({ id: "local" } as unknown)) as Record<string, unknown>;
      await db.profiles.put({ ...existing, id: "local", onboarding_done: true, onboarding_step: "done" } as never);
      try {
        localStorage.setItem("vc-onb-done", "1");
        window.dispatchEvent(new Event("vc-profile-update"));
      } catch {}
      onDone("dashboard");
    } finally {
      setSaving(false);
    }
  };

  const providerModels = PROVIDER_MODELS[normalizeProvider(provider)] ?? PROVIDER_MODELS.OpenAI;
  const pullDone = pull && (pull.status === "done" || pull.status === "Model ready");
  const pullPct = pull && pull.total ? (pullDone ? 100 : Math.min(99, Math.round((pull.done / pull.total) * 100))) : pullDone ? 100 : null;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-canvas px-[60px] pt-11 pb-10">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] tracking-wordmark uppercase text-ink">Rocky</div>
        <div className="flex items-center gap-4">
          {onb > 0 && (
            <div className="font-mono text-[10.5px] tracking-tab uppercase text-grey-faint">
              {`Step ${onb} of 4`}
            </div>
          )}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center overflow-y-auto">
        {onb === 0 && (
          <div className="max-w-[720px]">
            <div className="text-[62px] font-medium leading-[1.04] tracking-[-0.03em] text-balance">Your week, planned out loud.</div>
            <div className="mt-[26px] max-w-[470px] text-[17px] leading-[1.55] text-ink-muted text-pretty">
              {usingCloud ? "Tell it what's happening and it keeps the shape of your days for you, on this laptop and your phone." : "Tell it what's happening and it keeps the shape of your days for you. Everything stays on this device."}
            </div>
            <div className="mt-[46px] flex w-[340px] flex-col gap-4">
              <button onClick={goName} className="flex h-12 cursor-pointer items-center justify-center rounded-[4px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
                Get started
              </button>
            </div>
          </div>
        )}

        {onb === 1 && (
          <div className="flex w-full items-center gap-[120px]">
            <div className="max-w-[440px]">
              <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Welcome</div>
              <div className="mt-[22px] text-[44px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">What should Rocky call you?</div>
              <div className="mt-6 text-[16px] leading-[1.55] text-ink-muted text-pretty">Just a display name. You can change it later in Profile.</div>
            </div>
            <div className="flex w-[400px] flex-none flex-col gap-6">
              <label className="flex flex-col gap-[9px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Name</span>
                <input
                  value={auName}
                  onChange={(e) => setAuName(e.target.value)}
                  placeholder="Kai Mercer"
                  className="w-full border-0 border-b border-line-strong bg-transparent py-0 pb-[9px] font-sans text-[17px] text-ink outline-none placeholder:text-grey-ghost"
                />
              </label>
              {error && <div className="font-mono text-[11px] text-red-500">{error}</div>}
              <button onClick={() => void saveName()} className="mt-[6px] flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
                Continue
              </button>
            </div>
          </div>
        )}

        {onb === 2 && (
          <div className="flex w-full items-start gap-[110px]">
            <div className="max-w-[420px]">
              <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Your keys — local only</div>
              <div className="mt-[22px] text-[44px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Add your keys.</div>
              <div className="mt-6 text-[16px] leading-[1.55] text-ink-muted text-pretty">
                AI is always on. Keys are stored only on this device, never sent to Supabase. Test both to continue.
              </div>
              <div className="mt-8 rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Memory (optional)</div>
                <div className="mt-2 text-[15px] font-medium text-ink-soft">Saves what you read on this laptop so you can ask about it later. Stays on this laptop.</div>
                <div className="mt-1 font-mono text-[11px] text-grey">Model {MEMORY_MODEL}, about 2.7 GB.</div>
                <div className="mt-3 flex flex-col gap-2">
                  {ollamaState === "checking" && <div className="font-mono text-[11px] text-grey">Checking for Ollama…</div>}
                  {ollamaState === "cors" && (
                    <div className="font-mono text-[11px] leading-[1.5] text-warm">
                      {ollamaMsg}
                      <div className="mt-2">
                        <button onClick={() => void checkOllamaAgain()} className="cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink">
                          Check again
                        </button>
                      </div>
                    </div>
                  )}
                  {ollamaState === "missing" && (
                    <div className="flex flex-col gap-2">
                      <div className="font-mono text-[11px] text-grey">Ollama isn’t running.</div>
                      <div className="flex gap-2">
                        <button onClick={() => void installOllama()} disabled={installing} className="cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:bg-accent disabled:opacity-60">
                          {installing ? "Installing…" : "Install Ollama"}
                        </button>
                        <button onClick={() => void checkOllamaAgain()} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink">
                          Check again
                        </button>
                      </div>
                      {installProgress !== null && <div className="font-mono text-[11px] text-grey">Downloading… {installProgress}%</div>}
                      {installMsg && <div className="font-mono text-[11px] leading-[1.5] text-grey">{installMsg}</div>}
                    </div>
                  )}
                  {ollamaState === "ready" && (
                    <div className="flex flex-col gap-2">
                      <div className="font-mono text-[11px] text-accent-deep">
                        Ollama running{hasMemoryModel(ollamaModels) || memoryReady ? " · Model ready" : ""}.
                      </div>
                      {!hasMemoryModel(ollamaModels) && !memoryReady && (
                        <button onClick={() => void downloadModel()} disabled={pulling} className="w-fit cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:bg-accent disabled:opacity-60">
                          {pulling ? "Downloading…" : "Download model"}
                        </button>
                      )}
                      {pull && (
                        <div className="flex flex-col gap-1">
                          <div className="h-[6px] w-full overflow-hidden rounded-full bg-line-strong">
                            <div className="h-full bg-accent transition-all" style={{ width: `${pullPct ?? 0}%` }} />
                          </div>
                          <div className="font-mono text-[10.5px] text-grey">
                            {pull.status}
                            {pullPct !== null ? ` · ${pullPct}%` : ""}
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button onClick={() => void testMemoryModel()} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink">
                          Test model
                        </button>
                        <button onClick={() => void checkOllamaAgain()} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink">
                          Check again
                        </button>
                      </div>
                      {modelTestMsg && <div className="font-mono text-[11px] text-grey">{modelTestMsg}</div>}
                    </div>
                  )}
                  <button onClick={() => void skipMemory()} className="w-fit cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink">
                    Set up later in Memory
                  </button>
                </div>
              </div>
            </div>
            <div className="flex w-[420px] flex-none flex-col gap-[26px]">
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Provider</span>
                <select
                  value={provider}
                  onChange={(e) => {
                    const p = normalizeProvider(e.target.value);
                    setProvider(p);
                    setModel(defaultModelFor(p));
                    // Keys are per-provider: never carry one across providers.
                    setLlmKey("");
                    setLlmTest(null);
                  }}
                  className="h-[46px] w-full cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-card px-[14px] font-sans text-[15px] text-ink outline-none"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Model</span>
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setLlmTest(null);
                  }}
                  className="h-[46px] w-full cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-card px-[14px] font-sans text-[15px] text-ink outline-none"
                >
                  {providerModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">API key</span>
                <div className="flex items-center gap-3 border-b border-line-strong pb-[9px]">
                  <input
                    type={llmKeyShown ? "text" : "password"}
                    value={llmKey}
                    onChange={(e) => {
                      setLlmKey(e.target.value);
                      setLlmTest(null);
                    }}
                    placeholder="Paste your API key"
                    className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[14px] text-ink outline-none placeholder:text-grey-ghost"
                  />
                  <button onClick={() => setLlmKeyShown((v) => !v)} className="flex-none cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink">
                    {llmKeyShown ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void runLlmTest()} disabled={llmTesting || !llmKey.trim() || !model} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60">
                    {llmTesting ? "Testing…" : "Test key"}
                  </button>
                  {llmTest && <span className={`font-mono text-[11px] leading-[1.5] ${llmTest.ok ? "text-accent-deep" : "text-warm"}`}>{llmTest.message}</span>}
                </div>
              </div>
              <div className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">ElevenLabs key (required — voice-first app)</span>
                <div className="flex items-center gap-3 border-b border-line-strong pb-[9px]">
                  <input
                    type={elKeyShown ? "text" : "password"}
                    value={elKey}
                    onChange={(e) => {
                      setElKey(e.target.value);
                      setElTest(null);
                    }}
                    placeholder="Paste your ElevenLabs key"
                    className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[14px] text-ink outline-none placeholder:text-grey-ghost"
                  />
                  <button onClick={() => setElKeyShown((v) => !v)} className="flex-none cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink">
                    {elKeyShown ? "Hide" : "Show"}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void runElTest()} disabled={elTesting} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60">
                    {elTesting ? "Testing…" : "Test key"}
                  </button>
                  {elTest && <span className={`font-mono text-[11px] leading-[1.5] ${elTest.ok ? "text-accent-deep" : "text-warm"}`}>{elTest.message}</span>}
                </div>
              </div>
              <button
                onClick={() => void saveKeys()}
                disabled={!keysOk}
                className={`flex h-12 cursor-pointer items-center justify-center rounded-[3px] text-[15px] font-medium ${keysOk ? "bg-ink text-canvas hover:bg-accent" : "cursor-not-allowed bg-line-strong text-grey-mid"}`}
              >
                Continue
              </button>
              {!keysOk && <div className="font-mono text-[10.5px] text-grey-soft">Test both keys to continue.</div>}
            </div>
          </div>
        )}

        {onb === 3 && (
          <div className="flex w-full items-start gap-[110px]">
            <div className="max-w-[420px]">
              <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Your day</div>
              <div className="mt-[22px] text-[44px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Tell Rocky what a usual day looks like.</div>
              <div className="mt-6 text-[16px] leading-[1.55] text-ink-muted text-pretty">
                Images are NOT stored anywhere; only the extracted result is saved. You can skip — the next page starts empty.
              </div>
            </div>
            <div className="flex w-[460px] flex-none flex-col gap-[18px]">
              <label className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Usual day</span>
                <textarea
                  value={dayText}
                  onChange={(e) => setDayText(e.target.value)}
                  placeholder="I wake at 7, classes Mon/Wed/Fri 9–12, gym Tue/Thu evenings…"
                  className="box-border min-h-[140px] w-full resize-y rounded-[3px] border border-line-strong bg-card px-[14px] py-[12px] font-sans text-[15px] leading-[1.6] text-ink outline-none"
                />
              </label>
              <div className="flex items-center gap-2">
                <button onClick={toggleRec} className={`cursor-pointer rounded-[3px] px-4 py-2 font-mono text-[10px] tracking-[0.14em] uppercase ${recording ? "bg-accent text-canvas" : "border border-line-strong text-grey hover:border-ink hover:text-ink"}`}>
                  {recording ? "Stop" : "Dictate"}
                </button>
                <span className="font-mono text-[10.5px] text-grey-soft">Tap Dictate and speak — you can edit the text after.</span>
              </div>
              <div className="flex flex-col gap-[10px]">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Photos (optional, up to 5)</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(e) => {
                    onPickImages(e.target.files);
                    e.target.value = "";
                  }}
                  className="hidden"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:bg-accent"
                  >
                    Add photos
                  </button>
                  <span className="font-mono text-[10.5px] text-grey-soft">{files.length ? `${files.length} selected` : "No photos yet"}</span>
                </div>
                <div className="font-mono text-[10.5px] text-grey-soft">PNG/JPG/WebP, 8 MB each max. Resized before sending; rejected if still over ~2 MB. HEIC not supported.</div>
                {previews.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {previews.map((u, i) => (
                      <div key={u} className="relative h-[64px] w-[64px] overflow-hidden rounded-[3px] border border-line">
                        <img src={u} alt="" className="h-full w-full object-cover" />
                        <button
                          onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                          className="absolute right-1 top-1 cursor-pointer rounded-full bg-ink px-1.5 font-mono text-[10px] text-canvas"
                          aria-label="Remove image"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {dayError && <div className="font-mono text-[11px] leading-[1.5] text-warm">{dayError}</div>}
              <div className="flex gap-3">
                <button onClick={() => void analyzeDay()} disabled={analyzing} className="flex flex-1 cursor-pointer items-center justify-center rounded-[3px] bg-ink py-3 text-[15px] font-medium text-canvas hover:bg-accent disabled:opacity-60">
                  {analyzing ? "Analyzing…" : "Analyze my day"}
                </button>
                <button onClick={() => void skipDay()} className="cursor-pointer rounded-[3px] border border-line-strong px-5 py-3 font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:border-ink hover:text-ink">
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

        {onb === 4 && (
          <div className="flex w-full items-start gap-[110px]">
            <div className="max-w-[420px]">
              <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Commitments</div>
              <div className="mt-[22px] text-[44px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Lock in what never moves.</div>
              <div className="mt-6 text-[16px] leading-[1.55] text-ink-muted text-pretty">Prefilled from your day. End must be after start, at least one day each.</div>
            </div>
            <div className="flex w-[480px] flex-none flex-col gap-3">
              {drafts.map((d) => {
                const v = validateCommitmentDraft(d);
                return (
                  <div key={d.id} className="rounded-[3px] border border-line bg-card px-[15px] py-3">
                    <div className="flex gap-2">
                      <input value={d.name} onChange={(e) => setDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, name: e.target.value } : x)))} placeholder="Name" className="min-w-0 flex-1 border-0 border-b border-line-strong bg-transparent pb-1 font-sans text-[15px] text-ink outline-none" />
                      <select value={d.kind} onChange={(e) => setDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, kind: e.target.value as CommitmentKind } : x)))} className="cursor-pointer rounded-[3px] border border-line-strong bg-panel px-2 py-1 font-mono text-[12px]">
                        {(["Class", "Work", "Gym", "Other"] as CommitmentKind[]).map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                      <button onClick={() => setDrafts((cur) => (cur.length <= 1 ? cur : cur.filter((x) => x.id !== d.id)))} className="cursor-pointer font-mono text-[12px] text-grey-mid hover:text-ink" aria-label="Remove row">
                        ×
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {WEEKDAYS.map((w) => {
                        const on = d.days.includes(w);
                        return (
                          <button
                            key={w}
                            onClick={() => setDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, days: on ? x.days.filter((y) => y !== w) : [...x.days, w] } : x)))}
                            className={`cursor-pointer rounded-full border px-2 py-1 font-mono text-[10px] tracking-[0.1em] uppercase ${on ? "border-ink bg-ink text-canvas" : "border-line-strong text-grey-mid"}`}
                          >
                            {w.slice(0, 2)}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input type="time" value={d.start} onChange={(e) => setDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, start: e.target.value } : x)))} className="border-0 border-b border-line-strong bg-transparent pb-1 font-mono text-[14px] outline-none" />
                      <span className="font-mono text-[12px] text-grey">→</span>
                      <input type="time" value={d.end} onChange={(e) => setDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, end: e.target.value } : x)))} className="border-0 border-b border-line-strong bg-transparent pb-1 font-mono text-[14px] outline-none" />
                    </div>
                    {!v.ok && <div className="mt-1 font-mono text-[10.5px] text-red-500">{v.error}</div>}
                  </div>
                );
              })}
              <button onClick={() => setDrafts((cur) => [...cur, emptyDraft()])} className="w-fit cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink">
                + Add row
              </button>
              {error && <div className="font-mono text-[11px] text-red-500">{error}</div>}
              <button onClick={() => void saveCommitments()} disabled={saving} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent disabled:opacity-60">
                {saving ? "Saving…" : "Save and go to dashboard"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex h-[22px] items-center justify-between gap-6">
        {onb > 0 ? (
          <div className="flex items-center gap-[9px]">
            {dots.map((d, i) => (
              <div key={i} className="h-[6px] w-[6px] rounded-full border" style={{ background: d.bg, borderColor: d.border }} />
            ))}
          </div>
        ) : (
          <div />
        )}
        <div className="font-mono text-[10.5px] tracking-tab uppercase text-grey-faint">{onb > 0 ? `Step ${onb} of 4` : ""}</div>
      </div>
    </div>
  );
}
