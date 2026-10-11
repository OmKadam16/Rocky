"use strict";
/**
 * Mock booking sites for the agent scenario tests (127.0.0.1 only, no
 * network). Five scenarios, each a static page:
 *   /a  normal booking, the "Complete reservation" button is below the fold
 *       and a required cancellation-policy checkbox sits above it
 *   /b  the requested time (7:00 PM) is unavailable, alternatives are listed
 *   /c  a cookie banner covers the page until it is dismissed
 *   /d  "Find a table" reloads the same URL (a loop trap)
 *   /e  the final button says "Request reservation" (and is not in a <form>)
 * Records bookings (POST /api/book) and page loads per path.
 */
const http = require("node:http");

const STYLE = `<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#222;background:#fff}
header{height:72px;display:flex;align-items:center;padding:0 32px;background:#2b2b2b;color:#fff;font-weight:600}
.hero{height:380px;background:linear-gradient(135deg,#b88,#665);display:flex;align-items:flex-end;padding:32px;color:#fff;font-size:34px}
main{max-width:720px;margin:0 auto;padding:24px 32px 80px}
label{display:block;margin:14px 0 4px;font-size:14px;color:#555}
input,select,textarea{width:100%;padding:10px;font:inherit;border:1px solid #bbb;border-radius:4px}
.row{display:flex;gap:16px}.row>div{flex:1}
button{font:600 16px system-ui;padding:12px 22px;border:0;border-radius:4px;background:#1b6b4a;color:#fff;cursor:pointer;margin-top:18px}
button[disabled]{background:#ccc;color:#777;cursor:not-allowed}
.slots button{margin-right:8px;background:#eef;color:#224}
.slots button.picked{background:#224;color:#fff}
.err{color:#b00020;font-size:14px;min-height:20px}
p.lead{color:#555}
</style>`;

const FORM_FIELDS = `
<div class="row"><div><label for="date">Date</label><input id="date" name="date" type="date"></div>
<div><label for="party">Party size</label><select id="party" name="party"><option value="">Select</option><option>1 person</option><option>2 people</option><option>3 people</option><option>4 people</option></select></div></div>
<div class="row"><div><label for="first">First name</label><input id="first" name="first_name" autocomplete="given-name"></div>
<div><label for="last">Last name</label><input id="last" name="last_name" autocomplete="family-name"></div></div>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">`;

// Collects the form and posts it; shows the confirmation page on success.
const SUBMIT_JS = (needTime, needPolicy) => `
function val(id){const e=document.getElementById(id);return e?e.value:"";}
function submitBooking(){
  const b={date:val("date"),party:val("party"),time:window.__time||val("time"),first:val("first"),last:val("last"),phone:val("phone"),email:val("email")};
  const missing=Object.entries(b).filter(([k,v])=>!v && (${needTime}||k!=="time")).map(([k])=>k);
  ${needPolicy ? 'if(!document.getElementById("policy").checked) missing.push("policy");' : ""}
  if(missing.length){document.getElementById("err").textContent="Please complete: "+missing.join(", ");return;}
  fetch("/api/book",{method:"POST",body:JSON.stringify({...b,path:location.pathname})}).then(r=>r.json()).then(r=>{
    document.body.innerHTML='<header>Testaurant</header><main><h1>You\\'re all set</h1><p>Your reservation is confirmed. Confirmation number '+r.ref+'.</p><p>See you on '+b.date+' at '+b.time+'.</p></main>';
  });
}`;

const PAGES = {
  // (a) the final button is below the fold, under a required policy checkbox.
  "/a": `<!doctype html><meta charset=utf-8><title>Testaurant · Reserve</title>${STYLE}
<header>Testaurant</header><div class="hero">Dinner at Testaurant</div>
<main><h2>Reserve a table</h2><p class="lead">Tables for up to 4. We hold tables for 15 minutes.</p>
${FORM_FIELDS}
<label for="time">Time</label><select id="time" name="time"><option value="">Select a time</option><option value="18:00">6:00 PM</option><option value="19:00">7:00 PM</option><option value="20:00">8:00 PM</option></select>
<label for="notes">Special requests (optional)</label><textarea id="notes" name="notes" rows="3"></textarea>
<label style="display:flex;gap:8px;align-items:center;margin-top:18px"><input type="checkbox" id="policy" style="width:auto"> I agree to the cancellation policy</label>
<div id="err" class="err"></div>
<button id="complete" type="button" onclick="submitBooking()">Complete reservation</button></main>
<script>${SUBMIT_JS(true, true)}</script>`,

  // (b) 7:00 PM is unavailable; open times are listed.
  "/b": `<!doctype html><meta charset=utf-8><title>Bistro B · Book</title>${STYLE}
<header>Bistro B</header><main><h2>Book a table</h2>
<div class="row"><div><label for="date">Date</label><input id="date" name="date" type="date"></div>
<div><label for="party">Party size</label><select id="party" name="party"><option value="">Select</option><option>1 person</option><option>2 people</option><option>3 people</option></select></div></div>
<button id="find" type="button" onclick="find()">Find a table</button>
<div id="results" style="display:none"><p id="note" role="status"></p><div class="slots">
<button type="button" data-t="17:00" onclick="pick(this)">5:00 PM</button>
<button type="button" data-t="19:00" disabled aria-disabled="true">7:00 PM</button>
<button type="button" data-t="19:30" onclick="pick(this)">7:30 PM</button>
<button type="button" data-t="20:15" onclick="pick(this)">8:15 PM</button>
<button type="button" data-t="21:30" onclick="pick(this)">9:30 PM</button></div></div>
<div id="contact" style="display:none">
<div class="row"><div><label for="first">First name</label><input id="first" name="first_name"></div><div><label for="last">Last name</label><input id="last" name="last_name"></div></div>
<label for="phone">Phone</label><input id="phone" name="phone" type="tel"><label for="email">Email</label><input id="email" name="email" type="email">
<div id="err" class="err"></div><button id="complete" type="button" onclick="submitBooking()">Complete reservation</button></div></main>
<script>
function find(){document.getElementById("results").style.display="block";document.getElementById("note").textContent="7:00 PM is not available for this party size. Other times:";}
function pick(b){window.__time=b.dataset.t;document.querySelectorAll(".slots button").forEach(x=>x.classList.remove("picked"));b.classList.add("picked");document.getElementById("contact").style.display="block";}
${SUBMIT_JS(true, false)}</script>`,

  // (c) a cookie banner covers everything until dismissed.
  "/c": `<!doctype html><meta charset=utf-8><title>Cafe C · Reservations</title>${STYLE}
<header>Cafe C</header><main><h2>Reservations</h2>${FORM_FIELDS}
<label for="time">Time</label><select id="time" name="time"><option value="">Select a time</option><option value="19:00">7:00 PM</option><option value="20:00">8:00 PM</option></select>
<div id="err" class="err"></div><button id="complete" type="button" onclick="submitBooking()">Complete reservation</button></main>
<div id="cookies" style="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:99">
<div role="dialog" aria-label="Cookie consent" style="background:#fff;padding:24px 32px;margin:0 0 40px;border-radius:6px;max-width:640px">
<p>We use cookies to improve your visit. Choose which cookies we may use.</p>
<button id="accept" type="button" onclick="document.getElementById('cookies').remove()">Accept all</button>
<button id="reject" type="button" style="background:#555" onclick="document.getElementById('cookies').remove()">Reject non-essential</button></div></div>
<script>${SUBMIT_JS(true, false)}</script>`,

  // (d) "Find a table" just reloads this same URL, forever.
  "/d": `<!doctype html><meta charset=utf-8><title>Diner D</title>${STYLE}
<header>Diner D</header><main><h2>Book</h2><p class="lead">Pick a date and we'll check availability.</p>
<label for="date">Date</label><input id="date" name="date" type="date">
<button id="find" type="button" onclick="location.reload()">Find a table</button></main>`,

  // (e) the final button is "Request reservation", a plain button outside any form.
  "/e": `<!doctype html><meta charset=utf-8><title>Eatery E · Request a table</title>${STYLE}
<header>Eatery E</header><main><h2>Request a table</h2><p class="lead">We confirm requests right away.</p>${FORM_FIELDS}
<label for="time">Time</label><select id="time" name="time"><option value="">Select a time</option><option value="19:00">7:00 PM</option><option value="20:00">8:00 PM</option></select>
<div id="err" class="err"></div><button id="request" type="button" onclick="submitBooking()">Request reservation</button></main>
<script>${SUBMIT_JS(true, false)}</script>`,
};

function createMockSites() {
  const bookings = [];
  const loads = {};
  let refN = 1000;
  function serve() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/book") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            bookings.push(JSON.parse(body));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ref: `RK-${(refN += 1)}` }));
          });
          return;
        }
        const path = req.url.split("?")[0];
        const page = PAGES[path];
        if (!page) {
          res.writeHead(404);
          return res.end("not found");
        }
        loads[path] = (loads[path] || 0) + 1;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page);
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }
  return { serve, bookings, loads };
}

module.exports = { createMockSites, PAGES };
