import { describe, expect, it } from "vitest";
import { indexToStep, stepToIndex, validateCommitmentDraft, allCommitmentsValid } from "./onboardingLogic";
import { normalizeCommitmentType, normalizeTimeToHHMM, validateDayAnalysis } from "./dayAnalysis";
import { PROVIDER_BASE_URL, defaultModelFor, normalizeProvider, resolveModelId } from "./models";

describe("onboarding step resume", () => {
  it("maps db steps to hero/name/keys/day/commitments indices", () => {
    expect(stepToIndex(null)).toBe(0);
    expect(stepToIndex("")).toBe(0);
    expect(stepToIndex("name")).toBe(1);
    expect(stepToIndex("keys")).toBe(2);
    expect(stepToIndex("day")).toBe(3);
    expect(stepToIndex("commitments")).toBe(4);
    expect(stepToIndex("done")).toBe(5);
    expect(stepToIndex("bogus")).toBe(0);
  });

  it("maps indices back to steps for saving", () => {
    expect(indexToStep(1)).toBe("name");
    expect(indexToStep(2)).toBe("keys");
    expect(indexToStep(3)).toBe("day");
    expect(indexToStep(4)).toBe("commitments");
    expect(indexToStep(0)).toBeNull();
  });
});

describe("commitment validation", () => {
  it("requires name, day, and end after start", () => {
    expect(validateCommitmentDraft({ name: "", days: ["Mon"], start: "09:00", end: "10:00" }).ok).toBe(false);
    expect(validateCommitmentDraft({ name: "Gym", days: [], start: "09:00", end: "10:00" }).ok).toBe(false);
    expect(validateCommitmentDraft({ name: "Gym", days: ["Tue"], start: "10:00", end: "09:00" }).ok).toBe(false);
    expect(validateCommitmentDraft({ name: "Gym", days: ["Tue"], start: "18:00", end: "19:00" }).ok).toBe(true);
  });

  it("needs at least one valid row", () => {
    expect(allCommitmentsValid([])).toBe(false);
    expect(allCommitmentsValid([{ name: "Gym", days: ["Tue"], start: "18:00", end: "19:00" }])).toBe(true);
    expect(
      allCommitmentsValid([
        { name: "Gym", days: ["Tue"], start: "18:00", end: "19:00" },
        { name: "", days: ["Mon"], start: "09:00", end: "10:00" },
      ]),
    ).toBe(false);
  });
});

describe("day-analysis JSON validator", () => {
  it("accepts a good payload with v1 kinds", () => {
    const r = validateDayAnalysis({
      summary: "Early bird, classes MWF mornings.",
      wake_time: "07:00",
      sleep_time: "23:00",
      preferred_study_hours: [{ start: "09:00", end: "11:00" }],
      commitments: [{ name: "Chem Lab", type: "Class", days_of_week: [1, 3, 5], start_time: "09:00", end_time: "12:00" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.commitments[0]?.type).toBe("Class");
      expect(r.value.wake_time).toBe("07:00");
    }
  });

  it("maps club/study-group to Other and keeps the original in notes", () => {
    const mapped = normalizeCommitmentType("club", "Chess club");
    expect(mapped.type).toBe("Other");
    expect(mapped.notesSuffix).toContain("club");
    const r = validateDayAnalysis({
      summary: "Busy.",
      commitments: [{ name: "Chess club", type: "club", days_of_week: [2], start_time: "18:00", end_time: "19:00" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.commitments[0]?.type).toBe("Other");
      expect(String(r.value.commitments[0]?.notes ?? "")).toContain("club");
    }
  });

  it("drops bad commitments instead of failing", () => {
    const emptyDays = validateDayAnalysis({ summary: "x", commitments: [{ name: "Gym", type: "Gym", days_of_week: [], start_time: "18:00", end_time: "19:00" }] });
    expect(emptyDays.ok).toBe(true);
    if (emptyDays.ok) expect(emptyDays.value.commitments).toEqual([]);
    const badTimes = validateDayAnalysis({ summary: "x", commitments: [{ name: "Gym", type: "Gym", days_of_week: [2], start_time: "19:00", end_time: "18:00" }] });
    expect(badTimes.ok).toBe(true);
    if (badTimes.ok) expect(badTimes.value.commitments).toEqual([]);
    expect(validateDayAnalysis({ summary: "", commitments: [] }).ok).toBe(false);
    expect(validateDayAnalysis({ summary: "x" }).ok).toBe(false);
  });

  it('normalizes "7:00" to "07:00" and "7pm" to "19:00"', () => {
    expect(normalizeTimeToHHMM("7:00")).toBe("07:00");
    expect(normalizeTimeToHHMM("7pm")).toBe("19:00");
    expect(normalizeTimeToHHMM("7 pm")).toBe("19:00");
    expect(normalizeTimeToHHMM("7:30pm")).toBe("19:30");
    expect(normalizeTimeToHHMM("12am")).toBe("00:00");
    expect(normalizeTimeToHHMM("12pm")).toBe("12:00");
    expect(normalizeTimeToHHMM("09:05")).toBe("09:05");
  });

  it("drops invalid optional fields instead of failing", () => {
    const r = validateDayAnalysis({
      summary: "Early bird.",
      wake_time: "not a time",
      sleep_time: "25:99",
      preferred_study_hours: [
        { start: "09:00", end: "11:00" },
        { start: "bad", end: "worse" },
      ],
      commitments: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.wake_time).toBeUndefined();
      expect(r.value.sleep_time).toBeUndefined();
      expect(r.value.preferred_study_hours).toEqual([{ start: "09:00", end: "11:00" }]);
    }
  });

  it("keeps two of three commitments when one is bad", () => {
    const r = validateDayAnalysis({
      summary: "Busy week.",
      commitments: [
        { name: "Chem Lab", type: "Class", days_of_week: [1], start_time: "09:00", end_time: "10:00" },
        { name: "Bad one", type: "Work", days_of_week: [], start_time: "09:00", end_time: "10:00" },
        { name: "Gym", type: "Gym", days_of_week: [2], start_time: "6pm", end_time: "7pm" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.commitments.map((c) => c.name)).toEqual(["Chem Lab", "Gym"]);
      expect(r.value.commitments[1]?.start_time).toBe("18:00");
      expect(r.value.commitments[1]?.end_time).toBe("19:00");
    }
  });
});

describe("provider baseURL mapping", () => {
  it("points each provider at its OpenAI-compatible endpoint", () => {
    expect(PROVIDER_BASE_URL.OpenAI).toBe("https://api.openai.com/v1");
    expect(PROVIDER_BASE_URL.Gemini).toContain("generativelanguage.googleapis.com");
    expect(PROVIDER_BASE_URL.Anthropic).toBe("https://api.anthropic.com/v1/");
    expect(PROVIDER_BASE_URL.Grok).toBe("https://api.x.ai/v1");
  });

  it("normalizes providers and resolves per-provider defaults", () => {
    expect(normalizeProvider("openai")).toBe("OpenAI");
    expect(normalizeProvider("bogus")).toBe("OpenAI");
    expect(defaultModelFor("OpenAI")).toBe("gpt-5.5");
    expect(resolveModelId("", "OpenAI")).toBe("gpt-5.5");
    expect(resolveModelId("gpt-4o", "OpenAI")).toBe("gpt-4o");
    expect(resolveModelId("bogus-model", "Gemini")).toBe(defaultModelFor("Gemini"));
  });
});
