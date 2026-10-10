import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { isSupabaseConfigured, supabase, uniqueChannel } from "../lib/supabase";
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
  PAIR_EXPIRY_SEC,
  buildPairUrl,
  defaultLaptopName,
  formatCountdown,
  formatPairCode,
  freshPairExpiry,
  generateSecurePairCode,
  resolvePairOrigin,
} from "../lib/pairing";
import { detectPairClaim } from "../lib/pairClaim";

type Status = "waiting" | "confirming" | "connected" | "expired" | "offline";

const STATUS_COPY: Record<Status, { title: string; body: string }> = {
  waiting: { title: "Waiting for your phone", body: "Scan this code with Rocky on your phone. It expires in 5 minutes." },
  confirming: { title: "Phone found", body: "Finishing pairing…" },
  connected: { title: "You're connected", body: "Your phone is paired. Say something on your phone to test it." },
  expired: { title: "This code expired", body: "Codes last 5 minutes so nobody else can use them. Make a new one." },
  offline: { title: "Can't reach the relay", body: "Check your connection and retry." },
};

/**
 * Laptop Profile → Devices section, in v1 visual language.
 * QR encodes <site>/remote?pair=CODE; claim detection via Realtime +
 * 2 s poll (laptop pair_code becomes null on claim).
 */
export default function DevicesSection() {
  const [code, setCode] = useState(() => generateSecurePairCode());
  const [expiresAtMs, setExpiresAtMs] = useState(() => freshPairExpiry());
  const [laptopName, setLaptopName] = useState(() => defaultLaptopName());
  const [status, setStatus] = useState<Status>("waiting");
  const [secsLeft, setSecsLeft] = useState(PAIR_EXPIRY_SEC);
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
  const createdAt = useRef(Date.now());
  const timers = useRef<number[]>([]);
  const laptopNameRef = useRef(laptopName);
  laptopNameRef.current = laptopName;

  const siteOrigin = useMemo(
    () => resolvePairOrigin(import.meta.env.VITE_PUBLIC_URL as string | undefined, window.location.origin),
    [],
  );
  const pairUrl = useMemo(() => buildPairUrl(siteOrigin, code), [siteOrigin, code]);

  const doPublish = useCallback(async (c: string, e: number) => {
    const res = await publishLaptopPairing(c, e, laptopNameRef.current);
    setPublishError(res.ok ? null : res.failure);
    setPublished(res.ok);
  }, []);

  const resetPair = useCallback(
    (next?: { code: string; expiresAtMs: number }) => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
      const c = next?.code ?? generateSecurePairCode();
      const e = next?.expiresAtMs ?? freshPairExpiry();
      createdAt.current = Date.now();
      setCode(c);
      setExpiresAtMs(e);
      setSecsLeft(PAIR_EXPIRY_SEC);
      setStatus("waiting");
      setPhoneName(null);
      setDevices({ laptop: null, phone: null });
      setPublished(false);
      setUnpairError(null);
      setCopied(false);
      setPublishError(null);
      void doPublish(c, e);
    },
    [doPublish],
  );

  // Publish on mount.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void doPublish(code, expiresAtMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown → expiry.
  useEffect(() => {
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
      setSecsLeft(left);
      if (left <= 0) setStatus((s) => (s === "waiting" ? "expired" : s));
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAtMs]);

  // Claim detection: Realtime on devices + 2 s poll, both via detectPairClaim.
  useEffect(() => {
    if (!isSupabaseConfigured || publishError) return;
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
  }, [code, published, publishError]);

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
    resetPair();
  }, [resetPair]);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(formatPairCode(code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [code]);

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
  const ringFrac = secsLeft / PAIR_EXPIRY_SEC;
  const ringColor = status === "expired" ? "var(--color-warm)" : ringFrac < 0.2 ? "var(--color-warm)" : "var(--color-accent)";

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[3px] border border-line px-[18px] py-[15px]">
        <div className="flex items-baseline gap-[14px]">
          <div className="min-w-0 flex-1 text-[15px] text-ink">Connect your phone</div>
          <div className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">{formatCountdown(secsLeft)}</div>
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
              onClick={() => (expiresAtMs > Date.now() ? void doPublish(code, expiresAtMs) : resetPair())}
              className="mt-2 cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-grey hover:border-ink hover:text-ink"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="mt-3 flex justify-center rounded-[3px] bg-card p-4">
              <QRCodeSVG value={pairUrl} size={200} bgColor="#ffffff" fgColor="#000000" level="M" role="img" aria-label={`Pairing QR code for ${pairUrl}`} />
            </div>
            <div className="mt-3 flex items-center justify-center gap-3">
              <span className="font-mono text-[22px] tracking-[0.08em]">{formatPairCode(code)}</span>
              <button
                type="button"
                onClick={() => void copyCode()}
                className="cursor-pointer rounded-[3px] border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:border-ink hover:text-ink"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-center gap-3">
              <div className="relative h-[28px] w-[28px]" title="Time left">
                <svg width="28" height="28" viewBox="0 0 28 28" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="14" cy="14" r="11" fill="none" stroke="var(--color-line)" strokeWidth="3" />
                  <circle
                    cx="14"
                    cy="14"
                    r="11"
                    fill="none"
                    stroke={ringColor}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray="69.1"
                    strokeDashoffset={69.1 * (1 - ringFrac)}
                  />
                </svg>
              </div>
              <button
                type="button"
                onClick={() => resetPair()}
                className="cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink"
              >
                Generate new code
              </button>
            </div>
            <div className="mt-2 text-center font-mono text-[10.5px] text-grey-soft">
              This laptop is named{" "}
              <input
                value={laptopName}
                onChange={(e) => setLaptopName(e.target.value.slice(0, 40))}
                aria-label="Laptop name"
                className="w-[130px] rounded-[3px] border border-line-strong bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-ink outline-none"
              />
            </div>
            {(status === "confirming" || status === "connected") && phoneName && (
              <div className="mt-2 text-center font-mono text-[11px] text-accent-deep">
                {status === "connected" ? `Paired with ${phoneName}.` : `Found ${phoneName}…`}
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
