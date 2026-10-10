import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useTheme } from "../hooks/useTheme";
import ThemeToggle from "./ThemeToggle";

export type AuthMode = "signin" | "signup" | "forgot" | "reset";

type Props = {
  initialMode?: AuthMode;
  notice?: string | null;
  /** Called after a password reset so the gate can continue into the app. */
  onResetDone?: () => void;
  /** Compact mobile layout for the phone (/remote) route. */
  compact?: boolean;
};

const COPY: Record<AuthMode, { kicker: string; title: string; body: string }> = {
  signin: { kicker: "Welcome back", title: "Sign in to Rocky.", body: "Your week follows you: the laptop and your phone show the same calendar." },
  signup: { kicker: "New here", title: "Create your account.", body: "One account for this laptop and your phone. Your calendar syncs between them." },
  forgot: { kicker: "Forgot password", title: "Reset your password.", body: "Enter the email you signed up with and we'll send you a link." },
  reset: { kicker: "Almost there", title: "Choose a new password.", body: "Pick something you haven't used elsewhere. At least 8 characters." },
};

function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match.";
  if (m.includes("email not confirmed")) return "Confirm your email first: check your inbox for the link.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with this email already exists. Sign in instead.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many tries. Wait a minute and try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Can't reach the server. Check your connection.";
  if (m.includes("password")) return message;
  return message;
}

const label = "font-mono text-micro tracking-tab uppercase text-grey-mid";
const input = "w-full border-0 border-b border-line-strong bg-transparent py-0 pb-[9px] font-sans text-[17px] text-ink outline-none placeholder:text-grey-ghost";
const primary = "mt-[6px] flex h-12 cursor-pointer items-center justify-center rounded-[3px] bg-ink text-[15px] font-medium text-canvas hover:bg-accent disabled:cursor-default disabled:opacity-50";
const link = "cursor-pointer font-mono text-[10.5px] tracking-tab uppercase text-grey-mid hover:text-ink";

export default function AuthScreen({ initialMode = "signin", notice = null, onResetDone, compact = false }: Props) {
  const { theme, toggle: toggleTheme } = useTheme();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice);

  const go = (next: AuthMode) => { setMode(next); setError(null); setInfo(null); };

  const submit = async () => {
    setError(null);
    setInfo(null);
    const mail = email.trim();
    if (mode !== "reset" && !mail.includes("@")) { setError("Enter a valid email."); return; }
    if ((mode === "signup" || mode === "reset") && password.length < 8) { setError("Use at least 8 characters."); return; }
    if (mode === "signup" && !name.trim()) { setError("Tell us what to call you."); return; }
    if (mode === "signin" && !password) { setError("Enter your password."); return; }
    setBusy(true);
    try {
      const sb = supabase();
      if (mode === "signin") {
        const { error: e } = await sb.auth.signInWithPassword({ email: mail, password });
        if (e) throw e;
      } else if (mode === "signup") {
        const { data, error: e } = await sb.auth.signUp({
          email: mail,
          password,
          options: { data: { display_name: name.trim() }, emailRedirectTo: window.location.origin },
        });
        if (e) throw e;
        try { localStorage.setItem("vc-user-name", name.trim()); } catch {}
        if (!data.session) setInfo("Check your inbox to confirm your email, then sign in.");
      } else if (mode === "forgot") {
        const { error: e } = await sb.auth.resetPasswordForEmail(mail, { redirectTo: window.location.origin });
        if (e) throw e;
        setInfo("If that email has an account, a reset link is on its way.");
      } else {
        const { error: e } = await sb.auth.updateUser({ password });
        if (e) throw e;
        onResetDone?.();
      }
    } catch (e) {
      setError(friendly(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const c = COPY[mode];
  const cta = { signin: "Sign in", signup: "Create account", forgot: "Send reset link", reset: "Save password" }[mode];

  return (
    <div className={`absolute inset-0 z-30 flex flex-col bg-canvas pt-11 pb-10 ${compact ? "px-6" : "px-[60px]"}`}>
      <div className="flex items-center justify-between">
        <div className="font-mono text-[11px] tracking-wordmark uppercase text-ink">Rocky</div>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <form
        className="flex min-h-0 flex-1 items-center"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className={`flex w-full flex-wrap items-center ${compact ? "gap-y-8" : "gap-x-[120px] gap-y-12"}`}>
          <div className="max-w-[440px]">
            <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">{c.kicker}</div>
            <div className={`mt-[22px] font-medium leading-[1.1] tracking-[-0.026em] text-pretty ${compact ? "text-[32px]" : "text-[44px]"}`}>{c.title}</div>
            <div className="mt-6 text-[16px] leading-[1.55] text-ink-muted text-pretty">{c.body}</div>
          </div>

          <div className="flex w-[400px] max-w-full flex-none flex-col gap-6">
            {mode === "signup" && (
              <label className="flex flex-col gap-[9px]">
                <span className={label}>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What should Rocky call you?" autoComplete="name" className={input} />
              </label>
            )}
            {mode !== "reset" && (
              <label className="flex flex-col gap-[9px]">
                <span className={label}>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" autoComplete="email" className={input} />
              </label>
            )}
            {mode !== "forgot" && (
              <label className="flex flex-col gap-[9px]">
                <span className={label}>{mode === "reset" ? "New password" : "Password"}</span>
                <div className="flex items-center gap-3 border-b border-line-strong pb-[9px]">
                  <input
                    type={shown ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "signin" ? "Your password" : "At least 8 characters"}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    className="min-w-0 flex-1 border-0 bg-transparent font-sans text-[17px] text-ink outline-none placeholder:text-grey-ghost"
                  />
                  <button type="button" onClick={() => setShown((v) => !v)} className="flex-none cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink">
                    {shown ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
            )}

            {error && <div role="alert" className="font-mono text-[11px] leading-[1.5] text-red-500">{error}</div>}
            {info && <div role="status" className="font-mono text-[11px] leading-[1.5] text-accent-deep">{info}</div>}

            <button type="submit" disabled={busy} className={primary}>{busy ? "One moment…" : cta}</button>

            {(mode === "signin" || mode === "signup") && (
              <button type="button" disabled className="flex h-12 cursor-not-allowed items-center justify-center gap-3 rounded-[3px] border border-line-strong text-[14px] text-grey-mid">
                Continue with Google <span className="font-mono text-[10px] tracking-tab uppercase">Coming soon</span>
              </button>
            )}

            <div className="flex items-center justify-between">
              {mode === "signin" && (<><button type="button" onClick={() => go("signup")} className={link}>Create an account</button><button type="button" onClick={() => go("forgot")} className={link}>Forgot password?</button></>)}
              {mode === "signup" && <button type="button" onClick={() => go("signin")} className={link}>I already have an account</button>}
              {mode === "forgot" && <button type="button" onClick={() => go("signin")} className={link}>Back to sign in</button>}
            </div>
          </div>
        </div>
      </form>

      <div className="font-mono text-[10.5px] tracking-gap text-grey-soft">Your calendar syncs through your account. Memory, if you turn it on, stays on this laptop.</div>
    </div>
  );
}
