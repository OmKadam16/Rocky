// Phone screenshots + layout checks for /remote, with Supabase and the chat
// history mocked (scripts/phone-mock). Nothing touches the network.
//
//   node scripts/phone-screens.mjs           -> test-results/phone-screens/*.png
//
// Checks, per size x theme x tab:
//   - no horizontal overflow (page and every element inside the shell);
//   - the tab bar never covers the composer (Chat) or the floating mic (Calendar);
//   - with the keyboard "open" (viewport shrunk) the composer stays in view
//     and the tab bar steps aside.
// Exits 1 if any check fails.
import { createServer } from "vite";
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const out = path.join(root, "test-results", "phone-screens");
fs.mkdirSync(out, { recursive: true });

const server = await createServer({ configFile: path.join(root, "scripts", "phone-mock", "vite.config.ts"), logLevel: "error" });
await server.listen();
const base = "http://localhost:5199";

const SIZES = [
  { name: "390x844", width: 390, height: 844 },
  { name: "360x740", width: 360, height: 740 },
];
const failures = [];
const browser = await chromium.launch();

async function check(page, label, tab) {
  const r = await page.evaluate((tab) => {
    const vw = document.documentElement.clientWidth;
    const overflowPage = document.documentElement.scrollWidth > vw + 1;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        if (!b.width || getComputedStyle(el).visibility === "hidden") return false;
        // Elements inside a horizontal scroller (the week strip) are allowed past the edge.
        for (let p = el.parentElement; p; p = p.parentElement) if (["auto", "scroll"].includes(getComputedStyle(p).overflowX)) return false;
        return b.right > vw + 1 || b.left < -1;
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
    const nav = document.querySelector('[role="tablist"]')?.closest("nav")?.getBoundingClientRect() ?? null;
    const target = tab === "chat" ? document.querySelector('input[aria-label="Message Rocky"]') : document.querySelector('button[aria-label="Tap to talk to Rocky"]');
    const t = target?.getBoundingClientRect() ?? null;
    return { overflowPage, wide, navTop: nav?.top ?? null, targetBottom: t?.bottom ?? null, hasTarget: Boolean(t) };
  }, tab);
  if (r.overflowPage || r.wide.length) failures.push(`${label}: horizontal overflow ${r.wide.join(", ")}`);
  if (!r.hasTarget) failures.push(`${label}: ${tab === "chat" ? "composer" : "floating mic"} not found`);
  else if (r.navTop != null && r.targetBottom > r.navTop + 0.5) failures.push(`${label}: tab bar covers the ${tab === "chat" ? "composer" : "mic"} (${r.targetBottom} > ${r.navTop})`);
  return r;
}

for (const size of SIZES) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await context.addInitScript((theme) => {
      localStorage.setItem("vc-theme", theme);
      localStorage.removeItem("rocky-phone-tab");
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    for (const tab of ["calendar", "chat"]) {
      await page.goto(`${base}/remote?tab=${tab}`);
      await page.waitForSelector('[role="tablist"]', { timeout: 15000 });
      await page.waitForTimeout(900);
      const label = `${size.name}-${theme}-${tab}`;
      await check(page, label, tab);
      await page.screenshot({ path: path.join(out, `${label}.png`) });
    }
    // Keyboard open on Chat: shrink the visual viewport the way a phone does.
    await page.goto(`${base}/remote?tab=chat`);
    await page.waitForSelector('input[aria-label="Message Rocky"]');
    await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
    await page.evaluate(() => {
      // Chromium resizes both viewports together; report the layout height as
      // the full screen so the app sees a keyboard-sized gap.
      Object.defineProperty(window, "innerHeight", { configurable: true, get: () => Math.round(window.visualViewport.height / 0.55) });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(400);
    const kb = await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Message Rocky"]').getBoundingClientRect();
      return { navShown: Boolean(document.querySelector('[role="tablist"]')), inputBottom: input.bottom, vh: window.visualViewport.height };
    });
    const kbLabel = `${size.name}-${theme}-chat-keyboard`;
    if (kb.navShown) failures.push(`${kbLabel}: tab bar still shown with the keyboard open`);
    if (kb.inputBottom > kb.vh + 0.5) failures.push(`${kbLabel}: composer hidden behind the keyboard (${kb.inputBottom} > ${kb.vh})`);
    await page.screenshot({ path: path.join(out, `${kbLabel}.png`) });
    if (errors.length) failures.push(`${size.name}-${theme}: page errors: ${errors.slice(0, 2).join(" | ")}`);
    await context.close();
  }
}

await browser.close();
await server.close();
console.log(`Screenshots in ${path.relative(root, out)}`);
if (failures.length) {
  console.error(`FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("All layout checks passed.");
