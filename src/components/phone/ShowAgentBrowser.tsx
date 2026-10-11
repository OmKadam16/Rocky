import { isNativeApp } from "../../lib/native";

/** Android app: bring the on-phone agent browser back on screen. */
export default function ShowAgentBrowser({ phase }: { phase: string }) {
  if (!isNativeApp() || phase === "idle") return null;
  return (
    <button
      type="button"
      onClick={() => void import("../../lib/agentAndroidInstall").then((m) => m.androidAgent()?.showBrowser()).catch(() => {})}
      className="mt-2 h-11 w-full cursor-pointer rounded-[3px] border border-line-strong font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink"
    >
      Show the booking page
    </button>
  );
}
