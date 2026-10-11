/**
 * Booking evidence, kept on this laptop only.
 *
 * A separate local Dexie database (never the Supabase facade in db.ts), so the
 * final screenshot and confirmation text can never sync to the cloud. Nothing
 * here touches the Supabase schema.
 */
import Dexie, { type Table } from "dexie";

export type BookingRecord = {
  id: string;
  created_at: string;
  status: "booked" | "unclear" | "failed" | "cancelled";
  type: string;
  venue: string;
  date: string;
  time: string;
  reference: string | null;
  confirmation_text: string;
  url: string;
  /** Final page screenshot (PNG data URL). Local only. */
  screenshot: string | null;
  hold_block_id: string | null;
  reason?: string;
};

class BookingRecordsDB extends Dexie {
  records!: Table<BookingRecord, string>;
  constructor() {
    super("RockyBookingRecords");
    this.version(1).stores({ records: "id, created_at, status, hold_block_id" });
  }
}

let local: BookingRecordsDB | null = null;
const store = () => (local ??= new BookingRecordsDB());

export async function saveBookingRecord(r: Omit<BookingRecord, "id" | "created_at">): Promise<string | null> {
  try {
    const id = `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await store().records.put({ ...r, id, created_at: new Date().toISOString() });
    return id;
  } catch {
    return null; // IndexedDB unavailable: the calendar note still carries the reference
  }
}

export async function recentBookingRecords(limit = 20): Promise<BookingRecord[]> {
  try {
    return await store().records.orderBy("created_at").reverse().limit(limit).toArray();
  } catch {
    return [];
  }
}
