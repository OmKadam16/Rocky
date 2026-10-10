import { useCallback, useEffect, useRef, useState } from "react";
import { isSupabaseConfigured, supabase, uniqueChannel } from "../lib/supabase";
import { setSecret } from "../lib/secrets";
import {
  deviceOnline,
  formatSeenAgo,
  readPairDevices,
  unpairPhone,
  publishLaptopPairing,
  type PairDeviceRow,
  type PairError,
} from "../lib/devices";
import {
  defaultLaptopName,
  farFuturePairExpiry,
  formatPairCode,
  generateSecurePairCode,
  shouldReusePairCode,
} from "../lib/pairing";
import { detectPairClaim } from "../lib/pairClaim";

type Status = "waiting" | "confirming" | "connected" | "offline";

/** Taps on the code within this window reveal the hidden rotate panel. */
const ROTATE_TAPS_NEEDED = 5;
const ROTATE_TAPS_WINDOW_MS = 2000;

const STATUS_COPY: Record<Status, { title: string; body: string }> = {
  waiting: { title: "Waiting for your phone", body: "Enter this code on your phone under Remote. This code is yours and doesn't change." },
  confirming: { title: "Phone found", body: "Finishing pairing…" },
  connected: { title: "You're connected", body: "Your phone is paired. Say something on your phone to test it." },
  offline: { title: "Can't reach the relay", body: "Check your connection and retry." },
};

/**
 * Laptop Profile → Devices section, in v1 visual language.
 * One static 8-char code per user (no QR): the laptop row's code is reused
 * forever and only changes via Rotate. Claim detection via Realtime + 2 s
 * poll (a fresh phone row after this code's creation).
 */
export default function DevicesSection() {
  const [code, setCode] = useState("");
  const [codeReady, setCodeReady] = useState(false);
  const [laptopName, setLaptopName] = useState(() => defaultLaptopName());
  const [status, setStatus] = useState<Status>("waiting");
  const [copied, setCopied] = useState(false);
  const [phoneName, setPhoneName] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ laptop: PairDeviceRow | null; phone: PairDeviceRow | null }>({
    laptop: null,
    phone: null,
  });
  const [published, setPublished] = useState(false);
  const [publishError, setPublishError] = useState<PairError | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [epoch, setEpoch] = useState(0);
  const [showRotate, setShowRotate] = useState(false);
  const [confirmAction, setConfirmAction] = useState<null | "code" | "keys">(null);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateMsg, setRotateMsg] = useState<string | null>(null);
  const createdAt = useRef(Date.now());
  const timers = useRef<number[]>([]);
  const taps = useRef<number[]>([]);
  const laptopNameRef = useRef(laptopName);
  laptopNameRef.current = laptopName;

  const doPublish = useCallback(async (c: string, e: number) => {
    const res = await publishLaptopPairing(c, e, laptopNameRef.current);
    setPublishError(res.ok ? null : res.failure);
    setPublished(res.ok);
  }, []);

  // Load-or-create the static code on mount: reuse the row's code whenever
  // usable, generating only once. Republishing refreshes last_seen and bumps
  // legacy expiries to far-future without changing the code.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let alive = true;
    void (async () => {
      try {
        const rows = await readPairDevices();
        if (!alive) return;
        setDevices(rows);
        if (rows.laptop?.name) setLaptopName(rows.laptop.name);
        const existing = rows.laptop?.pair_code ?? null;
        const c = shouldReusePairCode(existing) ? existing!.toUpperCase() : generateSecurePairCode();
        createdAt.current = Date.now();
        setCode(c);
        setCodeReady(true);
        void doPublish(c, farFuturePairExpiry());
      } catch {
        if (alive) setCodeReady(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Claim detection: Realtime on devices + 2 s poll, both via detectPairClaim.
  useEffect(() => {
    if (!isSupabaseConfigured || publishError || !codeReady || !code) return;
    const sb = supabase();
    let alive = true;
    let settled = false;
    let pollId = 0;
    const myCode = code;
    const bornAt = createdAt.current;

    const onClaim = (name: string | null, rows: { laptop: PairDeviceRow | null; phone: PairDeviceRow | null }) => {
      if (!alive || settled) return;
      settled = true;
      if (pollId) window.clearInterval(pollId);
      setDevices(rows);
      if (name) setPhoneName(name);
      setStatus((s) => (s === "waiting" || s === "confirming" ? "confirming" : s));
      const t = window.setTimeout(() => {
        if (!alive) return;
        setStatus((s) => (s === "confirming" ? "connected" : s));
      }, 2200);
      timers.current.push(t);
    };

    const check = async () => {
      if (!alive || settled) return;
      try {
        const rows = await readPairDevices();
        if (!alive || settled) return;
        setDevices(rows);
        const res = detectPairClaim(rows.laptop, rows.phone, { publishedCode: myCode, published, createdAtMs: bornAt });
        if (res.claimed) onClaim(res.phoneName, rows);
      } catch {
        /* keep polling — Realtime may still fire */
      }
    };

    pollId = window.setInterval(() => void check(), 2000);
    void check();
    const channel = sb
      .channel(uniqueChannel("pair-claim"))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "devices" }, () => void check())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "devices" }, () => void check())
      .subscribe();
    return () => {
      alive = false;
      if (pollId) window.clearInterval(pollId);
      void sb.removeChannel(channel);
    };
  }, [code, codeReady, published, publishError, epoch]);

  // Fresh "seen ago" labels without hitting the relay.
  useEffect(() => {
    if (!devices.laptop && !devices.phone) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, [devices.laptop, devices.phone]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const unpair = useCallback(async () => {
    setUnpairError(null);
    setUnpairing(true);
    try {
      await unpairPhone();
    } catch (e) {
      setUnpairError(e instanceof Error ? e.message : "Could not unpair.");
      setUnpairing(false);
      return;
    }
    setUnpairing(false);
    // The code stays the same — only the phone row goes away.
    setPhoneName(null);
    setStatus("waiting");
    setEpoch((e) => e + 1);
    try {
      setDevices(await readPairDevices());
    } catch {
      /* poll refreshes */
    }
  }, []);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formatPairCode(code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [code]);

  const onCodeTap = useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current, now].filter((t) => now - t <= ROTATE_TAPS_WINDOW_MS);
    if (taps.current.length >= ROTATE_TAPS_NEEDED) {
      taps.current = [];
      setRotateMsg(null);
      setConfirmAction(null);
      setShowRotate((v) => !v);
    }
  }, []);

  const rotateCode = useCallback(async () => {
    setRotateBusy(true);
    setRotateMsg(null);
    try {
      // Rotating disconnects the phone: it must enter the new code to pair again.
      try {
        await unpairPhone();
      } catch {
        /* keep going — the new code still invalidates the old one */
      }
      const c = generateSecurePairCode();
      createdAt.current = Date.now();
      setCode(c);
      setPhoneName(null);
      setDevices({ laptop: devices.laptop, phone: null });
      setStatus("waiting");
      setShowRotate(false);
      setConfirmAction(null);
      setEpoch((e) => e + 1);
      await doPublish(c, farFuturePairExpiry());
      setRotateMsg("Code rotated. The phone was signed out — enter the new code on it to pair again.");
    } catch (e) {
      setRotateMsg(e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    } finally {
      setRotateBusy(false);
    }
  }, [devices.laptop, doPublish]);

  const wipeKeys = useCallback(async () => {
    setRotateBusy(true);
    setRotateMsg(null);
    let cloudError: string | null = null;
    for (const name of ["llm_key", "el_key"] as const) {
      try {
        // Clears the device store AND syncs the null to the shared profile row.
        await setSecret(name, null);
      } catch (e) {
        cloudError = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
      }
    }
    setRotateBusy(false);
    setShowRotate(false);
    setConfirmAction(null);
    setRotateMsg(
      cloudError
        ? `Local keys cleared, but the cloud wipe failed: ${cloudError}`
        : "Keys wiped on this device and in the cloud. Enter new keys in onboarding or Profile — and revoke the old ones at the provider dashboards.",
    );
  }, []);

  if (!isSupabaseConfigured) {
    return (
      <div className="rounded-[3px] border border-line px-[18px] py-[15px]">
        <div className="min-w-0 flex-1 text-[15px] text-ink">Phone</div>
        <div className="mt-[6px] font-mono text-[10.5px] leading-[1.5] text-grey-soft text-pretty">
          Phone pairing needs Supabase — add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then sign in.
        </div>
      </div>
    );
  }

  const meta = STATUS_COPY[status];

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[3px] border border-line px-[18px] py-[15px]">
        <div className="flex items-baseline gap-[14px]">
          <div className="min-w-0 flex-1 text-[15px] text-ink">Connect your phone</div>
          <div className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-accent">Connected</div>
        </div>
        <div className="mt-[6px] font-mono text-[10.5px] leading-[1.5] text-grey-soft text-pretty">
          {meta.title} — {meta.body}
        </div>
        {publishError ? (
          <div className="mt-3">
            <div className="font-mono text-[10.5px] leading-[1.5] text-warm">
              Couldn’t save the code ({publishError.kind}): {publishError.message}
            </div>
            <button
              type="button"
              onClick={() => code && void doPublish(code, farFuturePairExpiry())}
              className="mt-2 cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink"
            >
              Retry
            </button>
          </div>
        ) : !codeReady || !code ? (
          <div className="mt-3 font-mono text-[11px] text-grey">Preparing your code…</div>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={onCodeTap}
                title="Pairing code"
                className="cursor-pointer font-mono text-[28px] tracking-[0.1em]"
              >
                {formatPairCode(code)}
              </button>
              <button
                type="button"
                onClick={() => void copyCode()}
                className="cursor-pointer rounded-[3px] border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:border-ink hover:text-ink"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-2 text-center font-mono text-[10.5px] text-grey-soft">
              Enter this code on your phone under Remote. This laptop is named{" "}
              <input
                value={laptopName}
                onChange={(e) => setLaptopName(e.target.value.slice(0, 40))}
                aria-label="Laptop name"
                className="w-[130px] rounded-[3px] border border-line-strong bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink outline-none"
              />
            </div>
            <div className="mt-2 flex items-center justify-center">
              <button
                type="button"
                onClick={() => {
                  setRotateMsg(null);
                  setConfirmAction("code");
                  setShowRotate(true);
                }}
                className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink"
              >
                Rotate code
              </button>
            </div>
            {(status === "confirming" || status === "connected") && phoneName && (
              <div className="mt-2 text-center font-mono text-[11px] text-accent-deep">
                {status === "connected" ? `Paired with ${phoneName}.` : `Found ${phoneName}…`}
              </div>
            )}
            {showRotate && (
              <div className="mt-3 rounded-[3px] border border-dashed border-line-strong bg-panel px-3 py-3">
                <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Hidden rotate (leak response)</div>
                {rotateMsg && <div className="mt-2 font-mono text-[11px] leading-[1.5] text-grey">{rotateMsg}</div>}
                {confirmAction === null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmAction("code")}
                      className="cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink"
                    >
                      Rotate pairing code
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAction("keys")}
                      className="cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-warm hover:border-ink"
                    >
                      Wipe API keys everywhere
                    </button>
                  </div>
                )}
                {confirmAction === "code" && (
                  <div className="mt-2">
                    <p className="font-mono text-[11px] leading-[1.5] text-grey">
                      Old codes stop working and the phone is signed out — it must enter the new code. Paired phones do not carry over. Continue?
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void rotateCode()}
                        disabled={rotateBusy}
                        className="cursor-pointer rounded-[3px] bg-ink px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-canvas disabled:opacity-60"
                      >
                        {rotateBusy ? "Rotating…" : "Yes, rotate"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {confirmAction === "keys" && (
                  <div className="mt-2">
                    <p className="font-mono text-[11px] leading-[1.5] text-grey">
                      Clears keys on this device and in the cloud — all devices go keyless until new keys are entered. Also revoke them at the provider dashboards. Continue?
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void wipeKeys()}
                        disabled={rotateBusy}
                        className="cursor-pointer rounded-[3px] bg-ink px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-canvas disabled:opacity-60"
                      >
                        {rotateBusy ? "Wiping…" : "Yes, wipe keys"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {(devices.laptop || devices.phone) && (
        <div className="rounded-[3px] border border-line px-[18px] py-[15px]">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Paired devices</div>
          <ul className="mt-2 flex list-none flex-col gap-2.5 p-0">
            {devices.laptop && (
              <li className="flex items-center gap-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-[14px] font-medium">
                    <span
                      aria-label={deviceOnline(devices.laptop.last_seen, nowMs) ? "online" : "offline"}
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: deviceOnline(devices.laptop.last_seen, nowMs) ? "var(--color-accent)" : "var(--color-grey-faint)" }}
                    />
                    <span className="truncate">{devices.laptop.name ?? laptopName}</span>
                  </span>
                  <span className="font-mono text-[10.5px] text-grey-soft">This laptop · {formatSeenAgo(devices.laptop.last_seen, nowMs)}</span>
                </span>
              </li>
            )}
            {devices.phone && (
              <li className="flex items-center gap-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-[14px] font-medium">
                    <span
                      aria-label={deviceOnline(devices.phone.last_seen, nowMs) ? "online" : "offline"}
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: deviceOnline(devices.phone.last_seen, nowMs) ? "var(--color-accent)" : "var(--color-grey-faint)" }}
                    />
                    <span className="truncate">{devices.phone.name ?? "Phone"}</span>
                  </span>
                  <span className="font-mono text-[10.5px] text-grey-soft">Phone · {formatSeenAgo(devices.phone.last_seen, nowMs)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void unpair()}
                  disabled={unpairing}
                  className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:border-ink hover:text-ink disabled:opacity-50"
                >
                  {unpairing ? "Unpairing…" : "Unpair"}
                </button>
              </li>
            )}
          </ul>
          {unpairError && (
            <div role="alert" className="mt-2 font-mono text-[10.5px] text-warm">
              {unpairError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
