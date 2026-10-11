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
  retentionDays: number;
  sizeCapMB: number;
  port: number;
  token: string;
};

export type MemoryStatus = {
  available: true;
  settings: MemorySettings;
  stats: { count: number; bytes: number; oldest: number | null; newest: number | null };
  server: { running: boolean; port: number; error: string | null };
  extensionId: string;
};

export type SavedPage = { id: number; url: string; title: string; domain: string; capturedAt: number };

export type MemoryAnswer = { status: "answered" | "none" | "off" | "unavailable"; answer: string; sources: MemorySource[] };

type Bridge = {
  status: () => Promise<MemoryStatus>;
  set: (patch: Partial<MemorySettings> & { rotateToken?: boolean }) => Promise<MemoryStatus>;
  list: (opts: { q?: string; limit?: number; offset?: number }) => Promise<SavedPage[]>;
  remove: (id: number) => Promise<boolean>;
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
