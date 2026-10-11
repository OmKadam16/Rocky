import { describe, expect, it } from "vitest";
import { isFinalClickTarget, isWatchedClick, overlayHit } from "../../shared/agentCore.mjs";

describe("isFinalClickTarget", () => {
  it("strong wording always counts, even before contact is typed", () => {
    expect(isFinalClickTarget({ text: "Complete reservation" }, false)).toBe(true);
    expect(isFinalClickTarget({ text: "Confirm booking" }, false)).toBe(true);
  });
  it("'Request reservation' counts even outside a form and without contact", () => {
    expect(isFinalClickTarget({ text: "Request reservation" }, false)).toBe(true);
    expect(isFinalClickTarget({ text: "Request appointment" }, false)).toBe(true);
  });
  it("plain 'request' without a booking noun does not count", () => {
    expect(isFinalClickTarget({ text: "Request a callback" }, false)).toBe(false);
    expect(isFinalClickTarget({ text: "Request info" }, true)).toBe(false);
  });
  it("weak wording only counts once contact details are in", () => {
    expect(isFinalClickTarget({ text: "Reserve" }, false)).toBe(false);
    expect(isFinalClickTarget({ text: "Reserve" }, true)).toBe(true);
    expect(isFinalClickTarget({ text: "Find a table" }, true)).toBe(false);
  });
  it("submit inputs count once contact is in; frames defer to contact", () => {
    expect(isFinalClickTarget({ tag: "input", isSubmit: true }, false)).toBe(false);
    expect(isFinalClickTarget({ tag: "input", isSubmit: true }, true)).toBe(true);
    expect(isFinalClickTarget({ unresolvedFrame: true }, false)).toBe(false);
    expect(isFinalClickTarget({ unresolvedFrame: true }, true)).toBe(true);
  });
});

describe("overlayHit", () => {
  const VP = { width: 1280, height: 800 };
  it("names a fixed full-page banner", () => {
    expect(
      overlayHit({ tag: "div", text: "We use cookies Accept all", overlay: { w: 1280, h: 800 } }, VP),
    ).toBe("We use cookies Accept all");
  });
  it("ignores small fixed chrome, static layers and nulls", () => {
    expect(overlayHit({ tag: "header", text: "nav", overlay: { w: 1280, h: 60 } }, VP)).toBe(null);
    expect(overlayHit({ tag: "div", text: "dialog", overlay: null }, VP)).toBe(null);
    expect(overlayHit({ tag: "div", text: "x" }, VP)).toBe(null);
    expect(overlayHit(null, VP)).toBe(null);
  });
});

describe("isWatchedClick", () => {
  it("watches buttons, links and submits only", () => {
    expect(isWatchedClick({ tag: "button", text: "Find a table" })).toBe(true);
    expect(isWatchedClick({ tag: "a", text: "Next" })).toBe(true);
    expect(isWatchedClick({ tag: "input", isSubmit: true })).toBe(true);
    expect(isWatchedClick({ tag: "input", text: "First name" })).toBe(false);
    expect(isWatchedClick({ tag: "select" })).toBe(false);
    expect(isWatchedClick({ tag: "div", text: "banner" })).toBe(false);
    expect(isWatchedClick(null)).toBe(false);
    expect(isWatchedClick({ unresolvedFrame: true })).toBe(false);
  });
});
