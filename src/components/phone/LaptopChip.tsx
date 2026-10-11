import type { LaptopPresenceState } from "../../lib/devices";

/** "Laptop online" / "Laptop asleep" / "Connecting…" pill (phone headers). */
export default function LaptopChip({ presence }: { presence: LaptopPresenceState }) {
  const chip =
    presence.status === "online"
      ? { dot: "var(--color-accent)", label: "Laptop online" }
      : presence.status === "offline"
        ? { dot: "var(--color-warm)", label: "Laptop asleep" }
        : { dot: "var(--color-grey-faint)", label: "Connecting…" };
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1.5 font-mono text-micro tracking-tab uppercase text-grey"
      title={`${presence.laptopName} · ${chip.label}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: chip.dot }} aria-hidden />
      {chip.label}
    </span>
  );
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Settings"
      className="flex h-11 w-11 flex-none cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-13 text-grey-mid hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      •••
    </button>
  );
}
