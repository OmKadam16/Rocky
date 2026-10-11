// Rocky Memory extension: pure helpers (no chrome.* here, so they're tested).

export const DEFAULT_PORT = 47821;
export const QUEUE_MAX = 25;
export const DEDUPE_MS = 6 * 60 * 60 * 1000;
export const MAX_TEXT = 20000;

/** Same list as electron/memoryStore.cjs DEFAULT_EXCLUDED (a test keeps them equal). */
export const DEFAULT_EXCLUDED = [
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "mail.proton.me", "proton.me", "icloud.com",
  "accounts.google.com", "login.microsoftonline.com", "appleid.apple.com",
  "1password.com", "lastpass.com", "bitwarden.com", "dashlane.com", "keepersecurity.com",
  "paypal.com", "venmo.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "capitalone.com", "citi.com", "americanexpress.com",
  "discover.com", "usbank.com", "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com", "coinbase.com", "hdfcbank.com", "icicibank.com", "sbi.co.in",
  "mychart.com", "myhealth.va.gov", "patient.info",
];
export const EXCLUDED_WORDS = /(^|[.-])(bank|banking|netbanking|ebanking|mychart|patientportal|healthportal|login|signin|auth|sso|webmail|mail)([.-]|$)|bank/;

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const matches = (host, d) => {
  const x = String(d).trim().toLowerCase().replace(/^\*\.|^www\./, "");
  return Boolean(x) && (host === x || host.endsWith(`.${x}`));
};

/** Only ordinary web pages that aren't excluded (defaults + the user's list). */
export function shouldCapture(url, userExcluded = []) {
  if (!/^https?:\/\//i.test(String(url || ""))) return false;
  const host = hostOf(url);
  if (!host || host === "127.0.0.1" || host === "localhost") return false;
  if (DEFAULT_EXCLUDED.some((d) => matches(host, d)) || userExcluded.some((d) => matches(host, d))) return false;
  return !EXCLUDED_WORDS.test(host);
}

/** The origin pattern to ask permission for / check against. */
export const originPattern = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
};

/** Small offline queue: newest kept, screenshots dropped to stay small. */
export function enqueue(queue, item) {
  const { screenshot: _drop, ...small } = item;
  void _drop;
  return [...queue, { ...small, queuedAt: Date.now() }].slice(-QUEUE_MAX);
}

/** Recently-sent keys within the dedupe window (pruned). */
export function seenRecently(recent, key, now = Date.now()) {
  const kept = Object.fromEntries(Object.entries(recent || {}).filter(([, t]) => now - t < DEDUPE_MS));
  return { seen: key in kept, recent: kept };
}

export function cleanText(s) {
  return String(s || "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);
}
