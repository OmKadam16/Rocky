import type { CommitmentKind } from "../types";

export const ONBOARDING_STEPS = ["name", "keys", "day", "commitments", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** DB step string -> Onboarding onb index (0 hero, 1 name, 2 keys, 3 day, 4 commitments). */
export function stepToIndex(step: string | null | undefined): number {
  if (!step) return 0;
  const s = step.trim().toLowerCase();
  if (s === "name") return 1;
  if (s === "keys") return 2;
  if (s === "day") return 3;
  if (s === "commitments") return 4;
  if (s === "done") return 5;
  return 0;
}

export function indexToStep(onb: number): OnboardingStep | null {
  if (onb === 1) return "name";
  if (onb === 2) return "keys";
  if (onb === 3) return "day";
  if (onb === 4) return "commitments";
  return null;
}

export function nextStepForDots(): number[] {
  return [1, 2, 3, 4];
}

export type CommitmentDraft = {
  id: string;
  name: string;
  kind: CommitmentKind;
  days: string[];
  start: string;
  end: string;
  notes?: string;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateCommitmentDraft(c: { name: string; days: string[]; start: string; end: string }): { ok: boolean; error?: string } {
  if (!c.name.trim()) return { ok: false, error: "Name is required." };
  if (!c.days.length) return { ok: false, error: "Pick at least one day." };
  if (!HHMM.test(c.start) || !HHMM.test(c.end)) return { ok: false, error: "Use HH:MM times." };
  const [sh, sm] = c.start.split(":").map(Number);
  const [eh, em] = c.end.split(":").map(Number);
  if (eh * 60 + em <= sh * 60 + sm) return { ok: false, error: "End must be after start." };
  return { ok: true };
}

export function allCommitmentsValid(list: { name: string; days: string[]; start: string; end: string }[]): boolean {
  if (!list.length) return false;
  return list.every((c) => validateCommitmentDraft(c).ok);
}
