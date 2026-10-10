import { useEffect, useRef, useState } from "react";
import { UPDATES_ENABLED } from "../lib/features";

/**
 * "Check for updates" for the desktop build.
 *
 * Nothing downloads on its own: checking, downloading and installing are three
 * separate presses. The main process drives electron-updater and pushes state
 * here; this component only renders it.
 *
 * On the web build there is no bridge, so the card renders nothing at all.
 */

type State =
  | { state: "idle" }
  | { state: "dev" }
  | { state: "checking" }
  | { state: "current" }
  | { state: "available"; version?: string }
  | { state: "downloading"; percent?: number }
  | { state: "ready"; version?: string }
  | { state: "installing" }
  | { state: "error"; message?: string };

type Bridge = {
  isDesktop: boolean;
  updates?: {
    current: () => Promise<string>;
    check: () => Promise<State>;
    download: () => Promise<State>;
    install: () => Promise<State>;
    onState: (handler: (payload: State) => void) => () => void;
  };
};

const bridge = (): Bridge | null => {
  const w = window as unknown as { rocky?: Bridge };
  return w.rocky?.isDesktop ? w.rocky : null;
};

const LABEL = "font-mono text-[10px] tracking-[0.14em] uppercase";

export default function UpdateCard() {
  const api = bridge()?.updates;
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<State>({ state: "idle" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    void api.current().then((v) => mounted.current && setVersion(v));
    // The main process owns the real state; late events must still land.
    return api.onState((payload) => mounted.current && setStatus(payload));
  }, [api]);

  if (!api) return null;

  const press = async (fn: () => Promise<State>) => {
    const result = await fn();
    // check/download resolve immediately and events carry the rest; only a
    // terminal answer ("dev", an error) is worth writing straight to state.
    if (result && (result.state === "dev" || result.state === "error")) setStatus(result);
  };

  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";

  let line = "Rocky is up to date";
  let tone = "text-grey-soft";
  if (status.state === "checking") line = "Checking…";
  else if (status.state === "available") line = `Version ${status.version ?? ""} is available`;
  else if (status.state === "downloading") line = `Downloading… ${status.percent ?? 0}%`;
  else if (status.state === "ready") line = `Version ${status.version ?? ""} is ready to install`;
  else if (status.state === "installing") line = "Restarting…";
  else if (status.state === "dev") {
    line = "Updates only work in the packaged app";
    tone = "text-grey-faint";
  } else if (status.state === "error") {
    // Belt and braces: main sanitises these, but never let one blow out the card.
    const msg = status.message || "Couldn't check for updates";
    line = msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
    tone = "text-warm";
  } else if (status.state === "idle") {
    line = UPDATES_ENABLED
      ? "Check whether a newer version is out"
      : "Installed locally — rebuild with npm run install:app";
  }

  let action: { text: string; run: () => void } | null = UPDATES_ENABLED
    ? { text: "Check", run: () => void press(api.check) }
    : null;
  if (status.state === "available") action = { text: "Download", run: () => void press(api.download) };
  else if (status.state === "ready") action = { text: "Restart", run: () => void press(api.install) };
  else if (busy) action = null;

  return (
    <div className="rounded-[3px] border border-line px-[18px] py-[15px]">
      <div className="flex items-baseline gap-[14px]">
        <div className="min-w-0 flex-1 text-[15px] text-ink">Rocky</div>
        {version && <div className={`flex-none ${LABEL} text-grey-faint`}>v{version}</div>}
      </div>

      <div className={`mt-[6px] font-mono text-[10.5px] leading-[1.5] ${tone} text-pretty`}>{line}</div>

      {status.state === "downloading" && (
        <div className="mt-[10px] h-[2px] w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${status.percent ?? 0}%` }}
          />
        </div>
      )}

      {action && (
        <button
          type="button"
          onClick={action.run}
          className={`mt-3 cursor-pointer ${LABEL} text-grey-mid hover:text-ink`}
        >
          {action.text}
        </button>
      )}
    </div>
  );
}
