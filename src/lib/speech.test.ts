import { describe, expect, it } from "vitest";
import { leadSentenceFirst, splitForSpeech } from "./speech";

describe("speech chunking", () => {
  it("short replies stay one chunk", () => {
    expect(leadSentenceFirst(splitForSpeech("Done. Dinner's on Saturday at seven."))).toEqual(["Done. Dinner's on Saturday at seven."]);
  });

  it("a long reply speaks its first sentence on its own, nothing dropped", () => {
    const text =
      "Ready to book: haircut at Fade Co in Pune, Saturday at three, name Alex Kim. Say yes to book it, or no to stop, and I'll take it from there.";
    const chunks = leadSentenceFirst(splitForSpeech(text));
    expect(chunks[0]).toBe("Ready to book: haircut at Fade Co in Pune, Saturday at three, name Alex Kim.");
    expect(chunks.join(" ")).toBe(text);
  });
});
