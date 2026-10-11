/**
 * The Memory relay over Supabase `commands` rows (RLS "own rows only"). The
 * protocol itself is in memoryRelay.ts; this binds it to the live client.
 */
import { supabase, uniqueChannel } from "./supabase";
import { readLaptopLastSeen } from "./devices";
import { askMemoryOnLaptop, handleMemoryRequest, MEMORY_REQUEST_MARK, purgeMemoryRows, RELAY_NOTE, type MemoryCard, type RelayRow, type RelayStore } from "./memoryRelay";
import { loadPhoneMemoryAllowed } from "./phoneMemorySetting";

export function supabaseRelayStore(): RelayStore {
  const sb = () => supabase();
  return {
    async insertRequest(question) {
      const { data, error } = await sb()
        .from("commands")
        .insert({ source: "phone", kind: "text", text: MEMORY_REQUEST_MARK, status: "queued", diff: { question } })
        .select("id")
        .single();
      return error || !data ? null : (data as { id: string }).id;
    },
    async readRow(id) {
      const { data } = await sb().from("commands").select("id,status,reply_text,error,created_at").eq("id", id).maybeSingle();
      return (data as RelayRow | null) ?? null;
    },
    async answer(id, patch) {
      await sb().from("commands").update(patch).eq("id", id);
    },
    async deleteRow(id) {
      await sb().from("commands").delete().eq("id", id);
    },
    async purgeBefore(beforeIso) {
      await sb().from("commands").delete().eq("text", MEMORY_REQUEST_MARK).lt("created_at", beforeIso);
    },
    async queued() {
      const { data } = await sb().from("commands").select("id,status,reply_text,error,created_at,diff").eq("text", MEMORY_REQUEST_MARK).eq("status", "queued");
      return (data as RelayRow[] | null) ?? [];
    },
  };
}

let noteShown = false;

/** Phone: ask the laptop's Memory. The first relayed card carries the note. */
export async function askMemoryRelayed(question: string): Promise<MemoryCard> {
  const c = await askMemoryOnLaptop(question, {
    store: supabaseRelayStore(),
    laptopLastSeen: async () => (await readLaptopLastSeen())?.lastSeenMs ?? null,
  });
  const out: MemoryCard = { ...c, relayed: true };
  if (!noteShown && c.status === "answered") {
    noteShown = true;
    out.note = RELAY_NOTE;
  }
  return out;
}

/** Laptop (desktop app): answer relayed Memory questions; purge old rows. */
export function startMemoryRelayHost(ask: (question: string) => Promise<MemoryCard>): () => void {
  const sb = supabase();
  const store = supabaseRelayStore();
  const seen = new Set<string>();
  const handle = (row: RelayRow & { text?: string; source?: string }) => {
    if (row.text !== undefined && row.text !== MEMORY_REQUEST_MARK) return;
    if (seen.has(row.id)) return;
    seen.add(row.id);
    void handleMemoryRequest(row, { store, ask, allowed: () => loadPhoneMemoryAllowed() }).catch(() => {});
  };
  const channel = sb
    .channel(uniqueChannel("rocky-memory-host"))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "commands", filter: "source=eq.phone" }, (p) => handle(p.new as RelayRow & { text?: string }))
    .subscribe();
  void purgeMemoryRows(store).then(async () => {
    for (const r of await store.queued().catch(() => [])) handle(r);
  });
  const timer = window.setInterval(() => void purgeMemoryRows(store), 60_000);
  return () => {
    window.clearInterval(timer);
    void sb.removeChannel(channel);
  };
}
