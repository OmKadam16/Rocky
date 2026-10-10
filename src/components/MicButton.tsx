import type { AssistantState } from "../types";

/** Base bar heights, in px — the waveform's resting shape. */
const BARS = [16, 22, 14, 20];

/**
 * Visual-only mic control, animated in CSS.
 * Idle breathes slowly; listening runs a fast waveform under an expanding ring.
 * Wiring real capture later is a matter of swapping the click handler.
 */
export default function MicButton({
  state,
  onToggle,
}: {
  state: AssistantState;
  onToggle: () => void;
}) {
  const active = state === "listening";

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={active ? "Stop listening" : "Start listening"}
      aria-pressed={active}
      className="relative flex h-[54px] w-[54px] flex-none cursor-pointer items-center justify-center"
    >
      {/* expanding ring — slow and faint when idle, quick when listening */}
      <span
        className="pointer-events-none absolute inset-0 rounded-full border border-accent"
        style={{
          animation: active
            ? "vcring 1.2s ease-out infinite"
            : "vcbreathe-ring 3.6s ease-out infinite",
        }}
      />
      {/* the circle itself */}
      <span
        className={`flex h-[54px] w-[54px] items-center justify-center gap-[3px] rounded-full transition-colors ${
          active ? "bg-accent" : "bg-ink hover:bg-accent"
        }`}
        style={{ animation: active ? undefined : "vcbreathe 3.6s ease-in-out infinite" }}
      >
        {BARS.map((height, i) => (
          <span
            key={i}
            className="w-[3px] rounded-[2px] bg-canvas"
            style={{
              height,
              transformOrigin: "center",
              animation: active
                ? `vcbar 0.9s ease-in-out ${i * 0.15}s infinite`
                : `vcbar-idle 3.6s ease-in-out ${i * 0.28}s infinite`,
            }}
          />
        ))}
      </span>
    </button>
  );
}
