import { useCallback, useEffect, useState } from "react";
import { db } from "../lib/db";
import { BUILD_PHONE_URL, PHONE_URL_FIELD, cleanPhoneUrl, phoneUrlWarning, resolvePhoneUrl } from "../lib/phoneUrl";

/**
 * Devices → "On your phone, open <URL> and enter this code". The address is
 * the Rocky website (VITE_PUBLIC_URL, or the "Phone site address" saved on
 * the profile); never the desktop app's own app://rocky origin.
 */
export default function PhoneUrlLine() {
  const [setting, setSetting] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void db.profiles
      .get("local")
      .then((p) => alive && setSetting(((p as unknown as Record<string, unknown> | undefined)?.[PHONE_URL_FIELD] as string | undefined) ?? null))
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const { url } = resolvePhoneUrl(BUILD_PHONE_URL, setting);
  const warning = phoneUrlWarning(url);
  const showInput = editing || (loaded && !url);

  const save = useCallback(async () => {
    const raw = draft.trim();
    const clean = raw ? cleanPhoneUrl(raw) : null;
    if (raw && !clean) {
      setError("That isn't a website address. It looks like https://rocky.onrender.com");
      return;
    }
    setError(null);
    try {
      const p = await db.profiles.get("local");
      if (p) await db.profiles.put({ ...p, [PHONE_URL_FIELD]: clean } as typeof p);
      setSetting(clean);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 160) : "Couldn't save.");
    }
  }, [draft]);

  const copy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [url]);

  return (
    <div className="mt-3 rounded-[3px] border border-line bg-panel px-3 py-3 text-center">
      <div className="font-mono text-[10.5px] text-grey-soft">On your phone, open</div>
      {url && !editing && (
        <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2">
          <span className="select-all break-all font-mono text-[17px] text-ink">{url}</span>
          <button
            type="button"
            onClick={() => void copy()}
            className="cursor-pointer rounded-[3px] border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:border-ink hover:text-ink"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {showInput && (
        <div className="mt-1.5 flex flex-col items-center gap-1.5">
          <div className="flex w-full max-w-[420px] items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Phone site address, e.g. https://rocky.onrender.com"
              aria-label="Phone site address"
              className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
            />
            <button
              type="button"
              onClick={() => void save()}
              className="flex-none cursor-pointer rounded-[3px] bg-ink px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] uppercase text-canvas"
            >
              Save
            </button>
          </div>
          {!url && <div className="font-mono text-[10.5px] text-warm">No phone address yet: paste your Rocky website address.</div>}
        </div>
      )}
      <div className="mt-1.5 font-mono text-[10.5px] text-grey-soft">and enter this code (in the Rocky Android app, just enter the code)</div>
      {warning && !editing && <div className="mt-1.5 font-mono text-[10.5px] leading-[1.5] text-warm">{warning}</div>}
      {error && <div className="mt-1.5 font-mono text-[10.5px] text-warm">{error}</div>}
      {url && !editing && (
        <button
          type="button"
          onClick={() => {
            setDraft(setting ?? url);
            setEditing(true);
          }}
          className="mt-1.5 cursor-pointer font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid hover:text-ink"
        >
          Change address
        </button>
      )}
    </div>
  );
}
