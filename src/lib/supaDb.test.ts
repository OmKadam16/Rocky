import { describe, expect, it } from "vitest";
import { fromDbRow, TABLES, toDbRow } from "./supaDb";

const UID = "00000000-0000-0000-0000-00000000000a";

describe("supaDb row mapping", () => {
  it("puts known fields in columns and keeps unknown ones in extra", () => {
    const row = toDbRow(TABLES.tasks, { id: "t1", name: "Essay", status: "pending", parts: [{ n: 1 }], undefinedField: undefined }, UID);
    expect(row).toEqual({ user_id: UID, id: "t1", name: "Essay", status: "pending", extra: { parts: [{ n: 1 }] } });
  });

  it("never sends API keys to the server", () => {
    const row = toDbRow(TABLES.profiles, { id: "local", display_name: "Om", llm_key_enc: "sk-secret", el_key_enc: "el-secret" }, UID);
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(row).toEqual({ user_id: UID, id: "local", display_name: "Om", extra: {} });
  });

  it("ignores server-owned fields on write", () => {
    const row = toDbRow(TABLES.tasks, { id: "t1", name: "x", user_id: "someone-else", extra: { a: 1 }, updated_at: "now" }, UID);
    expect(row.user_id).toBe(UID);
    expect(row.extra).toEqual({});
  });

  it("round-trips a block including extra fields and v1 ids", () => {
    const db = toDbRow(TABLES.scheduled_blocks, { id: "b1", source_type: "event", source_id: null, title: "Gym", date: "2026-10-12", start_time: "19:00", end_time: "20:00", previous_start_time: null, created_at: "2026-10-10T00:00:00Z", color: "blue" }, UID);
    const back = fromDbRow(TABLES.scheduled_blocks, { ...db, updated_at: "x" });
    expect(back).toEqual({ id: "b1", source_type: "event", source_id: null, title: "Gym", date: "2026-10-12", start_time: "19:00", end_time: "20:00", previous_start_time: null, created_at: "2026-10-10T00:00:00Z", color: "blue" });
  });

  it("restores v1's single-row ids for profiles and preferences", () => {
    expect(fromDbRow(TABLES.profiles, { user_id: UID, display_name: "Om", extra: {} })).toEqual({ id: "local", display_name: "Om" });
    expect(fromDbRow(TABLES.preferences, { user_id: UID, earliest_start_time: "07:00", extra: null })).toEqual({ id: 1, earliest_start_time: "07:00" });
  });
});
