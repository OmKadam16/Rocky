"use strict";
/**
 * Booking-agent scenario checks against mockSites.cjs (127.0.0.1 only).
 * Each scenario drives a real agent window with a scripted model and asserts
 * the diagnosed behavior, fixed or not:
 *
 *   electron electron/test/agentScenarios.cjs [s1|s2|s3|s4|s5|all]
 *
 *   s1  below-fold final click (/a): blind click must NOT book; the run
 *       should scroll toward it and say so. Full confirm flow then books.
 *   s2  "Request reservation" outside a form (/e): must be blocked until yes.
 *   s3  loop trap (/d): repeated no-op clicks must produce a "changed
 *       nothing" note to the model (backstop: repeat fail).
 *   s4  cookie banner (/c): click must name the banner, not sail through.
 *   s5  taken time (/b): ask_user with alternatives flows end to end and the
 *       booking lands on the answered time.
 *
 * Form-filling via executeJavaScript is test setup only (the baseline E2E
 * already proves the agent path for typing); every click under test goes
 * through the agent's own click pipeline. Exits non-zero on any failure.
 */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentController } = require("../agentWindow.cjs");
const { createMockSites } = require("./mockSites.cjs");

const which = process.argv[2] || "all";

let seq = 0;
const cc = (...actions) => ({ id: `resp_${++seq}`, output: [{ type: "computer_call", call_id: `call_${seq}`, actions, pending_safety_checks: [] }] });
const fc = (name, args) => ({ id: `resp_${++seq}`, output: [{ type: "function_call", call_id: `call_${seq}`, name, arguments: JSON.stringify(args) }] });
const giveUp = (reason) => fc("give_up", { reason });

async function at(site, selector) {
  const r = await site.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`,
  );
  if (!r) throw new Error(`fixture element missing: ${selector}`);
  return { x: r[0], y: r[1] };
}
const click = (p) => ({ type: "click", button: "left", x: p.x, y: p.y });

const FILL_A = `document.getElementById("date").value="2026-10-17";
document.getElementById("party").selectedIndex=2;
document.getElementById("first").value="Om";document.getElementById("last").value="Kadam";
document.getElementById("phone").value="+91 98765 43210";document.getElementById("email").value="om@example.com";
document.getElementById("time").value="19:00";document.getElementById("policy").checked=true;`;
const FILL_E = `document.getElementById("date").value="2026-10-17";
document.getElementById("party").selectedIndex=2;
document.getElementById("first").value="Om";document.getElementById("last").value="Kadam";
document.getElementById("phone").value="+91 98765 43210";document.getElementById("email").value="om@example.com";
document.getElementById("time").value="19:00";`;
const FILL_C = FILL_E;
const FILL_B = `document.getElementById("date").value="2026-10-17";document.getElementById("party").selectedIndex=2;document.getElementById("first").value="Om";document.getElementById("last").value="Kadam";document.getElementById("phone").value="+91 98765 43210";document.getElementById("email").value="om@example.com";`;

const results = [];
const check = (ok, label) => {
  results.push({ ok: Boolean(ok), label });
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
};

/** Test setup: wait for the run's navigation, then fill the form via JS. */
async function fillWhenReady(controller, js) {
  const wc = controller.site().webContents;
  for (let i = 0; i < 40; i += 1) {
    const ready = await wc.executeJavaScript("!!document.getElementById('date')").catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await wc.executeJavaScript(js);
}

function mkController(decide, events, bodies, tag) {
  const traceFile = path.join(os.tmpdir(), `rocky-agent-trace-${tag}-${Date.now()}.jsonl`);
  const controller = createAgentController(
    { getKey: () => null, parent: () => null, broadcast: (e) => events.push(e) },
    {
      callModel: (body, ctx) => {
        // Images dwarf the text: keep input_text items whole, truncate images.
        const slim = JSON.stringify(body, (k, v) => (k === "image_url" && typeof v === "string" ? v.slice(0, 60) : v));
        bodies.push(slim);
        return decide(body, ctx);
      },
      traceFile,
    },
  );
  return { controller, traceFile };
}

const blockedNotes = (events) => events.filter((e) => e.type === "step" && e.blocked).map((e) => e.text);
const modelSaw = (bodies, re) => bodies.some((b) => re.test(b));

/** Auto-confirm final confirmations and answer questions from a script. */
async function drive(controller, events, { confirmFinal = false, answers = {} } = {}) {
  const seen = new Set();
  for (let i = 0; i < 120; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    for (const e of events) {
      const key = `${e.type}:${e.question || e.summary || e.channel || ""}:${e.at || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.type === "needs_confirmation" && confirmFinal) controller.confirm(true);
      if (e.type === "question" && answers.question) controller.answer(answers.question);
    }
    const st = controller.state();
    if (!st.active) {
      for (const e of events.filter((e) => ["failed", "cancelled", "done", "needs_user_takeover"].includes(e.type))) {
        const { screenshot, ...rest } = e;
        console.log(`  [${e.type}] ${JSON.stringify(rest).slice(0, 300)}${screenshot ? " (shot attached)" : ""}`);
      }
      try {
        const trail = controller.current() ? controller.current().trail().slice(-6) : [];
        for (const t of trail) console.log(`  [trail] ${JSON.stringify(t).slice(0, 220)}`);
      } catch {}
      return st;
    }
  }
  throw new Error("run did not finish in time");
}

async function scenarioS1(url, mocks) {
  console.log("\nS1 below-fold final click (/a)");
  const events = [];
  const bodies = [];
  const before = mocks.bookings.length;
  let n = 0;
  const { controller, traceFile } = mkController(async (body, { site: wc }) => {
    n += 1;
    if (n === 1) return cc(click(await at(wc, "#complete"))); // blind, below fold
    if (n === 2) return cc({ type: "screenshot" }); // observe where the auto-scroll landed
    if (n === 3) return cc(click(await at(wc, "#complete"))); // in view: must be held for yes
    if (n === 4) return fc("request_final_confirmation", { summary: "Testaurant, Oct 17 at 7pm, table for 2, Om Kadam", costs_money: false, amount: "" });
    if (n === 5) return cc(click(await at(wc, "#complete")));
    if (n === 6) return fc("report_booked", { confirmation_text: "reservation is confirmed", reference: "" });
    return giveUp("s1 done");
  }, events, bodies, "s1");
  await controller.start({ type: "restaurant", venue: "Testaurant", date: "2026-10-17", time: "19:00", firstName: "Om", lastName: "Kadam", phone: "+91 98765 43210", email: "om@example.com", startUrl: `${url}a` });
  await fillWhenReady(controller, FILL_A);
  const st = await drive(controller, events, { confirmFinal: true });
  check(mocks.bookings.length - before === 1, "exactly one booking after the full flow");
  check(st.state === "done", `run done (state=${st.state})`);
  check(modelSaw(bodies, /below the visible page|scrolled toward it/), "blind click scrolled instead of clicking blindly");
  check(blockedNotes(events).some((t) => /Request reservation.*needs your yes|needs your yes/.test(t)), "in-view final click held for yes");
  check(fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).length > 5, "trace file written with step lines");
  try { fs.unlinkSync(traceFile); } catch {}
  controller.cancel();
}

async function scenarioS2(url, mocks) {
  console.log("\nS2 'Request reservation' with no confirm (/e)");
  const events = [];
  const bodies = [];
  const before = mocks.bookings.length;
  let n = 0;
  const { controller } = mkController(async (body, { site: wc }) => {
    n += 1;
    if (n === 1) return cc({ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 600 });
    if (n === 2) return cc(click(await at(wc, "#request"))); // no confirm first: must block
    if (n === 3) return fc("request_final_confirmation", { summary: "Eatery E, Oct 17 at 7pm, table for 2", costs_money: false, amount: "" });
    if (n === 4) return cc(click(await at(wc, "#request")));
    if (n === 5) return fc("report_booked", { confirmation_text: "reservation is confirmed", reference: "" });
    return giveUp("s2 done");
  }, events, bodies, "s2");
  await controller.start({ type: "restaurant", venue: "Eatery E", date: "2026-10-17", time: "19:00", firstName: "Om", lastName: "Kadam", phone: "+91 98765 43210", email: "om@example.com", startUrl: `${url}e` });
  await fillWhenReady(controller, FILL_E);
  const st = await drive(controller, events, { confirmFinal: true });
  check(blockedNotes(events).some((t) => /needs your yes/.test(t)), "'Request reservation' blocked until yes");
  check(mocks.bookings.length - before === 1, "exactly one booking after yes");
  check(st.state === "done", `run done (state=${st.state})`);
  controller.cancel();
}

async function scenarioS3(url, mocks) {
  console.log("\nS3 loop trap: Find-a-table reloads (/d)");
  const events = [];
  const bodies = [];
  const loadsBefore = mocks.loads["/d"] || 0;
  let n = 0;
  const { controller } = mkController(async (body, { site: wc }) => {
    n += 1;
    if (n > 8) return giveUp("s3 script cap");
    return cc(click(await at(wc, "#find")));
  }, events, bodies, "s3");
  await controller.start({ type: "restaurant", venue: "Diner D", date: "2026-10-17", time: "19:00", startUrl: `${url}d` });
  const st = await drive(controller, events);
  const loads = (mocks.loads["/d"] || 0) - loadsBefore;
  console.log(`  model calls: ${n}, page loads: ${loads}, terminal: ${st.state}`);
  check(modelSaw(bodies, /doesn't seem to have changed/), "no-op reload reported back to the model");
  check(loads <= 4, `loop backstop still holds (loads=${loads})`);
  controller.cancel();
}

async function scenarioS4(url, mocks) {
  console.log("\nS4 cookie banner covers the final button (/c)");
  const events = [];
  const bodies = [];
  const before = mocks.bookings.length;
  let n = 0;
  const { controller } = mkController(async (body, { site: wc }) => {
    n += 1;
    if (n === 1) return cc(click(await at(wc, "#complete"))); // covered: must name the banner
    if (n === 2) return cc(click(await at(wc, "#reject")), click(await at(wc, "#complete")));
    if (n === 3) return fc("request_final_confirmation", { summary: "Cafe C, Oct 17 at 7pm, table for 2", costs_money: false, amount: "" });
    if (n === 4) return cc(click(await at(wc, "#complete")));
    if (n === 5) return fc("report_booked", { confirmation_text: "reservation is confirmed", reference: "" });
    return giveUp("s4 done");
  }, events, bodies, "s4");
  await controller.start({ type: "restaurant", venue: "Cafe C", date: "2026-10-17", time: "19:00", firstName: "Om", lastName: "Kadam", phone: "+91 98765 43210", email: "om@example.com", startUrl: `${url}c` });
  await fillWhenReady(controller, FILL_C);
  const st = await drive(controller, events, { confirmFinal: true });
  check(modelSaw(bodies, /banner is covering|would hit/), "covered click names the banner");
  check(mocks.bookings.length - before === 1, "exactly one booking after dismiss + yes");
  check(st.state === "done", `run done (state=${st.state})`);
  controller.cancel();
}

async function scenarioS5(url, mocks) {
  console.log("\nS5 taken time: alternatives flow (/b)");
  const events = [];
  const bodies = [];
  const before = mocks.bookings.length;
  let n = 0;
  const { controller } = mkController(async (body, { site: wc }) => {
    n += 1;
    if (n === 1) return cc(click(await at(wc, "#find")));
    if (n === 2) return cc({ type: "screenshot" });
    if (n === 3) return fc("ask_user", { question: "7:00 PM is taken. 7:30 PM or 8:15 PM?", field: "time", optional: false });
    if (n === 4) return cc(click(await at(wc, 'button[data-t="19:30"]')));
    if (n === 5) { await wc.executeJavaScript(FILL_B).catch(() => {}); return cc(click(await at(wc, "#complete"))); }
    if (n === 6) return fc("request_final_confirmation", { summary: "Bistro B, Oct 17 at 7:30pm, table for 2", costs_money: false, amount: "" });
    if (n === 7) return cc(click(await at(wc, "#complete")));
    if (n === 8) return fc("report_booked", { confirmation_text: "reservation is confirmed", reference: "" });
    return giveUp("s5 done");
  }, events, bodies, "s5");
  await controller.start({ type: "restaurant", venue: "Bistro B", date: "2026-10-17", time: "19:00 (window until 20:00)", firstName: "Om", lastName: "Kadam", phone: "+91 98765 43210", email: "om@example.com", details: { partySize: "2" }, startUrl: `${url}b` });
  const st = await drive(controller, events, { confirmFinal: true, answers: { question: "7:30 PM" } });
  check(events.some((e) => e.type === "question" && /7:30/.test(e.question)), "alternatives question reached the user");
  const booked = mocks.bookings.slice(before);
  check(booked.length === 1 && booked[0].time === "19:30", `booked the answered time (got ${booked.map((b) => b.time)})`);
  check(st.state === "done", `run done (state=${st.state})`);
  controller.cancel();
}

async function main() {
  const mocks = createMockSites();
  const server = await mocks.serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const run = { s1: scenarioS1, s2: scenarioS2, s3: scenarioS3, s4: scenarioS4, s5: scenarioS5 };
  const names = which === "all" ? ["s1", "s2", "s3", "s4", "s5"] : [which];
  for (const name of names) {
    if (!run[name]) throw new Error(`unknown scenario ${name}`);
    try {
      await run[name](url, mocks);
    } catch (e) {
      check(false, `${name} harness: ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`\nloads: ${JSON.stringify(mocks.loads)}`);
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAILED ${failed.length}/${results.length}` : `\nPASSED ${results.length}/${results.length}`);
  return failed.length ? 1 : 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error("Scenario error:", e && e.stack ? e.stack : e);
  }
  setTimeout(() => app.exit(code), 300);
});
app.on("window-all-closed", () => {});
