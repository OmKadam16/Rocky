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
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentController } = require("../agentWindow.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "booking-site", "index.html");
const bookings = [];

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/book") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          bookings.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ref: "RK-20481" }));
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(FIXTURE));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

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
  check(conf.kind === "final" && /^data:image\/png;base64,/.test(conf.screenshot), "final confirmation shows a screenshot");

  controller.confirm(true);
  const done = await next("done", 30000);
  check(bookings.length === 1, "site received exactly one booking after the yes");
  const b = bookings[0] || {};
  check(b.first === "Om" && b.last === "Kadam" && b.email === "om@example.com" && b.phone === "+91 98765 43210" && b.time === "19:00" && b.seating === "outdoor please", "booking carries the right details");
  check(done.status === "booked" && done.reference === "RK-20481", `done: ${done.status}, ref ${done.reference}`);
  check(/confirmed/i.test(done.confirmationText), "confirmation text read off the page");

  // Screenshot geometry: decode the PNG header of one capture.
  const png = Buffer.from(String(shots[0]).split(",")[1] || "", "base64");
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check(w === 1280 && h === 800, `screenshots are ${w}x${h}`);

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
