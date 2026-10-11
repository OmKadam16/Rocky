/**
 * Renderer side of Memory: a typed wrapper over the desktop bridge
 * (electron/memoryMain.cjs). Memory content only ever moves between this
 * app's renderer and its own main process; nothing here talks to a network.
 */
import type { MemorySource } from "../types";

export type MemorySettings = {
  enabled: boolean;
  paused: boolean;
  excluded: string[];
  sizeCapMB: number;
  /** Fold digests older than 12 months into one overview per year. Off by default. */
  keepShrinking: boolean;
  port: number;
  token: string;
};

export type Compaction = { month: string; status: string; entries: number; digests: number; bytesBefore: number; bytesAfter: number; at: number };

export type MemoryStatus = {
  available: true;
  settings: MemorySettings;
  stats: {
    count: number;
    bytes: number;
    bytesByPart: { inbox: number; memories: number; vectors: number; backups: number; live: number; total: number };
    oldest: number | null;
    newest: number | null;
    tiers: { detail: number; digests: number; overviews: number };
    /** Pages waiting to be gisted, and raw pages dropped over the queue cap. */
    queue: number;
    dropped: number;
  };
  server: { running: boolean; port: number; error: string | null };
  extensionId: string;
  embedModel: string;
  /** "hybrid" with the embedding model, "keyword" without it. */
  search: "hybrid" | "keyword";
  lastCompaction: Compaction | null;
  lastRun: number | null;
  nextCompaction: number;
  undoable: string[];
  timings: { gist_ms: number | null; embed_ms: number | null; compaction_ms: number | null };
};

/** One memory as the Memory page shows it (never raw text or vectors). */
export type MemoryItem = {
  id: number;
  /** 0 detail, 1 monthly digest, 2 month overview, 3 year overview. */
  tier: number;
  kind: string;
  title: string;
  gist: string;
  keyPoints: string[];
  topics: string[];
  urls: { url: string; title: string; at?: number }[];
  domains: string[];
  firstSeen: number;
  lastSeen: number;
  visits: number;
  minutes: number;
  pinned: boolean;
  importance: number;
  month: string;
  sources: { title: string; url: string; date: number }[];
  highlights: { title: string; gist: string; url: string; date: number }[];
  entries: number | null;
  paper: { authors: string[]; venue: string; year: string; doi: string | null; arxiv: string | null } | null;
};

export type MemoryMonth = { month: string; detail: number; digests: number; overviews: number; compaction: Compaction | null; current: boolean };

export type MemoryAnswer = { status: "answered" | "none" | "off" | "unavailable"; answer: string; sources: MemorySource[] };

type Bridge = {
  status: () => Promise<MemoryStatus>;
  set: (patch: Partial<MemorySettings> & { rotateToken?: boolean }) => Promise<MemoryStatus>;
  list: (opts: { q?: string; month?: string; limit?: number; offset?: number }) => Promise<MemoryItem[]>;
  months: () => Promise<MemoryMonth[]>;
  remove: (id: number) => Promise<boolean>;
  removeMonth: (month: string) => Promise<boolean>;
  pin: (id: number, pinned: boolean) => Promise<boolean>;
  compactNow: () => Promise<{ results?: { month: string; status: string; entries: number; digests: number; bytesBefore: number; bytesAfter: number }[]; busy?: boolean; off?: boolean; error?: boolean }>;
  undo: (month: string) => Promise<{ ok: boolean; reason?: string }>;
  busy: (on: boolean) => Promise<boolean>;
  clear: () => Promise<boolean>;
  ask: (question: string) => Promise<MemoryAnswer>;
  open: (url: string) => Promise<boolean>;
};

export const memoryBridge = (): Bridge | null =>
  (typeof window !== "undefined" && (window as unknown as { rocky?: { memory?: Bridge } }).rocky?.memory) || null;

export const DESKTOP_ONLY = "Memory lives in the Rocky desktop app on your laptop.";

/** Ask Memory; never throws. Off the desktop app it says so plainly. */
export async function askMemory(question: string): Promise<MemoryAnswer> {
  const b = memoryBridge();
  if (!b) return { status: "unavailable", answer: DESKTOP_ONLY, sources: [] };
  try {
    return await b.ask(question);
  } catch {
    return { status: "unavailable", answer: "Memory didn't answer. Try again in a moment.", sources: [] };
  }
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
