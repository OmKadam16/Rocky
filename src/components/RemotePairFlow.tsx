import { useCallback, useEffect, useRef, useState } from "react";
import {
  buzz,
  defaultPhoneName,
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

const PAIR_STORE_KEY = "vc-remote-pair";

function loadStoredPair(): string | null {
  try {
    return parsePairParam(`?pair=${localStorage.getItem(PAIR_STORE_KEY) ?? ""}`);
  } catch {
    return null;
  }
}

/**
 * Phone /remote pair flow: enter the laptop's static 8-char code to pair
 * the same account. ?pair=<CODE> links still prefill the boxes; the user
 * still taps once to pair.
 */
export default function RemotePairFlow({ onPaired }: { onPaired: () => void }) {
  const [state, setState] = useState<PhonePairState>("intro");
  const [code, setCode] = useState("");
  const [genericMsg, setGenericMsg] = useState<string | null>(null);
  const [laptopName, setLaptopName] = useState("your laptop");
  const [phoneName] = useState(() => defaultPhoneName());
  const confirmTimer = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const showBack = state !== "intro" && state !== "connected" && state !== "confirming";

  // ?pair=<CODE> deep link (or a kept code): prefill the boxes.
  // The user still taps once to pair.
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

  useEffect(
    () => () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const goPair = useCallback((next: PhonePairState) => {
    setGenericMsg(null);
    setState(next);
  }, []);

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

  const boxes = (() => {
    const n = normalizePairCode(code).padEnd(8, " ").slice(0, 8);
    return [...n].map((ch, i) => ({ ch: ch === " " ? "" : ch, filled: ch !== " ", key: i }));
  })();

  const errMeta: Record<string, { title: string; body: string }> = {
    expired: { title: "That code isn't active", body: "Check the code on the laptop (Profile → Devices) — each account has one code that doesn't change." },
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
              Profile → Devices for your code.
            </p>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => goPair("code")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              Enter code
            </button>
          </div>
        </div>
      )}

      {state === "code" && (
        <div className="flex flex-1 flex-col gap-6 pt-5">
          <div>
            <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">Pairing code</div>
            <h1 className="mt-[22px] text-[34px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty">Enter the code.</h1>
            <p className="mt-6 text-15 leading-[1.55] text-ink-muted text-pretty">Find it on your laptop under Profile → Devices.</p>
          </div>
          <label className="relative grid grid-cols-[repeat(4,1fr)_14px_repeat(4,1fr)] items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(normalizePairCode(e.target.value).slice(0, 8))}
              maxLength={9}
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label="8 character pairing code"
              className="absolute inset-0 opacity-0"
              style={{ fontSize: 16 }}
            />
            {boxes.slice(0, 4).map((b) => (
              <span key={b.key} aria-hidden className="grid h-14 place-items-center rounded-[3px] border font-mono text-[22px] font-medium" style={{ borderColor: b.filled ? "var(--color-accent)" : "var(--color-line-strong)", background: "var(--color-card)" }}>
                {b.ch}
              </span>
            ))}
            <span className="h-0.5 rounded bg-grey-faint" aria-hidden />
            {boxes.slice(4).map((b) => (
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
          <p className="text-center font-mono text-[10.5px] tracking-tab uppercase text-grey-faint">Pairing as {phoneName} · one code per account</p>
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
            <button type="button" onClick={() => goPair("code")} className="flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent">
              Try again
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
