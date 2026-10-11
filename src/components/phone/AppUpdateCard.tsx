import { useEffect, useState } from "react";
import { formatSize } from "../../lib/appUpdate";
import { isNativeApp } from "../../lib/native";
import type { NativeUpdateState } from "../../lib/appUpdateNative";

/**
 * Android app only: "Updated to x.y.z" once after a silent web update, and
 * the "Update available" card when a newer APK is out. Installing an APK is
 * never silent: Android asks the user to tap Install.
 */
export default function AppUpdateCard() {
  const [s, setS] = useState<NativeUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [mod, setMod] = useState<typeof import("../../lib/appUpdateNative") | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    let off: (() => void) | null = null;
    void import("../../lib/appUpdateNative").then((m) => {
      setMod(m);
      setS(m.getUpdateState());
      off = m.onUpdateState(setS);
    });
    return () => off?.();
  }, []);

  if (!s || !mod) return null;
  return (
    <>
      {s.notice && (
        <div role="status" className="flex items-center gap-3 rounded-[3px] border border-accent-line bg-accent-bg px-3 py-2">
          <span className="min-w-0 flex-1 text-13 text-accent-deep">{s.notice}</span>
          <button type="button" onClick={mod.dismissNotice} className="h-9 cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink">
            OK
          </button>
        </div>
      )}
      {s.native && (
        <div className="rounded-[3px] border border-line bg-card px-3 py-3">
          <div className="text-14 font-medium text-ink">
            Update available ({s.native.version}, {formatSize(s.native.asset.size)})
          </div>
          <p className="mt-1 text-13 leading-[1.45] text-grey">
            Android will ask you to tap Install, and the first time it may ask you to allow installing apps from Rocky.
          </p>
          {msg && <p className="mt-1 font-mono text-meta leading-[1.5] text-ink-soft">{msg}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg("Downloading…");
              const r = await mod.installApk(s.native!.asset, s.native!.version);
              setMsg(r.message);
              setBusy(false);
            }}
            className="mt-2 h-11 w-full cursor-pointer rounded-[3px] bg-ink text-13 font-medium text-canvas hover:bg-accent disabled:opacity-60"
          >
            {busy ? "Downloading…" : "Update"}
          </button>
        </div>
      )}
    </>
  );
}
