import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDER_MODELS } from "./models";

describe("PROVIDER_MODELS", () => {
  it("lists each model once per provider (ids are React keys in the picker)", () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      const ids = models.map((m) => m.id);
      expect(new Set(ids).size, provider).toBe(ids.length);
    }
  });

  it("contains the default model", () => {
    expect(PROVIDER_MODELS[DEFAULT_PROVIDER].some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });
});
