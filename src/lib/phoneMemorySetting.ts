/**
 * "Allow Memory questions from my phone" (laptop Profile → Devices and the
 * phone's settings sheet), on by default. Lives in the profile row's `extra`
 * (`phone_memory_questions`) so both devices see the same switch. No
 * migration. The laptop enforces it: when off it refuses relayed questions.
 */
import { db } from "./db";

let cached: boolean | null = null;

export const phoneMemoryAllowed = () => cached ?? true;

export async function loadPhoneMemoryAllowed(): Promise<boolean> {
  try {
    const p = (await db.profiles.get("local")) as unknown as { phone_memory_questions?: boolean } | undefined;
    cached = p?.phone_memory_questions !== false;
  } catch {
    /* keep the last value */
  }
  return phoneMemoryAllowed();
}

export async function setPhoneMemoryAllowed(on: boolean): Promise<void> {
  cached = on;
  const p = ((await db.profiles.get("local")) ?? { id: "local" }) as unknown as Record<string, unknown>;
  await db.profiles.put({ ...p, id: "local", phone_memory_questions: on } as never);
}
