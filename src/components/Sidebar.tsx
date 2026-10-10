import { ASSIGNMENTS_ENABLED } from "../lib/features";
import type { PageName } from "../types";
import { AssignmentsIcon, CalendarIcon, DashboardIcon, MemoryIcon, FixedIcon, ProfileIcon } from "./NavIcons";
import ThemeToggle from "./ThemeToggle";

type Props = {
  page: PageName;
  onNavigate: (page: PageName) => void;
  open: boolean;
  onToggle: () => void;
  /** Shown in the footer when expanded. */
  fixedCount: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  displayName?: string;
};

/** Shared left rail. Wraps the app; never owns what's inside it. */
export default function Sidebar({ page, onNavigate, open, onToggle, fixedCount, theme, onToggleTheme, displayName }: Props) {
  const items = [
    { id: "dashboard" as const, label: "Dashboard", icon: DashboardIcon, soon: false },
    { id: "calendar" as const, label: "Calendar", icon: CalendarIcon, soon: false },
    { id: "fixed" as const, label: "Fixed", icon: FixedIcon, soon: false },
    { id: "memory" as const, label: "Memory", icon: MemoryIcon, soon: false },
    { id: "tasks" as const, label: "Tasks", icon: AssignmentsIcon, soon: false },
    { id: "assignments" as const, label: "Assignments", icon: AssignmentsIcon, soon: !ASSIGNMENTS_ENABLED },
    { id: "profile" as const, label: "Profile", icon: ProfileIcon, soon: false },
  ];

  const fallback = (() => {
    try { return localStorage.getItem("vc-user-name") || ""; } catch { return ""; }
  })();
  const userName = (displayName && displayName.trim()) || fallback || "Kai Mercer";
  const initials = userName.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "—";

  if (!open) {
    return (
      <div className="flex w-[62px] flex-none flex-col items-center border-r border-line bg-sidebar pb-[26px] pt-[30px]">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="mb-[22px] flex h-[30px] w-[30px] cursor-pointer items-center justify-center font-mono text-13 text-grey-mid transition-colors hover:text-ink"
        >
          ›
        </button>
        <div className="flex w-full flex-col items-center gap-1">
          {items.map(({ id, label, icon: Icon, soon }) => {
            const active = !soon && page === id;
            return (
              <button
                key={id}
                type="button"
                onClick={soon ? undefined : () => onNavigate(id)}
                disabled={soon}
                aria-label={soon ? `${label} — coming soon` : label}
                title={soon ? `${label} — coming soon` : undefined}
                aria-current={active ? "page" : undefined}
                className={`box-border flex w-full justify-center border-l-2 py-[11px] transition-colors duration-150 ${
                  soon ? "cursor-default opacity-40" : "cursor-pointer"
                } ${active ? "border-accent bg-panel" : "border-transparent"}`}
              >
                <span className="relative">
                  <Icon active={active} />
                  {soon && <span className="absolute -right-[3px] -top-[2px] h-[3px] w-[3px] rounded-full bg-grey-faint" />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} variant="icon" />
      </div>
    );
  }

  return (
    <div className="flex w-[208px] flex-none flex-col border-r border-line bg-sidebar pb-[26px] pt-[30px]">
      <div className="flex items-center justify-between px-[22px] pb-[26px]">
        <div className="font-mono text-13 tracking-wordmark uppercase text-ink">Rocky</div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center font-mono text-13 text-grey-mid transition-colors hover:text-ink"
        >
          ‹
        </button>
      </div>

      <div className="flex flex-col">
        {items.map(({ id, label, icon: Icon, soon }) => {
          const active = !soon && page === id;
          return (
            <button
              key={id}
              type="button"
              onClick={soon ? undefined : () => onNavigate(id)}
              disabled={soon}
              title={soon ? `${label} — coming soon` : undefined}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 border-l-2 px-[22px] py-[11px] text-left transition-colors duration-150 ${
                soon
                  ? "cursor-default border-transparent text-ink-muted opacity-60"
                  : active
                    ? "cursor-pointer border-accent bg-panel text-ink"
                    : "cursor-pointer border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              <Icon active={active} />
              <div className={`flex-1 text-14 ${active ? "font-medium" : ""}`}>{label}</div>
              {soon && <div className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-grey-faint">Soon</div>}
            </button>
          );
        })}
      </div>

      <div className="flex-1" />
      <button
        type="button"
        onClick={() => onNavigate("profile")}
        className="mx-[22px] mb-[18px] flex cursor-pointer items-center gap-[11px] border-t border-line pt-[18px] text-left"
      >
        <div className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full border border-line bg-done font-mono text-[9px] text-grey">
          {initials}
        </div>
        <div className="min-w-0 flex-1 truncate text-13">{userName}</div>
      </button>
      <ThemeToggle theme={theme} onToggle={onToggleTheme} className="mx-[22px]" />
      <div className="mt-3 px-[22px] font-mono text-micro tracking-tab uppercase text-grey-faint">
        {fixedCount} fixed
      </div>
    </div>
  );
}
