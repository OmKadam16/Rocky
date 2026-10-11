// Build guard for the phone address (VITE_PUBLIC_URL). The desktop app is
// served from app://rocky, which a phone can't open, so the Devices screen
// needs the real website address. Pure: unit-tested in publicUrlGuard.test.mjs.
//
//   { level: "ok" | "warn" | "error", message }
// error: set but unusable (not http(s)) -> the build stops.
// warn:  unset (Om can still paste it in Devices -> "Phone site address"),
//        or an address a phone can't use well (localhost, LAN, plain http).
//        With strict=true (ROCKY_REQUIRE_PUBLIC_URL=1) an unset value is an error.
export function checkPublicUrl(value, { strict = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    const message =
      "VITE_PUBLIC_URL is not set. The desktop app can't show your phone where to go: " +
      "set VITE_PUBLIC_URL=https://<your Rocky site> in .env.local, or paste it later in " +
      "Profile -> Devices -> Phone site address.";
    return { level: strict ? "error" : "warn", message };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { level: "error", message: `VITE_PUBLIC_URL is not a valid address: ${raw}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { level: "error", message: `VITE_PUBLIC_URL must be an http(s) website address, not ${u.protocol}//` };
  }
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
    return { level: "warn", message: `VITE_PUBLIC_URL=${raw} only works on this computer; a phone can't open it.` };
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || u.protocol === "http:") {
    return { level: "warn", message: `VITE_PUBLIC_URL=${raw} is a home-network or plain-http address: the phone needs the same Wi-Fi and its mic needs https.` };
  }
  return { level: "ok", message: `Phone address: ${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

/** Big, hard-to-miss console banner. */
export function banner(level, message) {
  const line = "=".repeat(78);
  return `\n${line}\n${level === "error" ? "BUILD STOPPED" : "WARNING"}: ${message}\n${line}\n`;
}
