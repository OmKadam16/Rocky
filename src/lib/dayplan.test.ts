import { describe, expect, it } from "vitest";
import type { PreferencesRow } from "../../shared/db";
import { defaultDurationFor, middleSlot } from "./scheduling";
import { partOfDayIn } from "./availability";

const MONDAY = "2026-10-12";

const prefs: PreferencesRow = {
  id: 1,
  earliest_start_time: "07:00",
  latest_end_time: "22:00",
  buffer_minutes_after_fixed_events: 15,
  preferred_study_hours: [],
};

const world = (blocks: { start_time: string; end_time: string }[] = [], commitments: any[] = []) => ({
  prefs,
  commitments: commitments as any,
  blocks: blocks.map((b, i) => ({
    id: `b${i}`,
    source_type: "event",
    source_id: null,
    title: `block ${i}`,
    date: MONDAY,
    previous_start_time: null,
    created_at: new Date().toISOString(),
    ...b,
  })) as any,
});

describe("middleSlot", () => {
  it("centers an hour in a 6–10 window (clamped to the 07:00 earliest start)", () => {
    const slot = middleSlot(MONDAY, { durationMinutes: 60, lowerMinutes: 360, upperMinutes: 600 }, world());
    expect(slot).toMatchObject({ date: MONDAY, start_time: "08:00", end_time: "09:00" });
  });

  it("nudges outward when the middle is busy", () => {
    const slot = middleSlot(
      MONDAY,
      { durationMinutes: 60, lowerMinutes: 360, upperMinutes: 600 },
      world([{ start_time: "07:00", end_time: "09:00" }]),
    );
    expect(slot).not.toBeNull();
    const s = slot!;
    expect(s.start_time >= "06:00" && s.end_time <= "10:00").toBe(true);
    // No overlap with 07:00–09:00.
    expect(s.end_time <= "07:00" || s.start_time >= "09:00").toBe(true);
  });

  it("returns null when the window is fully busy", () => {
    const slot = middleSlot(
      MONDAY,
      { durationMinutes: 60, lowerMinutes: 360, upperMinutes: 420 },
      world([{ start_time: "06:00", end_time: "10:00" }]),
    );
    expect(slot).toBeNull();
  });

  it("never lands on a fixed commitment (buffer included)", () => {
    const slot = middleSlot(
      MONDAY,
      { durationMinutes: 60, lowerMinutes: 360, upperMinutes: 720 },
      world([], [
        { id: "c1", name: "Class", days_of_week: [1], start_time: "08:00", end_time: "09:00" },
      ]),
    );
    expect(slot).not.toBeNull();
    const s = slot!;
    // 08:00–09:00 plus the 15-minute buffer is untouchable.
    expect(s.end_time <= "08:00" || s.start_time >= "09:15").toBe(true);
  });
});

describe("defaultDurationFor", () => {
  it("maps activities, defaulting to 60", () => {
    expect(defaultDurationFor("morning yoga")).toBe(60);
    expect(defaultDurationFor("dinner with mom")).toBe(90);
    expect(defaultDurationFor("birthday party")).toBe(120);
    expect(defaultDurationFor("dentist appointment")).toBe(60);
  });
});

describe("partOfDayIn", () => {
  it("names the window, with tonight as evening", () => {
    expect(partOfDayIn("yoga in the morning")).toBe("morning");
    expect(partOfDayIn("party tonight")).toBe("evening");
    expect(partOfDayIn("dinner with mom")).toBeNull();
  });
});
