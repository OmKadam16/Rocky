export const OLLAMA_BASE = "http://localhost:11434";
export const MEMORY_MODEL = "qwen3.5:2b";
/** Local embedding model for Memory search (electron/memoryVectors.cjs keeps the same name). */
export const EMBED_MODEL = "nomic-embed-text";

export type OllamaStatus =
  | { state: "ready"; models: string[] }
  | { state: "not-running" }
  | { state: "cors-blocked" };

/**
 * Distinguish "not installed / not running" from "blocked by browser CORS".
 * fetch() to localhost fails with TypeError in both cases; a no-cors retry
 * yields an opaque response iff the port actually answers.
 */
export async function checkOllama(base = OLLAMA_BASE): Promise<OllamaStatus> {
  try {
    const r = await fetch(`${base}/api/tags`, { method: "GET" });
    if (!r.ok) return { state: "not-running" };
    const data = (await r.json().catch(() => null)) as { models?: { name?: string }[] } | null;
    const models = Array.isArray(data?.models) ? data!.models!.map((m) => String(m?.name ?? "")).filter(Boolean) : [];
    return { state: "ready", models };
  } catch {
    // Possibly CORS-blocked while Ollama is actually up. no-cors gives opaque on success.
    try {
      const probe = await fetch(`${base}/api/tags`, { method: "GET", mode: "no-cors" });
      if (probe && (probe.type === "opaque" || probe.ok)) {
        return { state: "cors-blocked" };
      }
    } catch {}
    return { state: "not-running" };
  }
}

export function hasMemoryModel(models: string[], want = MEMORY_MODEL): boolean {
  const w = want.toLowerCase();
  return models.some((m) => {
    const n = m.toLowerCase();
    return n === w || n.startsWith(`${w}:`) || n.startsWith(w);
  });
}

export type PullProgress = { status: string; done: number; total: number };

/** POST /api/pull {model, stream:true} — parse NDJSON {status,total,completed} for a real progress bar. */
export async function pullModel(
  model = MEMORY_MODEL,
  onProgress?: (p: PullProgress) => void,
  base = OLLAMA_BASE,
): Promise<void> {
  const resp = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!resp.ok) {
    const t = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`Download failed (${resp.status}). ${t}`.slice(0, 240));
  }
  if (!resp.body) {
    onProgress?.({ status: "downloading", done: 1, total: 1 });
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t) as { status?: string; total?: number; completed?: number; error?: string };
        if (j.error) throw new Error(j.error.slice(0, 200));
        onProgress?.({ status: j.status ?? "downloading", done: Number(j.completed ?? 0), total: Number(j.total ?? 0) });
      } catch (e) {
        if (e instanceof Error && /Download failed|error/i.test(e.message)) throw e;
        // Ignore keepalive/partial lines.
      }
    }
    await pump();
  };
  await pump();
  onProgress?.({ status: "done", done: 1, total: 1 });
}

/** Tiny /api/generate to prove the model answers. Returns ms taken. */
export async function testModel(model = MEMORY_MODEL, base = OLLAMA_BASE): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  const resp = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "Say OK.", stream: false }),
  });
  if (!resp.ok) {
    const t = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`Model test failed (${resp.status}). ${t}`.slice(0, 240));
  }
  await resp.json().catch(() => null);
  return { ok: true, ms: Date.now() - t0 };
}

export function isDesktop(): boolean {
  try {
    return Boolean((window as unknown as { rocky?: { isDesktop?: boolean } }).rocky?.isDesktop);
  } catch {
    return false;
  }
}
