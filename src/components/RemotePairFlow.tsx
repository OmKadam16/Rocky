import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import {
  buzz,
  defaultPhoneName,
  extractPairFromQrText,
  isValidPairCode,
  LAPTOP_OFFLINE_AFTER_SEC,
  normalizePairCode,
  parsePairParam,
  type PhonePairState,
} from "../lib/pairing";
import {
  claimPair,
  PairError,
  readLaptopLastSeen,
} from "../lib/devices";
import { currentUserId } from "../lib/supabase";

type BarcodeDetectorLike = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> };
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

const PAIR_STORE_KEY = "vc-remote-pair";

function loadStoredPair(): string | null {
  try {
    return parsePairParam(`?pair=${localStorage.getItem(PAIR_STORE_KEY) ?? ""}`);
  } catch {
    return null;
  }
}

/**
 * Phone /remote pair flow. Logic ported from Rocky-Planner, restyled in v1.
 * intro → scanner/code → confirming → connected, with expired/wrong/offline
 * error states. ?pair=CODE from the laptop QR prefills the code boxes and
 * survives sign-in (no navigation happens during AuthGate swaps).
 */
export default function RemotePairFlow({ onPaired }: { onPaired: () => void }) {
  const [state, setState] = useState<PhonePairState>("intro");
  const [code, setCode] = useState("");
  const [genericMsg, setGenericMsg] = useState<string | null>(null);
  const [laptopName, setLaptopName] = useState("your laptop");
  const [phoneName] = useState(() => defaultPhoneName());
  const [torch, setTorch] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [scanHint, setScanHint] = useState(false);
  const insecureContext = typeof window !== "undefined" && window.isSecureContext === false;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimer = useRef<number | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const showBack = state !== "intro" && state !== "connected" && state !== "confirming";
  const denied = state === "camDenied";
  const primer = state === "camPrimer" || denied;

  // ?pair=<CODE> deep link from the laptop QR. Prefill; the user still taps once to pair.
  useEffect(() => {
    const fromUrl = parsePairParam(window.location.search) ?? loadStoredPair();
    if (fromUrl) {
      setCode(fromUrl);
      try {
        localStorage.setItem(PAIR_STORE_KEY, fromUrl);
      } catch {}
      setState((s) => (s === "intro" ? "code" : s));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCamera = useCallback(() => {
    if (scanTimer.current) {
      window.clearInterval(scanTimer.current);
      scanTimer.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setTorch(false);
  }, []);

  useEffect(
    () => () => {
      stopCamera();
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    },
    [stopCamera],
  );

  const goPair = useCallback(
    (next: PhonePairState) => {
      if (next !== "scanner") stopCamera();
      setCamError(null);
      setGenericMsg(null);
      setScanHint(false);
      setState(next);
    },
    [stopCamera],
  );

  const submitCode = useCallback(
    async (raw: string) => {
      const normalized = normalizePairCode(raw);
      if (!isValidPairCode(normalized)) return;
      setCode(normalized);
      try {
        localStorage.setItem(PAIR_STORE_KEY, normalized);
      } catch {}
      setGenericMsg(null);
      setState("confirming");
      buzz(15);
      const fail = (kind: PhonePairState) => setState(kind);
      const failGeneric = (message: string) => {
        setGenericMsg(message);
        setState("generic");
      };
      const done = (name: string) => {
        setLaptopName(name);
        setState("connected");
        buzz([20, 60, 20]);
        try {
          localStorage.removeItem(PAIR_STORE_KEY);
        } catch {}
      };
      const clearTimer = () => {
        if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      };
      // 12 s with no answer: re-check presence instead of assuming offline.
      clearTimer();
      confirmTimer.current = window.setTimeout(() => {
        if (stateRef.current !== "confirming") return;
        void (async () => {
          const presence = await readLaptopLastSeen().catch(() => null);
          if (!presence || Date.now() - presence.lastSeenMs > LAPTOP_OFFLINE_AFTER_SEC * 1000) {
            setState("offline");
          } else {
            failGeneric("The laptop didn’t answer in time. Keep Rocky open on the laptop and try again.");
          }
        })();
      }, 12_000);

      try {
        // No session => auth.uid() is null inside claim_pair and every
        // code looks dead. AuthGate normally guarantees a session here;
        // a mid-flow expiry lands on the sign-in-again card instead.
        const uid = await currentUserId();
        if (!uid) {
          clearTimer();
          failGeneric("Your sign-in expired. Sign in again — the code is kept.");
          return;
        }
        // "Laptop offline" is decided ONLY from devices.last_seen.
        const presence = await readLaptopLastSeen();
        if (presence && Date.now() - presence.lastSeenMs > LAPTOP_OFFLINE_AFTER_SEC * 1000) {
          clearTimer();
          fail("offline");
          return;
        }
        const r = await claimPair(normalized, phoneName);
        clearTimer();
        done(r.laptopName);
      } catch (e) {
        clearTimer();
        // Mapped by Postgres errcode — never string-sniffed, and an
        // unrecognized error is NEVER shown as "laptop offline".
        if (e instanceof PairError) {
          if (e.kind === "expired") fail("expired");
          else if (e.kind === "wrong") fail("wrong");
          else if (e.kind === "not-signed-in") failGeneric("Your sign-in expired. Sign in again — the code is kept.");
          else failGeneric(e.message);
        } else {
          failGeneric(e instanceof Error ? e.message : "Something went wrong claiming the code.");
        }
      }
    },
    [phoneName],
  );

  const handleDetectedText = useCallback(
    (text: string) => {
      const found = extractPairFromQrText(text);
      if (found && stateRef.current === "scanner") {
        stopCamera();
        void submitCode(found);
      }
    },
    [stopCamera, submitCode],
  );

  const startJsQrLoop = useCallback(
    (video: HTMLVideoElement) => {
      if (scanTimer.current) return;
      // Fallback: small JS QR decoder (jsQR) over video frames.
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      let last = 0;
      scanTimer.current = window.setInterval(() => {
        const now = Date.now();
        if (now - last < 400) return;
        last = now;
        try {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) return;
          const scale = Math.min(1, 480 / Math.max(w, h));
          canvas.width = Math.floor(w * scale);
          canvas.height = Math.floor(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const out = jsQR(img.data, img.width, img.height);
          if (out?.data) handleDetectedText(out.data);
        } catch {
          /* keep scanning */
        }
      }, 120);
    },
    [handleDetectedText],
  );

  const startScanLoop = useCallback(
    (video: HTMLVideoElement) => {
      if (scanTimer.current) return;
      const Native = window.BarcodeDetector;
      if (Native) {
        try {
          const det = new Native({ formats: ["qr_code"] });
          let failures = 0;
          scanTimer.current = window.setInterval(async () => {
            try {
              const found = await det.detect(video);
              failures = 0;
              const raw = found?.[0]?.rawValue;
              if (raw) handleDetectedText(raw);
            } catch {
              // A detector that always throws is worse than none:
              // fall back to jsQR instead of scanning blind forever.
              failures += 1;
              if (failures >= 8) {
                if (scanTimer.current) window.clearInterval(scanTimer.current);
                scanTimer.current = null;
                startJsQrLoop(video);
              }
            }
          }, 350);
          return;
        } catch {
          /* fall through to jsQR */
        }
      }
      startJsQrLoop(video);
    },
    [handleDetectedText, startJsQrLoop],
  );

  const openScanner = useCallback(async () => {
    setCamError(null);
    setScanHint(false);
    // Phone cameras need a secure context. LAN http:// addresses are not
    // secure, so getUserMedia is missing there — say so plainly instead of
    // failing into a generic error.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setCamError("This page isn't on HTTPS, so the camera is blocked. Open the Render link on this phone instead — or type the code, which pairs the same account.");
      setState("camPrimer");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("This browser can't open the camera here. Type the code instead — it pairs the same account.");
      setState("camPrimer");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      streamRef.current = stream;
      setState("scanner");
      // If nothing decodes for a while, say so — a silent viewfinder teaches nothing.
      window.setTimeout(() => {
        if (stateRef.current === "scanner") setScanHint(true);
      }, 12000);
      // Attach once the video element is actually mounted and playing; a
      // single rAF can fire before mount and leave the camera running blind.
      let tries = 0;
      const attach = () => {
        const v = videoRef.current;
        if (!v) {
          if (tries++ < 20) requestAnimationFrame(attach);
          return;
        }
        if (v.srcObject !== stream) v.srcObject = stream;
        v.onplaying = () => startScanLoop(v);
        void v.play().catch(() => {});
        const track = stream.getVideoTracks()[0];
        try {
          const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
          setTorchSupported(Boolean(caps?.torch));
        } catch {
          setTorchSupported(false);
        }
        // Belt and braces: if playing never fires, still start the loop.
        window.setTimeout(() => {
          if (videoRef.current === v && !scanTimer.current) startScanLoop(v);
        }, 2500);
      };
      requestAnimationFrame(attach);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState("camDenied");
      } else {
        setCamError("Could not open the camera. Check the browser permission, or type the code instead.");
        setState("camPrimer");
      }
    }
  }, [startScanLoop]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as unknown as MediaTrackConstraintSet] } as MediaTrackConstraints);
      setTorch(!torch);
    } catch {
      /* unsupported */
    }
  }, [torch]);

  const boxes = (() => {
    const n = normalizePairCode(code).padEnd(6, " ").slice(0, 6);
    return [...n].map((ch, i) => ({ ch: ch === " " ? "" : ch, filled: ch !== " ", key: i }));
  })();

  const errMeta: Record<string, { title: string; body: string }> = {
    expired: { title: "That code isn't active", body: "Check the code on the laptop (Profile → Devices) and try again — each account has one code that doesn't change." },
    wrong: { title: "Different account", body: "This phone must be signed in with the same account as your laptop." },
    offline: { title: "Can't reach your laptop", body: "Your laptop is offline or Rocky isn’t running. Open it, start Rocky, and try again." },
  };
  const err = state === "expired" || state === "wrong" || state === "offline" ? errMeta[state] : null;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col bg-canvas px-5 pb-10 text-ink">
      <div className="flex h-14 items-center">
        {showBack ? (
          <button type="button" onClick={() => goPair("intro")} aria-label="Back" className="font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink">
            ← Back
          </button>
        ) : (
          <div className="font-mono text-[11px] tracking-wordmark uppercase text-ink">Rocky</div>
        )}
      </div>

      {state === "intro" && (
        <div className="flex flex-1 flex-col gap-5 pt-10">
          <div>
            <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Remote</div>
            <h1 className="mt-[22px] text-[34px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Pair with your laptop.</h1>
            <p className="mt-6 max-w-[340px] text-15 leading-[1.55] text-ink-muted text-pretty">
              Your phone becomes a mic and a live window into the calendar on your laptop. Open Rocky on your laptop and go to
              Profile → Devices.
            </p>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => goPair("camPrimer")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              Scan QR code
            </button>
            <button type="button" onClick={() => goPair("code")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] border border-line-strong text-[15px] font-medium text-ink hover:border-ink">
              Enter code instead
            </button>
          </div>
        </div>
      )}

      {primer && (
        <div className="flex flex-1 flex-col gap-5 pt-10">
          <div>
            <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Camera</div>
            <h1 className="mt-[22px] text-[34px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">
              {denied ? "Camera is blocked." : "Allow the camera."}
            </h1>
            <p className="mt-6 max-w-[340px] text-15 leading-[1.55] text-ink-muted text-pretty">
              {denied
                ? "To scan the code, allow camera access for this site. Or type the 6-character code instead."
                : "Only to scan the pairing code on your laptop. Rocky doesn't take photos or keep video."}
            </p>
            {insecureContext && !denied && (
              <p className="mt-2 max-w-[340px] font-mono text-[11px] leading-[1.5] text-warm">
                You're on http, so the camera will stay blocked. Open the Render (https) link on this phone — or just type the code.
              </p>
            )}
            {camError && <p className="mt-2 font-mono text-[11px] text-warm">{camError}</p>}
          </div>
          <div className="flex-1" />
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => void openScanner()} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              {denied ? "I've allowed it" : "Continue"}
            </button>
            <button type="button" onClick={() => goPair("code")} className="cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink">
              Enter code instead
            </button>
          </div>
        </div>
      )}

      {state === "scanner" && (
        <div className="relative -mx-5 flex flex-1 flex-col overflow-hidden bg-ink">
          <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" aria-label="Camera viewfinder" />
          <div className="relative flex flex-1 flex-col items-center px-5 pb-6 pt-8">
            <p className="font-mono text-[11px] tracking-tab uppercase text-canvas">Point at the QR on your laptop</p>
            {scanHint && (
              <p className="mt-2 max-w-[280px] text-center font-mono text-[11px] leading-[1.5] text-canvas">
                Still nothing? Hold steady in good light — or type the code instead, it pairs the same account.
              </p>
            )}
            <div className="relative mt-6 h-[270px] w-[270px]">
              <span className="absolute left-0 top-0 h-12 w-12 rounded-tl-[16px] border-l-4 border-t-4 border-canvas" />
              <span className="absolute right-0 top-0 h-12 w-12 rounded-tr-[16px] border-r-4 border-t-4 border-canvas" />
              <span className="absolute bottom-0 left-0 h-12 w-12 rounded-bl-[16px] border-b-4 border-l-4 border-canvas" />
              <span className="absolute bottom-0 right-0 h-12 w-12 rounded-br-[16px] border-b-4 border-r-4 border-canvas" />
            </div>
            <div className="flex-1" />
            <div className="flex w-full flex-col gap-3">
              {torchSupported && (
                <button type="button" onClick={() => void toggleTorch()} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-canvas text-[15px] font-medium text-ink">
                  {torch ? "Turn torch off" : "Turn torch on"}
                </button>
              )}
              <button type="button" onClick={() => goPair("code")} className="cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-canvas">
                Enter code instead
              </button>
              <button type="button" onClick={() => goPair("intro")} className="cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-canvas">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {state === "code" && (
        <div className="flex flex-1 flex-col gap-6 pt-5">
          <div>
            <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Pairing code</div>
            <h1 className="mt-[22px] text-[34px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Enter the code.</h1>
            <p className="mt-6 text-15 leading-[1.55] text-ink-muted text-pretty">It’s under the QR code on your laptop.</p>
          </div>
          <label className="relative grid grid-cols-[repeat(3,1fr)_14px_repeat(3,1fr)] items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(normalizePairCode(e.target.value).slice(0, 6))}
              maxLength={7}
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label="6 character pairing code"
              className="absolute inset-0 opacity-0"
              style={{ fontSize: 16 }}
            />
            {boxes.slice(0, 3).map((b) => (
              <span key={b.key} aria-hidden className="grid h-14 place-items-center rounded-[3px] border font-mono text-[22px] font-medium" style={{ borderColor: b.filled ? "var(--color-accent)" : "var(--color-line-strong)", background: "var(--color-card)" }}>
                {b.ch}
              </span>
            ))}
            <span className="h-0.5 rounded bg-grey-faint" aria-hidden />
            {boxes.slice(3).map((b) => (
              <span key={b.key} aria-hidden className="grid h-14 place-items-center rounded-[3px] border font-mono text-[22px] font-medium" style={{ borderColor: b.filled ? "var(--color-accent)" : "var(--color-line-strong)", background: "var(--color-card)" }}>
                {b.ch}
              </span>
            ))}
          </label>
          <button
            type="button"
            disabled={!isValidPairCode(code)}
            onClick={() => void submitCode(code)}
            className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Pair this phone
          </button>
          <p className="text-center font-mono text-[10.5px] tracking-tab uppercase text-grey-faint">Pairing as {phoneName} · codes last 5 minutes</p>
        </div>
      )}

      {state === "confirming" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
          <div className="font-mono text-micro tracking-tab uppercase text-accent">Connecting…</div>
          <h1 className="text-[24px] font-medium tracking-[-0.02em]">Connecting to your laptop…</h1>
          <p className="max-w-[300px] text-15 leading-[1.55] text-ink-muted">Keep Rocky open on your laptop for a moment.</p>
          <button type="button" onClick={() => goPair("code")} className="mt-2 cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink">
            Cancel
          </button>
        </div>
      )}

      {state === "connected" && (
        <div className="flex flex-1 flex-col items-center gap-4 py-14 text-center">
          <div className="font-mono text-micro tracking-tab uppercase text-accent">Connected</div>
          <h1 className="text-[24px] font-medium tracking-[-0.02em]">You’re connected.</h1>
          <p className="max-w-[320px] text-15 leading-[1.55] text-ink-muted">Paired with {laptopName}. Your phone now mirrors the calendar and works as a mic.</p>
          <button type="button" onClick={onPaired} className="flex h-12 w-full cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
            Open calendar
          </button>
        </div>
      )}

      {state === "generic" && (
        <div className="flex flex-1 flex-col items-center gap-4 py-14 text-center">
          <div className="font-mono text-micro tracking-tab uppercase text-warm">Something went wrong</div>
          <h1 className="text-[24px] font-medium tracking-[-0.02em]">Something went wrong.</h1>
          <p className="max-w-[320px] text-15 leading-[1.55] text-ink-muted">The relay answered with an error. Your laptop is not necessarily offline.</p>
          {genericMsg && <p className="max-w-[320px] break-words rounded-[3px] border border-line bg-card p-3 font-mono text-[11px] leading-relaxed text-grey">{genericMsg}</p>}
          <div className="mt-2 flex w-full flex-col gap-3">
            <button type="button" onClick={() => goPair("code")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              Try again
            </button>
            <button type="button" onClick={() => goPair("intro")} className="cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink">
              Back
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="flex flex-1 flex-col items-center gap-4 py-14 text-center">
          <div className="font-mono text-micro tracking-tab uppercase text-warm">{err.title}</div>
          <h1 className="text-[24px] font-medium tracking-[-0.02em]">{err.title}.</h1>
          <p className="max-w-[320px] text-15 leading-[1.55] text-ink-muted">{err.body}</p>
          <div className="mt-2 flex w-full flex-col gap-3">
            <button type="button" onClick={() => goPair(state === "expired" ? "code" : "intro")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              {state === "expired" ? "Enter the new code" : "Try again"}
            </button>
            <button type="button" onClick={() => goPair("intro")} className="cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink">
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
