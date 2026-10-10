/** The sidebar's icons are drawn in CSS, exactly as in the exported design. */

type IconProps = { active?: boolean };

export function CalendarIcon({ active }: IconProps) {
  return (
    <div
      className="h-[13px] w-[13px] flex-none rounded-[2px] border border-t-[3px]"
      style={{ borderColor: active ? "var(--color-ink)" : "var(--color-grey-mid)" }}
    />
  );
}

export function FixedIcon({ active }: IconProps) {
  const color = active ? "var(--color-ink)" : "var(--color-grey-mid)";
  return (
    <div className="flex h-[13px] w-[13px] flex-none flex-col items-center justify-end">
      <div
        className="h-[5px] w-[8px] rounded-t-[4px] border border-b-0"
        style={{ borderColor: color }}
      />
      <div className="h-[7px] w-[12px] rounded-[1px]" style={{ background: color }} />
    </div>
  );
}

export function PreferencesIcon() {
  return (
    <div className="flex h-[13px] w-[13px] flex-none flex-col justify-center gap-[3px]">
      <div className="h-px bg-grey-faint" />
      <div className="h-px bg-grey-faint" />
      <div className="h-px bg-grey-faint" />
    </div>
  );
}

export function ProfileIcon({ active }: IconProps) {
  return (
    <div
      className="flex h-[13px] w-[13px] flex-none items-center justify-center rounded-full border text-[7px] font-mono leading-none"
      style={{
        borderColor: active ? "var(--color-ink)" : "var(--color-grey-mid)",
        color: active ? "var(--color-ink)" : "var(--color-grey-mid)",
      }}
    >
      •
    </div>
  );
}

export function DashboardIcon({ active }: IconProps) {
  return (
    <div className="grid h-[13px] w-[13px] grid-cols-2 gap-0.5">
      <div className="rounded-[1px]" style={{ background: active ? "var(--color-ink)" : "var(--color-grey-mid)" }} />
      <div className="rounded-[1px]" style={{ background: active ? "var(--color-ink)" : "var(--color-grey-mid)" }} />
      <div className="rounded-[1px]" style={{ background: "var(--color-grey-faint)" }} />
      <div className="rounded-[1px]" style={{ background: "var(--color-grey-faint)" }} />
    </div>
  );
}

export function MemoryIcon({ active }: IconProps) {
  const color = active ? "var(--color-ink)" : "var(--color-grey-mid)";
  return (
    <div className="flex h-[13px] w-[13px] flex-none items-center justify-center rounded-full border" style={{ borderColor: color }}>
      <div className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
    </div>
  );
}

export function AssignmentsIcon({ active }: IconProps) {
  return (
    <div
      className="h-[13px] w-[13px] flex-none rounded-[2px] border"
      style={{ borderColor: active ? "var(--color-ink)" : "var(--color-grey-mid)" }}
    >
      <div className="mx-[2px] mt-[2px] h-[3px] rounded-[1px]" style={{ background: active ? "var(--color-ink)" : "var(--color-grey-mid)" }} />
      <div className="mx-[2px] mt-[1px] h-px bg-grey-faint" />
      <div className="mx-[2px] mt-[1px] h-px bg-grey-faint" />
    </div>
  );
}
