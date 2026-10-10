import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ExpandableCard from "./ExpandableCard";

const render = (open: boolean) =>
  renderToStaticMarkup(
    <ExpandableCard title="Model" value="OpenAI — GPT-4o" open={open} onToggle={() => {}}>
      <label>
        API key
        <input placeholder="Paste your API key" />
      </label>
    </ExpandableCard>,
  );

describe("ExpandableCard", () => {
  it("shows the summary row and hides the editor when closed", () => {
    const html = render(false);
    expect(html).toContain("OpenAI — GPT-4o");
    expect(html).toContain("Change");
    expect(html).not.toContain("Paste your API key");
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders the editor inline when open", () => {
    const html = render(true);
    expect(html).toContain("OpenAI — GPT-4o");
    expect(html).toContain("Paste your API key");
    expect(html).toContain("Done");
    expect(html).toContain('aria-expanded="true"');
  });
});
