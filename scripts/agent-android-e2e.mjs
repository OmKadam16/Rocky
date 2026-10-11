// On-phone booking agent, end to end, without a phone:
//   the REAL Android agent code (src/lib/agentAndroid.ts: driver + controller)
//   and the REAL shared core (shared/agentCore.mjs) drive the fake booking
//   site (electron/test/bookingSite.cjs) through a MOCKED RockyAgentBrowser
//   plugin backed by a Playwright page at phone size (412x780, touch).
// The model is scripted, like the desktop E2E. No network beyond 127.0.0.1.
//
//   npm run test:agent-android
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { createAndroidAgent } from "../src/lib/agentAndroid.ts";

const require = createRequire(import.meta.url);
const { createBookingSite } = require("../electron/test/bookingSite.cjs");

const KEY = { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Space: " " };
const VIEW = { width: 412, height: 780 };

/** RockyAgentBrowser, implemented on a Playwright page (CSS px in, CSS px out). */
function playwrightPlugin(page) {
  const listeners = {};
  return {
    listeners,
    open: async () => ({ ...VIEW }),
    navigate: async ({ url }) => {
      await page.goto(url, { waitUntil: "load" });
      return { url: page.url() };
    },
    screenshot: async ({ quality }) => {
      const buf = await page.screenshot({ type: "jpeg", quality });
      return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, ...VIEW };
    },
    pointer: async ({ action, x, y }) => {
      if (action === "move") return page.mouse.move(x, y);
      await page.mouse.move(x, y);
      return action === "down" ? page.mouse.down() : page.mouse.up();
    },
    key: async ({ action, key }) => {
      const k = KEY[key] ?? key;
      if (action === "up") await page.keyboard.up(k);
      else await page.keyboard.down(k);
      return { ok: true };
    },
    // Android types with key events, one character at a time.
    insertText: async ({ text }) => {
      await page.keyboard.type(text);
      return { ok: true };
    },
    evaluate: async ({ code }) => ({ json: JSON.stringify((await page.evaluate(code)) ?? null) }),
    history: async ({ dir }) => (dir === "back" ? page.goBack() : page.goForward()),
    state: async () => ({ open: true, shown: true, url: page.url(), title: await page.title(), loading: false, ...VIEW }),
    setBanner: async () => {},
    show: async () => {},
    hide: async () => {},
    close: async () => {},
    addListener: async (ev, fn) => ((listeners[ev] = fn), { remove: async () => {} }),
  };
}

let seq = 0;
const cc = (...actions) => ({ id: `resp_${++seq}`, output: [{ type: "computer_call", call_id: `call_${seq}`, actions, pending_safety_checks: [] }] });
const fc = (name, args) => ({ id: `resp_${++seq}`, output: [{ type: "function_call", call_id: `call_${seq}`, name, arguments: JSON.stringify(args) }] });

/** Test-only cheat: the scripted "model" finds elements (scrolled into view) by selector. */
async function at(page, selector) {
  const r = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const b = el.getBoundingClientRect();
    // On a narrow screen a neighbour can overlap the element: use a point
    // where the element itself is on top (centre first).
    for (const fx of [0.5, 0.75, 0.9, 0.25, 0.1]) {
      const x = Math.round(b.x + b.width * fx);
      const y = Math.round(b.y + b.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return [x, y];
    }
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  }, selector);
  if (!r) throw new Error(`fixture element missing: ${selector}`);
  return { x: r[0], y: r[1] };
}
const click = (p) => ({ type: "click", button: "left", x: p.x, y: p.y });

const checks = [];
const check = (ok, label) => {
  checks.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
};

function mkStorage() {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

async function main() {
  const site = createBookingSite();
  const server = await site.serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  // isMobile false = the agent WebView's useWideViewPort(false): pages are laid
  // out at the screen's CSS width, never zoomed out to 980px.
  const context = await browser.newContext({ viewport: VIEW, isMobile: false, hasTouch: true, deviceScaleFactor: 2.625 });

  // ---- main booking: answers, field guard, final-click gate, evidence ----
  const page = await context.newPage();
  const plugin = playwrightPlugin(page);
  const events = [];
  const waiters = [];
  const next = (type, ms = 20000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      const want = (e) => {
        if (e.type === type) {
          clearTimeout(t);
          resolve(e);
        } else if (["failed", "cancelled"].includes(e.type)) {
          clearTimeout(t);
          reject(new Error(`${e.type}: ${e.reason || e.message}`));
        } else waiters.push(want);
      };
      waiters.push(want);
    });
  const bodies = [];
  const shots = [];
  let answerSeen = null;
  const script = [
    async () => cc(click(await at(page, '#times button[data-t="19:00"]')), click(await at(page, "#c1"))),
    async () => cc(click(await at(page, "#first")), { type: "type", text: "Om" }, click(await at(page, "#last")), { type: "type", text: "Kadam" }),
    async () => cc(click(await at(page, "#phone")), { type: "type", text: "+91 98765 43210" }, click(await at(page, "#email")), { type: "type", text: "om@example.com" }, click(await at(page, "#c2"))),
    async () => cc(click(await at(page, "#newsletter")), { type: "type", text: "om@example.com" }),
    async () => fc("ask_user", { question: "Indoor or outdoor seating?", field: "seating", optional: false }),
    async (body) => {
      const out = body.input.find((i) => i.type === "function_call_output");
      answerSeen = out ? JSON.parse(out.output).answer : null;
      return cc(click(await at(page, "#seating")), { type: "type", text: answerSeen || "" }, click(await at(page, "#c3")));
    },
    async () => cc(click(await at(page, "#confirm"))),
    async () => fc("request_final_confirmation", { summary: "Testaurant, Sat Oct 17 at 7pm, table for 2, Om Kadam", costs_money: false, amount: "" }),
    async () => cc(click(await at(page, "#confirm"))),
    async () => fc("report_booked", { confirmation_text: "Your reservation is confirmed.", reference: "RK-20481" }),
  ];
  const storage = mkStorage();
  const awake = [];
  const agent = createAndroidAgent({
    browser: plugin,
    hasKey: async () => true,
    storage,
    keepAwake: (on) => awake.push(on),
    callModel: async (body) => {
      bodies.push(body);
      shots.push(...body.input.flatMap((i) => (i.type === "computer_call_output" ? [i.output.image_url] : i.content ? i.content.filter((c) => c.type === "input_image").map((c) => c.image_url) : [])));
      const step = script[bodies.length - 1];
      if (!step) throw new Error("script ran out");
      return step(body);
    },
  });
  agent.onEvent((e) => {
    events.push(e);
    for (const w of waiters.splice(0)) w(e);
  });

  await agent.prepare({ type: "restaurant", venue: "Testaurant", startUrl: url });
  await new Promise((r) => setTimeout(r, 800));
  check(site.pageLoads() === 1 && bodies.length === 0, "prepare opened the page without starting a run");
  const started = await agent.start({
    type: "restaurant", venue: "Testaurant", area: "Pune", date: "2026-10-17", time: "19:00",
    firstName: "Om", lastName: "Kadam", phone: "+91 98765 43210", email: "om@example.com",
    details: { partySize: "2" }, startUrl: url, holdBlockId: "hold-android",
  });
  check(started.ok, "run started on the phone (no laptop)");
  check(awake[0] === true && storage.get("rocky-agent-run"), "screen kept on and a run marker saved");

  const q = await next("question");
  check(q.question === "Indoor or outdoor seating?", "ask_user paused the run with the question");
  check(/A couple more things/.test(await page.evaluate(() => document.body.innerText)), "contact step done with touches + typed text");
  if (process.env.DEBUG_STEPS) console.log(events.filter((e) => e.type === "step").map((e) => `${e.blocked ? "BLOCKED " : ""}${e.text}`).join(" | "));
  check(events.some((e) => e.type === "step" && e.blocked && /email/.test(e.text)), "injected 'type the email here' was refused");
  check((await page.evaluate(() => document.getElementById("newsletter").value)) === "", "newsletter box stayed empty");

  await agent.answer("outdoor please");
  const conf = await next("needs_confirmation");
  check(answerSeen === "outdoor please", "answer reached the model verbatim");
  check(events.some((e) => e.type === "step" && e.blocked && /Confirm reservation/.test(e.text)), "final click blocked before any yes");
  check(site.bookings.length === 0, "site received no booking before the yes");
  check(conf.kind === "final", "final confirmation asked");

  await agent.confirm(true);
  const done = await next("done", 30000);
  check(site.bookings.length === 1, "site received exactly one booking after the yes");
  const b = site.bookings[0] || {};
  check(b.first === "Om" && b.last === "Kadam" && b.email === "om@example.com" && b.time === "19:00" && b.seating === "outdoor please", "booking carries the right details");
  check(done.status === "booked" && done.reference === "RK-20481", `done: ${done.status}, ref ${done.reference}`);
  check(shots.length > 0 && shots.every((s) => /^data:image\/jpeg;base64,/.test(String(s))), "screenshots are phone-sized JPEGs");
  check(awake.at(-1) === false && !storage.get("rocky-agent-run"), "screen released and run marker cleared at the end");

  // ---- CAPTCHA hands over to the user ----
  const capPage = await context.newPage();
  const capEvents = [];
  const capScript = [async () => cc(click(await at(capPage, "#go")))];
  const capAgent = createAndroidAgent({ browser: playwrightPlugin(capPage), hasKey: async () => true, storage: mkStorage(), callModel: async () => capScript.shift()() });
  let capResolve;
  const take = new Promise((r) => (capResolve = r));
  capAgent.onEvent((e) => {
    capEvents.push(e);
    if (e.type === "needs_user_takeover") capResolve(e);
  });
  await capAgent.start({ type: "restaurant", venue: "Testaurant", startUrl: url + "captcha" });
  const t = await take;
  check(t.reason === "captcha" && /say continue/i.test(t.message), "visible CAPTCHA hands over to the user");
  await capAgent.cancel();

  // ---- booking-contact code: asked, typed one per box, masked, never leaked ----
  const CODE = "427199";
  const otpPage = await context.newPage();
  const otpPlugin = playwrightPlugin(otpPage);
  const otpEvents = [];
  const otpBodies = [];
  const otpScript = [
    async () => cc(click(await at(otpPage, "#phone")), { type: "type", text: "+91 98765 43210" }, click(await at(otpPage, "#send"))),
    async () => fc("request_verification_code", { channel: "sms", reason: "confirm the phone number for this booking", field_x: -1, field_y: -1 }),
    async () => cc({ type: "screenshot" }),
    async () => cc(click(await at(otpPage, "#verify"))),
    async () => fc("give_up", { reason: "end of the code test" }),
  ];
  const otpAgent = createAndroidAgent({
    browser: otpPlugin,
    hasKey: async () => true,
    storage: mkStorage(),
    callModel: async (body) => (otpBodies.push(body), otpScript.shift()()),
  });
  let otpWait = null;
  otpAgent.onEvent((e) => {
    otpEvents.push(e);
    if (otpWait && otpWait.type === e.type) otpWait.resolve(e);
  });
  const otpNext = (type) => new Promise((resolve) => (otpWait = { type, resolve }));
  let w = otpNext("code_request");
  await otpAgent.start({ type: "appointment", venue: "Fade Co", phone: "+91 98765 43210", startUrl: url + "verify" });
  const first = await w;
  check(first.channel === "sms", "booking code page: the run paused for the code (no takeover)");
  w = otpNext("failed");
  const right = await otpAgent.code("four two seven one double nine");
  await w;
  const boxes = await otpPage.evaluate(() => Array.from(document.querySelectorAll(".box")).map((b) => b.value).join(""));
  check(right.ok && site.verifyPosts.at(-1) === CODE && boxes === CODE, "spoken digits normalized and typed one per box");
  check((await otpPage.evaluate(() => getComputedStyle(document.querySelector(".box")).webkitTextSecurity)) === "disc", "code boxes are masked");
  check(!JSON.stringify(otpEvents).includes(CODE), "the code is in no agent event");
  check(!JSON.stringify(otpBodies).includes(CODE), "the code is in no model request");
  check(!JSON.stringify(await otpAgent.state()).includes(CODE), "the code is not in the run state / step log");

  await browser.close();
  server.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nFAILED ${failed.length}/${checks.length}` : `\nPASSED ${checks.length}/${checks.length}`);
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("E2E error:", e && e.stack ? e.stack : e);
    process.exit(1);
  });
