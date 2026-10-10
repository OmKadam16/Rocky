import { useEffect, useState } from "react";
import RemotePairFlow from "../components/RemotePairFlow";
import RemoteHome from "../components/RemoteHome";
import { isSupabaseConfigured, supabase, uniqueChannel } from "../lib/supabase";
import { readPhoneDevice } from "../lib/devices";

/**
 * /remote gate (mobile layout, 390px): paired phones get the home screen,
 * everyone else gets the pair flow. Pairing is decided by the phone's
 * `devices` row — never by localStorage — and watched live, so rotating
 * the code on the laptop (which deletes the phone row) kicks the phone
 * straight back to the pair flow. AuthGate guarantees a session before
 * this renders; ?pair= survives sign-in (no navigation happens).
 */
export default function RemotePage() {
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    if (!isSupabaseConfigured) {
      setPaired(false);
      return;
    }
    const check = () =>
      readPhoneDevice()
        .then((row) => alive && setPaired(row != null))
        .catch(() => alive && setPaired(false));
    void check();
    const sb = supabase();
    const channel = sb
      .channel(uniqueChannel("remote-pair-gate"))
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => void check())
      .subscribe();
    return () => {
      alive = false;
      void sb.removeChannel(channel);
    };
  }, []);

  if (!isSupabaseConfigured) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col bg-canvas px-5 pb-10 pt-16 text-ink">
        <div className="font-mono text-[11px] tracking-wordmark uppercase text-ink">Rocky</div>
        <h1 className="mt-6 text-[30px] font-medium leading-[1.1] tracking-[-0.024em]">Phone view needs Supabase.</h1>
        <p className="mt-4 max-w-[340px] text-15 leading-[1.55] text-ink-muted">
          Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then sign in — on this phone and on your laptop.
        </p>
      </div>
    );
  }

  if (paired === null) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col bg-canvas px-5 pb-10 pt-16" aria-label="Loading">
        <div className="font-mono text-[11px] tracking-wordmark uppercase text-grey-mid">Rocky</div>
        <div className="mt-6 font-mono text-label tracking-gap uppercase text-grey-ghost">Loading…</div>
      </div>
    );
  }

  if (paired) {
    return <RemoteHome onUnpaired={() => setPaired(false)} />;
  }
  return <RemotePairFlow onPaired={() => setPaired(true)} />;
}
