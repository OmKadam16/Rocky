"use strict";
/**
 * Memory questions, parsed in code: the time range, the keywords, a site
 * filter, and whether the user means their searches. Deterministic, no model.
 * (The local Qwen may be asked to extract keywords only when this finds
 * nothing to search on; the cloud planner never sees any of it.)
 *
 * Pure: no Electron, no network. Times are local wall-clock.
 */

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const range = (from, to, label) => ({ from: from.getTime(), to: to.getTime() - 1, label });

const monthIndex = (w) => MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));

/** The time range a question talks about, or null for "any time". */
function parseTimeRange(text, now = new Date()) {
  const t = ` ${String(text).toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ")} `;
  const today = startOfDay(now);
  const at = (h) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h);

  if (/ this morning /.test(t)) return range(today, at(12), "this morning");
  if (/ this afternoon /.test(t)) return range(at(12), at(18), "this afternoon");
  if (/ (this evening|tonight) /.test(t)) return range(at(17), addDays(today, 1), "this evening");
  if (/ last night /.test(t)) {
    const y = addDays(today, -1);
    return range(new Date(y.getFullYear(), y.getMonth(), y.getDate(), 18), at(4), "last night");
  }
  if (/ (the )?day before yesterday /.test(t)) return range(addDays(today, -2), addDays(today, -1), "the day before yesterday");
  if (/ yesterday /.test(t)) return range(addDays(today, -1), today, "yesterday");
  if (/ today /.test(t)) return range(today, addDays(today, 1), "today");

  let m = t.match(/ (?:last|past) (\d{1,2}|two|three|four|five|six|seven|ten|fourteen) days /);
  if (m) {
    const n = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 }[m[1]] ?? Number(m[1]);
    return range(addDays(today, -n), addDays(today, 1), `the last ${n} days`);
  }
  if (/ (a few|couple of|couple) days ago /.test(t)) return range(addDays(today, -4), addDays(today, -1), "a few days ago");

  // Weekday: "on Tuesday", "last Tuesday", "Tuesday" → the most recent one.
  m = t.match(/ (last |on |this past )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s? /);
  if (m) {
    const want = WEEKDAYS.indexOf(m[2]);
    let back = (today.getDay() - want + 7) % 7;
    if (back === 0 && m[1] === "last ") back = 7;
    const d = addDays(today, -back);
    return range(d, addDays(d, 1), m[2].charAt(0).toUpperCase() + m[2].slice(1));
  }

  // Monday-based weeks.
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  if (/ last week /.test(t)) return range(addDays(monday, -7), monday, "last week");
  if (/ this week /.test(t)) return range(monday, addDays(today, 1), "this week");
  if (/ (last|past) month /.test(t)) {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return range(first, new Date(today.getFullYear(), today.getMonth(), 1), "last month");
  }
  if (/ this month /.test(t)) return range(new Date(today.getFullYear(), today.getMonth(), 1), addDays(today, 1), "this month");

  // "on September 3", "3 September", "Sept 3rd".
  m = t.match(/ (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)? /) || null;
  let month = -1;
  let dayNum = 0;
  if (m) {
    month = monthIndex(m[1]);
    dayNum = Number(m[2]);
  } else {
    const m2 = t.match(/ (\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* /);
    if (m2) {
      month = monthIndex(m2[2]);
      dayNum = Number(m2[1]);
    }
  }
  if (month >= 0 && dayNum >= 1 && dayNum <= 31) {
    let d = new Date(today.getFullYear(), month, dayNum);
    if (d > today) d = new Date(today.getFullYear() - 1, month, dayNum);
    return range(d, addDays(d, 1), `${MONTHS[month].charAt(0).toUpperCase() + MONTHS[month].slice(1)} ${dayNum}`);
  }

  // "in September" (most recent past one), optionally with a year.
  m = t.match(/ in (january|february|march|april|may|june|july|august|september|october|november|december)(?: (\d{4}))? /);
  if (m) {
    const mi = MONTHS.indexOf(m[1]);
    let year = m[2] ? Number(m[2]) : today.getFullYear();
    if (!m[2] && new Date(year, mi, 1) > today) year -= 1;
    return range(new Date(year, mi, 1), new Date(year, mi + 1, 1), `${m[1].charAt(0).toUpperCase() + m[1].slice(1)}${m[2] ? ` ${m[2]}` : ""}`);
  }
  if (/ recently | lately /.test(t)) return range(addDays(today, -14), addDays(today, 1), "recently");
  return null;
}

const SITES = {
  youtube: "youtube.com",
  reddit: "reddit.com",
  github: "github.com",
  wikipedia: "wikipedia.org",
  twitter: "x.com",
  amazon: "amazon.com",
  medium: "medium.com",
  "stack overflow": "stackoverflow.com",
  stackoverflow: "stackoverflow.com",
  "new york times": "nytimes.com",
  nytimes: "nytimes.com",
  "hacker news": "news.ycombinator.com",
  arxiv: "arxiv.org",
};

const STOP = new Set(
  `a an the i me my mine we you your it its this that these those is was were be been am are do did does done what which who whom when where why how
  about on in at of for to from with by into onto over under up down out off again so very just really any some something anything thing things stuff
  read reading saw see seen seeing look looked looking looks watch watched watching visit visited visiting browse browsed browsing open opened
  find found show tell remind remember recall get got give search searched searching google googled look up
  article articles page pages post posts site website websites link links video videos thing piece story blog
  today yesterday tonight morning afternoon evening night week month day days ago last past this recently lately earlier before
  sunday monday tuesday wednesday thursday friday saturday january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  can could would should will please there here was were had have has like one ones kind sort couple few`.split(/\s+/),
);

/** Content words to search on (lower-case, deduped, max 8). */
function extractKeywords(text) {
  let t = ` ${String(text).toLowerCase()} `;
  for (const s of Object.keys(SITES)) t = t.replace(new RegExp(` (on|from|at) ${s} `, "g"), " ");
  const words = t.replace(/[^\p{L}\p{N}.+#-]+/gu, " ").split(/\s+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, ""));
  const out = [];
  for (const w of words) {
    if (!w || w.length < 2 || STOP.has(w) || /^\d{1,2}(st|nd|rd|th)?$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

function siteFilter(text) {
  const t = ` ${String(text).toLowerCase()} `;
  for (const [name, domain] of Object.entries(SITES)) if (t.includes(` ${name} `)) return domain;
  const m = t.match(/ (?:on|from|at) ([a-z0-9-]+\.(?:com|org|net|io|dev|ai|co|edu|gov)) /);
  return m ? m[1] : null;
}

/** "What did I search for…" means the user's searches, not pages read. */
const wantsSearches = (text) => /\b(search(ed)? for|did i (search|google)|googled|look(ed)? up)\b/i.test(String(text));

/** Everything search needs, parsed from the question. */
function parseMemoryQuery(text, now = new Date()) {
  const time = parseTimeRange(text, now);
  return { keywords: extractKeywords(text), time, domain: siteFilter(text), searches: wantsSearches(text) };
}

const SEARCH_URL = /(^|\.)google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/.*[?&]q=|youtube\.com\/results/;

/** The search terms in a search-results URL, or null. */
function searchTermsOf(url) {
  try {
    const u = new URL(url);
    if (!SEARCH_URL.test(`${u.hostname}${u.pathname}${u.search}`)) return null;
    const q = u.searchParams.get("q") || u.searchParams.get("search_query");
    return q ? q.trim() : null;
  } catch {
    return null;
  }
}

module.exports = { parseTimeRange, extractKeywords, siteFilter, wantsSearches, parseMemoryQuery, searchTermsOf, DAY };
