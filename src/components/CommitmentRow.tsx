import type { Commitment } from "../types";
import { pastelSurface } from "./blockStyles";

export default function CommitmentRow({
  commitment,
  onRemove,
  onEdit,
}: {
  commitment: Commitment;
  onRemove: (id: string) => void;
  onEdit: (commitment: Commitment) => void;
}) {
  return (
    <div className={`flex items-center gap-[18px] px-4 py-[13px] ${pastelSurface(commitment.color)}`}>
      <div className="flex w-[11px] flex-none flex-col items-center">
        <div className="h-1 w-[7px] rounded-t-[3px] border border-b-0 border-grey-mid" />
        <div
          className="h-[6px] w-[10px] rounded-[1px]"
          style={{
            background: commitment.color ? `var(--color-pastel-${commitment.color})` : undefined,
          }}
        />
        {!commitment.color && <div className="h-[6px] w-[10px] rounded-[1px] bg-grey-ghost" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-15 font-medium text-ink-soft">
          {commitment.name}
        </div>
        <div className="mt-[5px] font-mono text-meta tracking-gap uppercase text-grey-mid">
          {commitment.kind === "Other" && commitment.otherLabel
            ? `${commitment.kind} · ${commitment.otherLabel}`
            : commitment.kind}
        </div>
        {commitment.notes && (
          <div className="mt-1 whitespace-pre-line break-words font-mono text-meta leading-[1.4] text-grey">
            {commitment.notes}
          </div>
        )}
      </div>

      <div className="flex flex-col items-end gap-1">
        <div className="font-mono text-hint tracking-days text-ink-muted">{commitment.days.join(" · ")}</div>
        {(commitment.activeFrom || commitment.activeUntil) && (
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">
            {commitment.activeFrom ?? "—"} → {commitment.activeUntil ?? "—"}
          </div>
        )}
      </div>
      <div className="w-[106px] flex-none text-right font-mono text-hint text-ink-muted">
        {commitment.start}–{commitment.end}
      </div>
      <button
        type="button"
        onClick={() => onEdit(commitment)}
        aria-label={`Edit ${commitment.name}`}
        className="flex-none cursor-pointer text-grey-ghost transition-colors hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onRemove(commitment.id)}
        aria-label={`Remove ${commitment.name}`}
        className="flex-none cursor-pointer font-mono text-13 text-grey-ghost transition-colors hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}
