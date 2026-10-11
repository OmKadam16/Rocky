/**
 * Desktop: "Check automatically on start and every 6 hours, download in the
 * background, ask before restarting" — on by default. Profile extra
 * (`desktop_auto_update`), no migration. The main process does the work
 * (update:auto); the restart is always the user's press.
 */
import { db } from "./db";

let cached: boolean | null = null;
export const autoUpdateOn = () => cached ?? true;

export async function loadAutoUpdate(): Promise<boolean> {
  try {
    const p = (await db.profiles.get("local")) as unknown as { desktop_auto_update?: boolean } | undefined;
    cached = p?.desktop_auto_update !== false;
  } catch {
    /* keep the default */
  }
  return autoUpdateOn();
}

export async function setAutoUpdate(on: boolean): Promise<void> {
  cached = on;
  const p = ((await db.profiles.get("local")) ?? { id: "local" }) as unknown as Record<string, unknown>;
  await db.profiles.put({ ...p, id: "local", desktop_auto_update: on } as never);
  applyAutoUpdate(on);
}

type UpdatesBridge = { auto?: (on: boolean) => Promise<unknown> };
/** Tell the main process (desktop only; a no-op elsewhere). */
export function applyAutoUpdate(on: boolean): void {
  const u = (typeof window !== "undefined" ? (window as unknown as { rocky?: { updates?: UpdatesBridge } }).rocky?.updates : undefined) ?? null;
  void u?.auto?.(on).catch(() => {});
}
