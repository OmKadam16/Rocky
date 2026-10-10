type Props = {
  theme: "light" | "dark";
  onToggle: () => void;
  /** pill: icon + Light/Dark label. icon: circular icon-only for tight rails. */
  variant?: "pill" | "icon";
  className?: string;
};

/**
 * The single light/dark toggle used everywhere (sidebar, onboarding,
 * sign-in). One design, two sizes — same border, icon, hover and labels.
 */
export default function ThemeToggle({ theme, onToggle, variant = "pill", className = "" }: Props) {
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        className={`flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-full border border-line-strong text-grey-mid transition-colors hover:border-ink hover:text-ink ${className}`}
      >
        <span className="text-13">{theme === "dark" ? "☀" : "☾"}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className={`flex cursor-pointer items-center gap-2 rounded-full border border-line-strong px-3 py-[7px] font-mono text-micro tracking-tab uppercase text-grey-mid transition-colors hover:border-ink hover:text-ink ${className}`}
    >
      <span className="text-12 leading-none">{theme === "dark" ? "☀" : "☾"}</span>
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
