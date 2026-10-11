import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import AuthScreen from "./AuthScreen";
import { SessionContext } from "../hooks/useAuth";
import { usingCloud } from "../lib/db";
import { SUPABASE_CONFIG_PROBLEM, supabase } from "../lib/supabase";
import { startRealtime, stopRealtime } from "../lib/supaDb";
import { shouldShowMobileUi } from "../lib/isMobile";
import { bootError, bootReady, bootStep } from "../lib/boot";

type State =
  | { kind: "checking" }
  | { kind: "signedOut"; notice: string | null }
  | { kind: "recovery" }
  | { kind: "signedIn"; session: Session };

/**
 * Accounts gate. A saved session is not trusted on its own: it is checked with the server
 * (auth.getUser) at startup and whenever the window regains focus, so a deleted or revoked
 * account is signed out instead of reaching the app as a ghost user.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  if (SUPABASE_CONFIG_PROBLEM) return <Misconfigured name={SUPABASE_CONFIG_PROBLEM.name} problem={SUPABASE_CONFIG_PROBLEM.problem} />;
  if (!usingCloud) return <LocalGate>{children}</LocalGate>;
  return <CloudGate>{children}</CloudGate>;
}

/** A broken build-time value: say which one, instead of a raw fetch error at sign-in. */
export function Misconfigured({ name, problem }: { name: string; problem: string }) {
  useEffect(() => {
    bootStep(`misconfigured: ${name} ${problem}`);
    bootReady();
  }, [name, problem]);
  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink sm:p-10">
      <div className="w-full max-w-[560px]">
        <h1 className="text-[26px] font-medium tracking-[-0.02em]">Rocky is misconfigured: {name} has invalid characters. Rebuild the app.</h1>
        <p className="mt-4 font-mono text-[12px] leading-[1.6] text-grey">{name} {problem}.</p>
        <p className="mt-3 font-mono text-[11px] text-grey-soft">Rocky {__APP_VERSION__}</p>
      </div>
    </div>
  );
}

function LocalGate({ children }: { children: ReactNode }) {
  useEffect(() => {
    bootStep("no cloud account (local data)");
    bootReady();
  }, []);
  return <>{children}</>;
}

function CloudGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    const sb = supabase();
    let alive = true;

    const validate = async (reason: "startup" | "focus") => {
      if (reason === "startup") bootStep("auth: reading the saved session");
      const { data } = await sb.auth.getSession();
      if (reason === "startup") bootStep(data.session ? "auth: checking the session with the server" : "auth: signed out");
      const session = data.session;
      if (!session) {
        if (alive && reason === "startup") setState({ kind: "signedOut", notice: null });
        return;
      }
      const { data: u, error } = await sb.auth.getUser();
      if (!alive) return;
      if (error || !u.user) {
        // Network trouble on focus should not sign anyone out; only a definite rejection does.
        const status = (error as { status?: number } | null)?.status;
        const definite = !error || status === 401 || status === 403 || status === 404 || /not.*found|invalid|expired|missing/i.test(error.message);
        if (definite) {
          await sb.auth.signOut({ scope: "local" });
          if (alive) setState({ kind: "signedOut", notice: "Your session ended. Please sign in again." });
          return;
        }
        if (reason === "startup") setState({ kind: "signedIn", session });
        return;
      }
      setState((s) => (s.kind === "signedIn" && s.session.user.id === session.user.id ? s : { kind: "signedIn", session }));
    };

    // A failure reading the saved session must not leave the loading screen up:
    // show sign-in with the reason (and log it for the boot screen).
    validate("startup").catch((e: unknown) => {
      bootError(e);
      if (alive) setState({ kind: "signedOut", notice: `Couldn't read your saved sign-in (${e instanceof Error ? e.message : String(e)}). Please sign in.` });
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === "PASSWORD_RECOVERY") { setState({ kind: "recovery" }); return; }
      if (event === "SIGNED_OUT" || !session) {
        setState((s) => (s.kind === "signedOut" ? s : { kind: "signedOut", notice: null }));
        return;
      }
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        setState((s) => (s.kind === "recovery" ? s : { kind: "signedIn", session }));
      }
    });
    const onFocus = () => { void validate("focus"); };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // The boot is done once we know who (if anyone) is signed in.
  useEffect(() => {
    if (state.kind !== "checking") bootReady();
  }, [state.kind]);

  const userId = state.kind === "signedIn" ? state.session.user.id : null;
  useEffect(() => {
    if (!userId) return;
    startRealtime();
    window.dispatchEvent(new CustomEvent("vc-data-change", { detail: { table: "*" } }));
    return () => stopRealtime();
  }, [userId]);

  if (state.kind === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas" role="status" aria-label="Loading">
        <div className="font-mono text-[11px] tracking-wordmark uppercase text-grey-mid">Rocky</div>
      </div>
    );
  }
  if (state.kind === "recovery") {
    return (
      <div className="relative h-screen bg-canvas text-ink">
        <AuthScreen
          initialMode="reset"
          onResetDone={async () => {
            const { data } = await supabase().auth.getSession();
            setState(data.session ? { kind: "signedIn", session: data.session } : { kind: "signedOut", notice: "Password saved. Sign in with it." });
          }}
        />
      </div>
    );
  }
  if (state.kind === "signedOut") {
    const compact =
      typeof window !== "undefined" && shouldShowMobileUi(window.location.pathname);
    return (
      <div className="relative h-screen bg-canvas text-ink">
        <AuthScreen notice={state.notice} compact={compact} />
      </div>
    );
  }
  // key = user id: switching accounts remounts the app so no state leaks between people.
  return (
    <SessionContext.Provider value={state.session}>
      <div key={state.session.user.id} className="contents">{children}</div>
    </SessionContext.Provider>
  );
}
