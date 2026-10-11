import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat, HEARTBEAT_RETRY_MS } from "./devices";
import { HEARTBEAT_MS, LAPTOP_OFFLINE_AFTER_SEC } from "./pairing";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("laptop heartbeat", () => {
  it("beats immediately on start, then every 15 s", async () => {
    const touch = vi.fn(async () => true);
    const hb = createHeartbeat(touch);
    await flush();
    expect(touch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(touch).toHaveBeenCalledTimes(4);
    hb.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(touch).toHaveBeenCalledTimes(4);
  });

  it("retries a failed beat once after 3 s (not forever)", async () => {
    const touch = vi.fn(async () => false);
    const reasons: string[] = [];
    const hb = createHeartbeat(touch, { onResult: (_ok, r) => reasons.push(r) });
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_RETRY_MS - 1);
    expect(touch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(touch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_RETRY_MS * 2);
    expect(touch).toHaveBeenCalledTimes(2); // the retry itself isn't retried
    expect(reasons).toEqual(["start", "retry"]);
    hb.stop();
  });

  it("a successful retry keeps the laptop well inside the 45 s offline window", async () => {
    let fail = true;
    const seen: number[] = [];
    const touch = vi.fn(async () => {
      if (fail) {
        fail = false;
        return false;
      }
      seen.push(Date.now());
      return true;
    });
    const hb = createHeartbeat(touch);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_RETRY_MS);
    expect(seen.length).toBe(1);
    expect(HEARTBEAT_RETRY_MS + HEARTBEAT_MS).toBeLessThan(LAPTOP_OFFLINE_AFTER_SEC * 1000);
    hb.stop();
  });

  it("beats on demand (focus, online, wake from sleep) and skips overlapping beats", async () => {
    let release: (v: boolean) => void = () => {};
    const touch = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const hb = createHeartbeat(touch);
    await flush();
    expect(touch).toHaveBeenCalledTimes(1);
    void hb.beat("resume"); // still in flight: skipped
    expect(touch).toHaveBeenCalledTimes(1);
    release(true);
    await flush();
    void hb.beat("resume");
    void hb.beat("focus");
    expect(touch).toHaveBeenCalledTimes(2);
    release(true);
    await flush();
    void hb.beat("online");
    expect(touch).toHaveBeenCalledTimes(3);
    release(true);
    hb.stop();
  });
});
