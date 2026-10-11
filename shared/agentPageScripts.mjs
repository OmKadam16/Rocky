/**
 * Booking agent page probes and timing constants, shared by the desktop agent
 * window (electron/agentWindow.cjs) and the Android agent browser
 * (src/lib/agentAndroid.ts). Every script is read-only except the code-field
 * marking (data-rocky-code) and never reads a field's value.
 */

/** Runs in each frame. Small and side-effect free. */
const POINT_JS = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  // The overlay test (a fixed full-page banner): the element itself or any
  // ancestor up to <body> may be the fixed layer (a static dialog inside a
  // fixed backdrop is still a banner). Reports that layer's box.
  const overlayBox = (() => { try {
    let n = el;
    for (let depth = 0; n && n !== document.body && depth < 6; depth += 1) {
      const cs = getComputedStyle(n);
      if (cs.position === "fixed" || cs.position === "sticky") {
        const r = n.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }
      n = n.parentElement;
    }
    return null;
  } catch (e) { return null; } })();
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
    const r = el.getBoundingClientRect();
    return { frame: Array.from(document.querySelectorAll("iframe,frame")).indexOf(el), left: r.left, top: r.top, overlay: overlayBox };
  }
  const t = el.closest('button,a,input,select,textarea,label,[role=button],[role=link],[role=option],[onclick]') || el;
  const tag = t.tagName.toLowerCase();
  const type = (t.getAttribute("type") || "").toLowerCase();
  const isSubmit = (tag === "button" && (type === "" || type === "submit") && !!t.form) || (tag === "input" && (type === "submit" || type === "image"));
  return {
    tag,
    text: (t.innerText || t.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
    ariaLabel: (t.getAttribute("aria-label") || "").slice(0, 120),
    value: tag === "input" && (type === "submit" || type === "button") ? String(t.value || "").slice(0, 120) : "",
    isSubmit,
    overlay: overlayBox,
  };
})()`;

const FOCUS_JS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { frame: Array.from(document.querySelectorAll("iframe,frame")).indexOf(el) };
  const byId = (ids) => (ids || "").split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
  const label = (el.labels && el.labels[0] && el.labels[0].innerText) || byId(el.getAttribute("aria-labelledby")) || "";
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : "")).toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    placeholder: el.getAttribute("placeholder") || "",
    label: label.replace(/\\s+/g, " ").trim().slice(0, 120),
    ariaLabel: el.getAttribute("aria-label") || "",
  };
})()`;

const PROBE_JS = `(() => {
  const CAPTCHA_SRC = /recaptcha\\/api2\\/(anchor|bframe)|hcaptcha|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha/i;
  const CARD_SRC = /js\\.stripe\\.com\\/v3\\/elements-inner-(card|payment)|hosted-fields|securedfields|pci-connect\\.squareup\\.com|checkout\\.com/i;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
  const q = (s) => Array.from(document.querySelectorAll(s)).filter(vis);
  const text = (document.body ? document.body.innerText : "").slice(0, 4000);
  // Change signature for did-that-click-do-anything checks: lengths and
  // counts only, never values (passwords excluded entirely).
  const formState = (() => { try {
    const checked = document.querySelectorAll('input[type=checkbox]:checked,input[type=radio]:checked').length;
    const selects = Array.from(document.querySelectorAll("select")).map((e) => e.selectedIndex).join(",");
    let len = 0;
    document.querySelectorAll("input:not([type=password]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]),textarea").forEach((e) => { len += String(e.value || "").length; });
    return checked + "|" + selects + "|" + len;
  } catch (e) { return ""; } })();
  return {
    textLen: document.body ? document.body.innerText.length : 0,
    formState,
    hasPassword: q('input[type=password]').length > 0,
    // Visible, widget-sized only: invisible reCAPTCHA v3 / Stripe controller
    // frames load on ordinary pages and must not trigger a takeover.
    hasCaptcha: q('.g-recaptcha,.h-captcha,.cf-turnstile,iframe').some((e) => {
      const r = e.getBoundingClientRect();
      const src = e.tagName === "IFRAME" ? (e.getAttribute("src") || "") : "captcha";
      return r.width >= 100 && r.height >= 60 && !/size=invisible/.test(src) && (e.tagName !== "IFRAME" || CAPTCHA_SRC.test(src));
    }) || /verify (that )?you are (a )?human|i'm not a robot/i.test(text),
    hasCardField: q('input[autocomplete^="cc-"],input[name*="cardnumber" i],input[id*="cardnumber" i],input[name*="card_number" i],input[name*="cvv" i],input[name*="cvc" i]').length > 0
      || q('iframe').some((e) => CARD_SRC.test(e.getAttribute("src") || "") && e.getBoundingClientRect().height >= 20),
    hasTwoFactor: q('input[autocomplete="one-time-code"]').length > 0,
  };
})()`;

/**
 * Milliseconds since the page last changed in a way that matters (nodes
 * added/removed, text, disabled/busy/hidden flips). Installs its observer on
 * first call per document. Style/class churn (carousels, spinners' CSS) is
 * ignored, or an animated page would never look settled.
 */
const QUIET_JS = `(() => {
  const w = window;
  if (!w.__rockyQuiet || w.__rockyQuiet.doc !== document) {
    w.__rockyQuiet = { doc: document, last: performance.now() };
    try {
      new MutationObserver(() => { w.__rockyQuiet.last = performance.now(); }).observe(document, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["disabled", "aria-busy", "aria-expanded", "hidden", "open", "value"],
      });
    } catch (e) {}
  }
  return Math.round(performance.now() - w.__rockyQuiet.last);
})()`;

/** Settling: page quiet for QUIET_MS, no request in flight, capped. */
const QUIET_MS = 250;
const SETTLE_CAP_MS = 2000;
/** A top-level page load in progress gets a little longer before we shoot. */
const NAV_CAP_MS = 4000;
/** Requests older than this are long-polls / streams, not "loading". */
const STALE_REQUEST_MS = 1500;

const SHOT_JPEG_QUALITY = 85;

/**
 * Finds the one-time-code field(s): autocomplete="one-time-code" first, else
 * inputs labelled code/OTP/verification (never promo/coupon/zip), else a row
 * of 4-8 one-character boxes. Marks them data-rocky-code="0..n" (so fillCode
 * can focus them) and returns the text of their form/dialog for the
 * booking-contact vs sign-in decision. Never reads any value.
 */
const CODE_CTX_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none"; };
  const skip = new Set(["hidden", "submit", "button", "checkbox", "radio", "password", "email", "file", "image", "reset", "range", "color", "date", "time"]);
  const inputs = Array.from(document.querySelectorAll("input")).filter((e) => vis(e) && !skip.has((e.getAttribute("type") || "").toLowerCase()));
  const desc = (e) => [e.name, e.id, e.getAttribute("autocomplete"), e.placeholder, e.getAttribute("aria-label"), e.labels && e.labels[0] ? e.labels[0].innerText : ""].join(" ").toLowerCase();
  const notCode = /promo|coupon|discount|gift|voucher|zip|postal|post code|country|area code|dial/;
  let fields = inputs.filter((e) => (e.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code");
  if (!fields.length) fields = inputs.filter((e) => /otp|one[- ]?time|verification|verify|\\bcode\\b|\\bpin\\b/.test(desc(e)) && !notCode.test(desc(e)));
  const singles = inputs.filter((e) => e.maxLength === 1);
  if ((fields.length <= 1 && singles.length >= 4 && singles.length <= 8) && (!fields.length || fields[0].maxLength === 1)) fields = singles;
  document.querySelectorAll("[data-rocky-code]").forEach((e) => e.removeAttribute("data-rocky-code"));
  if (!fields.length) return null;
  fields.forEach((e, i) => e.setAttribute("data-rocky-code", String(i)));
  let root = fields[0].closest("form,[role=dialog],dialog");
  if (!root) { root = fields[0]; for (let i = 0; i < 4 && root.parentElement && root.parentElement !== document.body; i += 1) root = root.parentElement; }
  return {
    count: fields.length,
    split: fields.length >= 4 && fields.every((e) => e.maxLength === 1),
    text: (root.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 1500),
    hasPassword: !!root.querySelector("input[type=password]"),
  };
})()`;

/** Focus code box i and select what's in it (a retry overwrites the old code). */
const FOCUS_CODE_JS = (i) => `(() => {
  const e = document.querySelector('[data-rocky-code="${i}"]');
  if (!e) return false;
  e.focus();
  try { e.select(); } catch (err) {}
  return document.activeElement === e;
})()`;

/** Current scroll position, for waiting out an animated scroll before shooting. */
const SCROLL_POS_JS = `[window.scrollX, window.scrollY].join(",")`;

/** How many characters the code field(s) hold in total (never the values). */
const CODE_LEN_JS = `Array.from(document.querySelectorAll("[data-rocky-code]")).reduce((n, e) => n + String(e.value || "").length, 0)`;

/** Characters in code box i (never the value). */
const BOX_LEN_JS = (i) => `(() => { const e = document.querySelector('[data-rocky-code="${i}"]'); return e ? String(e.value || "").length : -1; })()`;

/** After a click on the model's point: is an input focused? Mark it. */
const MARK_FOCUSED_JS = `(() => {
  const e = document.activeElement;
  if (!e || e.tagName !== "INPUT" || (e.getAttribute("type") || "").toLowerCase() === "password") return false;
  document.querySelectorAll("[data-rocky-code]").forEach((x) => x.removeAttribute("data-rocky-code"));
  e.setAttribute("data-rocky-code", "0");
  try { e.select(); } catch (err) {}
  return true;
})()`;

/** Code fields show dots, so screenshots (model and evidence) never show the digits. */
const MASK_CSS = "[data-rocky-code]{-webkit-text-security:disc !important;}";

const TEXT_JS = `(document.body ? document.body.innerText : "").slice(0, 20000)`;

export {
  POINT_JS,
  FOCUS_JS,
  PROBE_JS,
  SCROLL_POS_JS,
  QUIET_JS,
  QUIET_MS,
  SETTLE_CAP_MS,
  NAV_CAP_MS,
  STALE_REQUEST_MS,
  SHOT_JPEG_QUALITY,
  CODE_CTX_JS,
  FOCUS_CODE_JS,
  CODE_LEN_JS,
  BOX_LEN_JS,
  MARK_FOCUSED_JS,
  MASK_CSS,
  TEXT_JS,
};
