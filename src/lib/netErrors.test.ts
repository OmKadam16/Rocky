import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFailure, isNetworkError, withNetRetry } from "./netErrors";

describe("network errors", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recognises the browser's network failures, not aborts or API errors", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("Connection error."))).toBe(true);
    expect(isNetworkError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isNetworkError(new Error("401 Incorrect API key"))).toBe(false);
  });

  it("says which service dropped instead of 'Failed to fetch'", () => {
    expect(describeFailure("voice-to-text", new TypeError("Failed to fetch"))).toMatch(/ElevenLabs \(voice-to-text\)/);
    expect(describeFailure("calendar", new TypeError("Failed to fetch"))).toMatch(/Supabase/);
    expect(describeFailure("planner", new Error("400 bad model"))).toBe("The AI model failed: 400 bad model");
  });

  it("retries a network blip once, never other errors", async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      if (n++ === 0) throw new TypeError("Failed to fetch");
      return "ok";
    });
    const p = withNetRetry(flaky);
    await vi.advanceTimersByTimeAsync(800);
    expect(await p).toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => {
      throw new Error("401 Incorrect API key");
    });
    await expect(withNetRetry(bad)).rejects.toThrow("401");
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
