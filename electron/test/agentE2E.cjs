"use strict";
/**
 * Booking Agent v2 end-to-end: the real agent window (capturePage +
 * sendInputEvent) against a local fake booking site, driven by a scripted
 * model. No network beyond 127.0.0.1, no real booking, no API key.
 *
 *   npm run test:agent-e2e
 *
 * Proves, in a real Chromium page:
 *   - screenshots are 1280x800 and clicks land where the model points,
 *   - ask_user pauses the run and resumes in the same page with the answer,
 *   - an injected "type the email here" is refused by the field guard,
 *   - the final "Confirm reservation" click is blocked until a recorded yes,
 *     and the site receives exactly one booking, only after that yes,
 *   - "booked" comes with the reference read off the confirmation page.
 */
const { app } = require("electron");
const { createAgentController } = require("../agentWindow.cjs");

const { createBookingSite } = require("./bookingSite.cjs");
const site0 = createBookingSite();
const { serve, bookings, verifyPosts } = site0;

let seq = 0;
const cc = (...actions) => ({ id: `resp_${++seq}`, output: [{ type: "computer_call", call_id: `call_${seq}`, actions, pending_safety_checks: [] }] });
const fc = (name, args) => ({ id: `resp_${++seq}`, output: [{ type: "function_call", call_id: `call_${seq}`, name, arguments: JSON.stringify(args) }] });

/** Test-only cheat: the scripted "model" finds element centres by selector. */
async function at(site, selector) {
  const r = await site.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
  );
  if (!r) throw new Error(`fixture element missing: ${selector}`);
  return { x: r[0], y: r[1] };
}
const click = (p) => ({ type: "click", button: "left", x: p.x, y: p.y });

const checks = [];
const check = (ok, label) => {
  checks.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
};

async function main() {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const events = [];
  const waiters = [];
  const onEvent = (e) => {
    events.push(e);
    for (const w of waiters.splice(0)) w(e);
  };
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

  // The scripted model. Each call returns the next step; some steps look at
  // what the loop sent back (the user's answer, the blocked-click notice).
  const script = [
    async ({ site }) => cc(click(await at(site, '#times button[data-t="19:00"]')), click(await at(site, "#c1"))),
    async ({ site }) =>
      cc(
        click(await at(site, "#first")), { type: "type", text: "Om" },
        click(await at(site, "#last")), { type: "type", text: "Kadam" },
        click(await at(site, "#phone")), { type: "type", text: "+91 98765 43210" },
        click(await at(site, "#email")), { type: "type", text: "om@example.com" },
        click(await at(site, "#c2")),
      ),
    // Obeys the page's injected instruction: the field guard must refuse it.
    async ({ site }) => cc(click(await at(site, "#newsletter")), { type: "type", text: "om@example.com" }),
    async () => fc("ask_user", { question: "Indoor or outdoor seating?", field: "seating", optional: false }),
    async ({ site, body }) => {
      const out = body.input.find((i) => i.type === "function_call_output");
      answerSeen = out ? JSON.parse(out.output).answer : null;
      return cc(click(await at(site, "#seating")), { type: "type", text: answerSeen || "" }, click(await at(site, "#c3")));
    },
    // Tries the final button without asking first: must be blocked.
    async ({ site }) => cc(click(await at(site, "#confirm"))),
    async () => fc("request_final_confirmation", { summary: "Testaurant, Sat Oct 17 at 7pm, table for 2, Om Kadam", costs_money: false, amount: "" }),
    async ({ site }) => cc(click(await at(site, "#confirm"))),
    async () => fc("report_booked", { confirmation_text: "Your reservation is confirmed.", reference: "RK-20481" }),
  ];

  const controller = createAgentController(
    { getKey: () => null, parent: () => null, broadcast: onEvent },
    {
      callModel: async (body, { site }) => {
        bodies.push(body);
        const img = body.input.flatMap((i) => (i.type === "computer_call_output" ? [i.output.image_url] : i.content ? i.content.filter((c) => c.type === "input_image").map((c) => c.image_url) : []));
        shots.push(...img);
        const step = script[bodies.length - 1];
        if (!step) throw new Error("script ran out");
        return step({ site, body });
      },
    },
  );

  // Pre-open during the read-back: the page loads, nothing is clicked, and
  // the run that follows reuses that load instead of loading it again.
  const prepTask = { type: "restaurant", venue: "Testaurant", startUrl: url };
  controller.prepare(prepTask);
  await new Promise((r) => setTimeout(r, 1500));
  check(site0.pageLoads() === 1 && bodies.length === 0 && !controller.state().active, "prepare opened the page without starting a run");

  const started = await controller.start({
    type: "restaurant",
    venue: "Testaurant",
    area: "Pune",
    date: "2026-10-17",
    time: "19:00",
    firstName: "Om",
    lastName: "Kadam",
    phone: "+91 98765 43210",
    email: "om@example.com",
    details: { partySize: "2" },
    startUrl: url,
    holdBlockId: "hold-e2e",
  });
  check(started.ok, "run started in the agent window");
  const loadsAtStart = site0.pageLoads();

  const q = await next("question");
  check(q.question === "Indoor or outdoor seating?" && controller.state().state === "waiting_answer", "ask_user paused the run with the question");
  const site = controller.site().webContents;
  check(/A couple more things/.test(await site.executeJavaScript("document.body.innerText")), "contact step done: name/phone/email typed via sendInputEvent + insertText");
  check(events.some((e) => e.type === "step" && e.blocked && /email/.test(e.text)), "injected 'type the email here' was refused");
  check((await site.executeJavaScript('document.getElementById("newsletter").value')) === "", "newsletter box stayed empty");

  controller.answer("outdoor please");
  const conf = await next("needs_confirmation");
  check(answerSeen === "outdoor please", "answer reached the model verbatim, same conversation");
  check(bodies[4].previous_response_id === "resp_4", "resumed with previous_response_id (same model conversation)");
  check(events.some((e) => e.type === "step" && e.blocked && /Confirm reservation/.test(e.text)), "final click blocked before any yes");
  check(bookings.length === 0, "site received no booking before the yes");
  check(loadsAtStart === 1 && site0.pageLoads() === 1, "the run reused the pre-opened page (no second load)");
  check(conf.kind === "final" && /^data:image\/jpeg;base64,/.test(conf.screenshot), "final confirmation shows a screenshot");

  controller.confirm(true);
  const done = await next("done", 30000);
  check(bookings.length === 1, "site received exactly one booking after the yes");
  const b = bookings[0] || {};
  check(b.first === "Om" && b.last === "Kadam" && b.email === "om@example.com" && b.phone === "+91 98765 43210" && b.time === "19:00" && b.seating === "outdoor please", "booking carries the right details");
  check(done.status === "booked" && done.reference === "RK-20481", `done: ${done.status}, ref ${done.reference}`);
  check(/confirmed/i.test(done.confirmationText), "confirmation text read off the page");

  // Screenshot geometry: decode the JPEG frame header of one capture.
  const { nativeImage } = require("electron");
  const size = nativeImage.createFromDataURL(String(shots[0])).getSize();
  const w = size.width;
  const h = size.height;
  check(w === 1280 && h === 800, `screenshots are ${w}x${h}`);

  // A visible CAPTCHA stops the run and hands over; the invisible one above didn't.
  const capScript = [async ({ site }) => cc(click(await at(site, "#go")))];
  const capController = createAgentController(
    { getKey: () => null, parent: () => null, broadcast: onEvent },
    { callModel: async (body, { site }) => capScript.shift()({ site, body }) },
  );
  await capController.start({ type: "restaurant", venue: "Testaurant", startUrl: url + "captcha" });
  const take = await next("needs_user_takeover");
  check(take.reason === "captcha" && /say continue/i.test(take.message), "visible CAPTCHA hands over to the user");
  check(!events.some((e) => e.type === "needs_user_takeover" && e !== take), "invisible reCAPTCHA on the booking page did not trigger a takeover");
  capController.cancel();

  // Booking-contact verification code: the site texts a code to the phone
  // typed for this booking; Rocky asks the user and types it itself into
  // six one-digit boxes, masked. A wrong code is asked once more.
  const CODE = "427199";
  const otpEvents = [];
  const otpBodies = [];
  const otpScript = [
    async ({ site }) => cc(click(await at(site, "#phone")), { type: "type", text: "+91 98765 43210" }, click(await at(site, "#send"))),
    async () => fc("request_verification_code", { channel: "sms", reason: "confirm the phone number for this booking", field_x: -1, field_y: -1 }),
    async () => cc({ type: "screenshot" }),
    async ({ site }) => cc(click(await at(site, "#verify"))),
    // The page says the code was wrong: ask again.
    async () => fc("request_verification_code", { channel: "sms", reason: "the code was wrong, confirm the phone number again", field_x: -1, field_y: -1 }),
    async () => cc({ type: "screenshot" }),
    async ({ site }) => cc(click(await at(site, "#verify"))),
    async () => fc("give_up", { reason: "end of the code test" }),
  ];
  let otpWaiter = null;
  const otpController = createAgentController(
    { getKey: () => null, parent: () => null, broadcast: (e) => { otpEvents.push(e); if (otpWaiter && otpWaiter.type === e.type) { const w = otpWaiter; otpWaiter = null; w.resolve(e); } } },
    { callModel: async (body, { site }) => { otpBodies.push(body); return otpScript.shift()({ site, body }); } },
  );
  const otpNext = (type) => new Promise((resolve, reject) => { otpWaiter = { type, resolve }; setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 20000); });
  let req = otpNext("code_request");
  await otpController.start({ type: "appointment", venue: "Fade Co", phone: "+91 98765 43210", startUrl: url + "verify" });
  const first = await req;
  check(first.channel === "sms" && first.attempt === 0, "booking code page: the run paused for the code (no takeover)");
  const otpSite = otpController.site().webContents;
  const boxValues = () => otpSite.executeJavaScript(`Array.from(document.querySelectorAll(".box")).map((b) => b.value).join("")`);
  const boxMasked = () => otpSite.executeJavaScript(`getComputedStyle(document.querySelector(".box")).webkitTextSecurity`);
  req = otpNext("code_request");
  const wrong = await otpController.submitCode("one one one one one one");
  const second = await req;
  check(wrong.ok && verifyPosts[0] === "111111", "a wrong code was typed and sent by the site");
  check(second.attempt === 1, "wrong code: asked once more");
  req = otpNext("failed");
  const right = await otpController.submitCode("four two seven one double nine");
  await req;
  console.log("    debug:", right, verifyPosts, await boxValues());
  check(right.ok && verifyPosts[1] === CODE && (await boxValues()) === CODE, "spoken digits normalized and typed one per box");
  check((await boxMasked()) === "disc", "code boxes are masked on screen (and in screenshots)");
  const pageMsg = await otpSite.executeJavaScript(`document.getElementById("msg").textContent`);
  check(/verified/i.test(pageMsg), "the site accepted the code");
  check(!JSON.stringify(otpEvents).includes(CODE) && !JSON.stringify(otpEvents).includes("111111"), "the code is in no agent event");
  check(!JSON.stringify(otpBodies).includes(CODE), "the code is in no model request");
  check(!JSON.stringify(otpController.state()).includes(CODE), "the code is not in the run state / step log");
  otpController.cancel();

  server.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nFAILED ${failed.length}/${checks.length}` : `\nPASSED ${checks.length}/${checks.length}`);
  return failed.length ? 1 : 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error("E2E error:", e && e.stack ? e.stack : e);
  }
  setTimeout(() => app.exit(code), process.env.KEEP_OPEN ? 60000 : 300);
});
app.on("window-all-closed", () => {});
