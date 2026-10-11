import { describe, expect, it } from "vitest";
import { range12h, speakableTimes, to12h } from "./clockTalk";

const TODAY = "2026-10-11"; // a Sunday

describe("12-hour clock in replies", () => {
  it("converts single times", () => {
    expect(to12h("19:00")).toBe("7 PM");
    expect(to12h("09:30")).toBe("9:30 AM");
    expect(to12h("12:00")).toBe("12 PM");
    expect(to12h("00:15")).toBe("12:15 AM");
    expect(to12h("20:00:00")).toBe("8 PM");
  });

  it("joins ranges the way people say them", () => {
    expect(range12h("19:00", "21:00")).toBe("7 to 9 PM");
    expect(range12h("11:00", "13:00")).toBe("11 AM to 1 PM");
    expect(range12h("07:00", "09:30")).toBe("7 to 9:30 AM");
  });

  it("rewrites 24-hour times and ISO dates in a reply", () => {
    expect(speakableTimes("Remove Nobu 07:00-09:00 and Nobu Newport Beach 19:00–22:00?", TODAY)).toBe(
      "Remove Nobu 7 to 9 AM and Nobu Newport Beach 7 to 10 PM?",
    );
    expect(speakableTimes("Gym is at 17:00 on 2026-10-12.", TODAY)).toBe("Gym is at 5 PM tomorrow.");
    expect(speakableTimes("Delete \"Study\" on 2026-10-16?", TODAY)).toBe('Delete "Study" on Friday, October 16?');
    expect(speakableTimes("Lunch 12:00 to 13:30", TODAY)).toBe("Lunch 12 to 1:30 PM");
  });

  it("leaves times that are already 12-hour alone", () => {
    expect(speakableTimes("Dinner at 8 PM, then 7:30 tonight works.", TODAY)).toBe("Dinner at 8 PM, then 7:30 tonight works.");
    expect(speakableTimes("Booked 7:30 pm and 9:00 am", TODAY)).toBe("Booked 7:30 pm and 9:00 am");
    expect(speakableTimes("Room 1205, code 4471", TODAY)).toBe("Room 1205, code 4471");
  });
});
