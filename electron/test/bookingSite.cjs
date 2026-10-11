"use strict";
/**
 * The fake booking site for the agent end-to-end tests (desktop:
 * agentE2E.cjs, Android: scripts/agent-android-e2e.mjs). 127.0.0.1 only.
 * Records bookings, verification-code posts and page loads.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function createBookingSite() {
  const FIXTURE = path.join(__dirname, "fixtures", "booking-site", "index.html");
  const bookings = [];
  let pageLoads = 0;
  const verifyPosts = [];
  const VERIFY_PAGE = `<!doctype html><meta charset=utf-8><title>Confirm your booking</title>
  <style>body{font:16px system-ui;margin:40px} .box{width:40px;height:48px;font-size:24px;text-align:center;margin-right:6px} #step2{display:none}</style>
  <h1>Confirm your booking</h1>
  <div id=step1><label>Mobile number <input id=phone type=tel name=phone></label> <button id=send>Text me a code</button></div>
  <div id=step2><p>We texted a 6-digit code to •••• 3210 to confirm your booking.</p>
  <form id=f onsubmit="return false"><div id=boxes></div><button id=verify type=button>Verify</button></form><p id=msg></p></div>
  <script>
  const boxes = document.getElementById("boxes");
  for (let i = 0; i < 6; i++) { const b = document.createElement("input"); b.className = "box"; b.maxLength = 1; b.inputMode = "numeric"; if (i === 0) b.autocomplete = "one-time-code"; b.addEventListener("input", () => { if (b.value && b.nextElementSibling) b.nextElementSibling.focus(); }); boxes.appendChild(b); }
  document.getElementById("send").onclick = () => { document.getElementById("step1").style.display = "none"; document.getElementById("step2").style.display = "block"; };
  document.getElementById("verify").onclick = () => {
    const code = Array.from(document.querySelectorAll(".box")).map((b) => b.value).join("");
    fetch("/api/verify", { method: "POST", body: code }).then(() => { document.getElementById("msg").textContent = code === "427199" ? "Phone verified. Your booking is confirmed." : "That code is wrong. Try again."; });
  };
  </script>`;

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
        if (req.method === "POST" && req.url === "/api/verify") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            verifyPosts.push(body);
            res.writeHead(200);
            res.end("{}");
          });
          return;
        }
        if (req.url === "/verify") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(VERIFY_PAGE);
        }
        if (req.url === "/") pageLoads += 1;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (req.url.startsWith("/recaptcha/")) return res.end("<!doctype html><body style='margin:0;background:#f9f9f9'>[captcha widget]</body>");
        if (req.url === "/captcha") {
          return res.end("<!doctype html><h1>One more step</h1><button id=go>Continue</button><iframe src='/recaptcha/api2/anchor?k=test&size=normal' width='304' height='78'></iframe>");
        }
        res.end(fs.readFileSync(FIXTURE));
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }


  return {
    serve,
    bookings,
    verifyPosts,
    pageLoads: () => pageLoads,
  };
}

module.exports = { createBookingSite };
