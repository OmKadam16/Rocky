/**
 * The planner's model list — all four providers via OpenAI-compatible endpoints.
 *
 * OpenAI is the only provider used right now (verified). Gemini / Anthropic /
 * Grok ids are included for selection but marked untested until verified against
 * each provider's docs at build time — the picker labels them as such.
 *
 * Gemini notes (Oct 2026): Google gates the 2.5 models to past users, so new
 * work targets 3.5 Flash-Lite / 3.5 Flash via the Interactions API.
 * Flash-Lite is the low-token default (cheap first passes, classification);
 * 3.5 Flash carries the Computer Use preview for browser-agent work.
 * Never put a Gemini key in a VITE_ variable or in code — it ships to the
 * browser. The key lives as a Supabase secret (Om sets it in the dashboard).
 *
 * `id` is what the API is given; `label` is what the user sees. Earlier builds
 * stored the label in the profile and sent that as the model, which the API
 * rejects — resolveModelId exists to undo that.
 */

export type Provider = { id: string; label: string; soon: boolean };
export type Model = { id: string; label: string; tested: boolean };

/**
 * gpt-4o, not the mini. The planner lives or dies on tool calling, and the
 * mini skips tools and narrates the action instead often enough to matter —
 * which leaves the user with a calendar that disagrees with what it just told
 * them. Mini is still selectable for anyone who wants the cheaper turn.
 */
export const DEFAULT_PROVIDER = "OpenAI";
export const DEFAULT_MODEL = "gpt-4o";

export const PROVIDERS: Provider[] = [
  { id: "OpenAI", label: "OpenAI", soon: false },
  { id: "Gemini", label: "Gemini", soon: false },
  { id: "Anthropic", label: "Anthropic", soon: false },
  { id: "Grok", label: "Grok", soon: false },
];

export const PROVIDER_BASE_URL: Record<string, string> = {
  OpenAI: "https://api.openai.com/v1",
  Gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  Anthropic: "https://api.anthropic.com/v1/",
  Grok: "https://api.x.ai/v1",
};

export const PROVIDER_MODELS: Record<string, Model[]> = {
  OpenAI: [
    { id: "gpt-4o", label: "GPT-4o", tested: true },
    { id: "gpt-4o-mini", label: "GPT-4o mini", tested: true },
    { id: "gpt-4.1", label: "GPT-4.1", tested: true },
  ],
  Gemini: [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (untested)", tested: false },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (untested)", tested: false },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (untested)", tested: false },
  ],
  Anthropic: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (untested)", tested: false },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1 (untested)", tested: false },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (untested)", tested: false },
  ],
  Grok: [
    { id: "grok-4", label: "Grok 4 (untested)", tested: false },
    { id: "grok-4-fast", label: "Grok 4 Fast (untested)", tested: false },
  ],
};

/** Back-compat: routines that only knew OpenAI. */
export const OPENAI_MODELS: Model[] = PROVIDER_MODELS.OpenAI;

export function normalizeProvider(stored: string | null | undefined): string {
  const v = (stored ?? "").trim();
  const hit = PROVIDERS.find((p) => p.id.toLowerCase() === v.toLowerCase());
  return hit ? hit.id : DEFAULT_PROVIDER;
}

export function defaultModelFor(provider: string): string {
  const list = PROVIDER_MODELS[normalizeProvider(provider)] ?? PROVIDER_MODELS.OpenAI;
  return list[0]?.id ?? DEFAULT_MODEL;
}

/**
 * Whatever is in the profile -> a model id the API will accept.
 * Accepts an id, a legacy display label, or junk; junk falls back to the
 * provider default rather than failing the turn.
 */
export function resolveModelId(stored: string | null | undefined, provider?: string | null): string {
  const value = (stored ?? "").trim();
  const prov = normalizeProvider(provider ?? DEFAULT_PROVIDER);
  const list = PROVIDER_MODELS[prov] ?? PROVIDER_MODELS.OpenAI;
  if (!value) return list[0]?.id ?? DEFAULT_MODEL;
  const byId = list.find((m) => m.id.toLowerCase() === value.toLowerCase());
  if (byId) return byId.id;
  const byLabel = list.find((m) => m.label.toLowerCase() === value.toLowerCase());
  if (byLabel) return byLabel.id;
  // Legacy: user stored an OpenAI id/label while on another provider.
  const legacyOpen = OPENAI_MODELS.find(
    (m) => m.id.toLowerCase() === value.toLowerCase() || m.label.toLowerCase() === value.toLowerCase(),
  );
  if (legacyOpen) return prov === "OpenAI" ? legacyOpen.id : list[0]?.id ?? DEFAULT_MODEL;
  return list[0]?.id ?? DEFAULT_MODEL;
}

export const modelLabel = (id: string, provider?: string | null): string => {
  const prov = provider ? normalizeProvider(provider) : null;
  if (prov) {
    const hit = (PROVIDER_MODELS[prov] ?? []).find((m) => m.id === id);
    if (hit) return hit.label;
  }
  for (const list of Object.values(PROVIDER_MODELS)) {
    const hit = list.find((m) => m.id === id);
    if (hit) return hit.label;
  }
  return id;
};
