/**
 * The Dashboard chat's history, on this device only.
 *
 * A separate local Dexie database (never the Supabase facade in db.ts): the
 * chat holds Memory answers, which must never leave the laptop. Keeps the
 * last MAX_MESSAGES; "Clear chat" empties it.
 */
import Dexie, { type Table } from "dexie";
import type { AssistantTurn } from "../types";

export const MAX_MESSAGES = 200;

class ChatDB extends Dexie {
  messages!: Table<AssistantTurn & { at: number }, string>;
  constructor() {
    super("RockyChat");
    this.version(1).stores({ messages: "id, at" });
  }
}

let local: ChatDB | null = null;
const store = () => (local ??= new ChatDB());

export async function loadChat(): Promise<AssistantTurn[]> {
  try {
    const rows = await store().messages.orderBy("at").reverse().limit(MAX_MESSAGES).toArray();
    return rows.reverse();
  } catch {
    return [];
  }
}

export async function saveTurn(turn: AssistantTurn): Promise<void> {
  try {
    const s = store();
    await s.messages.put({ ...turn, at: turn.at ?? Date.now() });
    const count = await s.messages.count();
    if (count > MAX_MESSAGES) {
      const old = await s.messages.orderBy("at").limit(count - MAX_MESSAGES).primaryKeys();
      await s.messages.bulkDelete(old);
    }
  } catch {
    /* history is a convenience; the chat keeps working without it */
  }
}

/** Should this turn be written to the device's history? Private turns only where allowed. */
export function shouldPersist(turn: Pick<AssistantTurn, "private">, keepPrivate: boolean): boolean {
  return keepPrivate || !turn.private;
}

export async function deleteTurn(id: string): Promise<void> {
  try {
    await store().messages.delete(id);
  } catch {
    /* nothing stored */
  }
}

export async function clearChat(): Promise<void> {
  try {
    await store().messages.clear();
  } catch {
    /* nothing stored */
  }
}
