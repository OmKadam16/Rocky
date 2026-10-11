import { useCallback, useEffect, useRef, useState } from "react";
import { runConnectionCheck, type CheckProbes, type CheckStep } from "../lib/connectionCheck";

const DOT: Record<CheckStep["state"], string> = {
  ok: "var(--color-accent)",
  fail: "var(--color-warm)",
  warn: "var(--color-grey-faint)",
  skip: "var(--color-grey-faint)",
};

/**
 * Phone "Connection check": collapsed, runs on demand (and whenever
 * `runKey` changes), opens by itself when any step fails.
 */
export default function ConnectionCheck({ probes, runKey }: { probes: CheckProbes; runKey?: string | number | null }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<CheckStep[]>([]);
  const [running, setRunning] = useState(false);
  const probesRef = useRef(probes);
  probesRef.current = probes;

  const run = useCallback(async () => {
    setRunning(true);
    setSteps([]);
    try {
      const out = await runConnectionCheck(probesRef.current, setSteps);
      if (out.some((s) => s.state === "fail")) setOpen(true);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (runKey == null) return;
    void run();
  }, [runKey, run]);

  const failed = steps.some((s) => s.state === "fail");

  return (
    <div className="w-full rounded-[3px] border border-line bg-card px-3 py-2.5 text-left">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2">
        <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Connection check</span>
        <span className="flex-1" />
        <span className={`font-mono text-micro tracking-tab uppercase ${failed ? "text-warm" : "text-grey-faint"}`}>
          {running ? "Checking…" : steps.length ? (failed ? "Problem found" : "All good") : open ? "Hide" : "Open"}
        </span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {steps.map((s) => (
            <div key={s.id} className="flex gap-2">
              <span className="mt-[6px] h-2 w-2 flex-none rounded-full" style={{ background: DOT[s.state] }} aria-label={s.state} />
              <div className="min-w-0 flex-1">
                <div className="text-13 text-ink-soft">
                  <span className="font-medium">{s.label}:</span> {s.line}
                </div>
                {s.fix && s.state !== "ok" && <div className="font-mono text-meta leading-[1.5] text-grey">{s.fix}</div>}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="mt-1 h-9 cursor-pointer rounded-[3px] border border-line-strong font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink disabled:opacity-60"
          >
            {running ? "Checking…" : steps.length ? "Run again" : "Run check"}
          </button>
        </div>
      )}
    </div>
  );
}
