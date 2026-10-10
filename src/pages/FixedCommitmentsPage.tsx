import { useEffect, useState } from "react";
import AddCommitmentForm from "../components/AddCommitmentForm";
import CommitmentRow from "../components/CommitmentRow";
import { minutesOf } from "../../shared/datetime";
import type { Commitment } from "../types";

function weeklyHours(commitments: Commitment[]): number {
  const minutes = commitments.reduce(
    (total, c) => total + c.days.length * Math.max(0, minutesOf(c.end) - minutesOf(c.start)),
    0,
  );
  return Math.round(minutes / 60);
}

type Props = {
  commitments: Commitment[];
  fixedError?: string | null;
  onAdd: (commitment: Commitment) => Promise<void>;
  onUpdate: (commitment: Commitment) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

export default function FixedCommitmentsPage({ commitments, fixedError, onAdd, onUpdate, onRemove }: Props) {
  const [pending, setPending] = useState<Commitment | null>(null);
  const [editing, setEditing] = useState<Commitment | null>(null);
  const [undo, setUndo] = useState<Commitment | null>(null);
  const [undoSeconds, setUndoSeconds] = useState(5);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const handleUndo = () => {
    if (!undo) return;
    onAdd(undo);
    setUndo(null);
  };

  useEffect(() => {
    if (!undo) return;
    setUndoSeconds(5);
    const interval = setInterval(() => setUndoSeconds((s) => Math.max(0, s - 1)), 1000);
    const timeout = setTimeout(() => setUndo(null), 5000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
      window.removeEventListener("keydown", onKey);
    };
  }, [undo]);

  const confirmRemove = () => {
    if (pending) {
      const removed = pending;
      setUndo(removed);
      onRemove(removed.id);
      if (editing?.id === removed.id) setEditing(null);
      setPending(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col pb-10 pl-[60px] pr-14 pt-[52px]">
        <div className="font-mono text-label tracking-label uppercase text-grey">Fixed commitments</div>

        <div className="mt-10 max-w-[560px]">
          <h1 className="text-display-fixed font-medium tracking-[-0.026em] [text-wrap:pretty]">
            These never move.
            <br />
            Everything else is negotiable.
          </h1>
        </div>

        <p className="mt-[22px] max-w-[470px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
          Classes, shifts, standing appointments. The assistant schedules around them and will never
          offer to reschedule one.
        </p>

        <div className="mt-10 flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-meta tracking-tab uppercase text-grey-mid">
            {commitments.length} commitments
          </div>
          <div className="font-mono text-meta tracking-tab uppercase text-grey-mid">
            {weeklyHours(commitments)} hr / week
          </div>
        </div>
        {fixedError && (
          <div className="mt-3 font-mono text-meta tracking-gap uppercase text-red-500">{fixedError}</div>
        )}

        <div className="mt-[14px] flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-2">
          {commitments.map((commitment) => (
            <CommitmentRow
              key={commitment.id}
              commitment={commitment}
              onRemove={() => setPending(commitment)}
              onEdit={setEditing}
            />
          ))}
          {commitments.length === 0 && (
            <div className="font-mono text-label tracking-gap uppercase text-grey-ghost">
              Nothing fixed yet
            </div>
          )}
        </div>
      </div>

      <AddCommitmentForm
        editing={editing}
        onAdd={onAdd}
        onUpdate={(c) => {
          onUpdate(c);
          setEditing(null);
        }}
        onCancelEdit={() => setEditing(null)}
      />

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-[2px] px-4"
          onClick={() => setPending(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm removal"
        >
          <div
            className="w-full max-w-[420px] rounded-[4px] border border-line-strong bg-panel px-7 py-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Remove commitment</div>
            <h2 className="mt-3 text-15 font-medium leading-[1.45] text-ink [text-wrap:pretty]">
              Remove “{pending.name}”?
            </h2>
            <p className="mt-1 font-mono text-meta leading-[1.5] text-grey">You can undo for 5 seconds.</p>
            <p className="mt-2 font-mono text-meta leading-[1.5] text-grey">
              {pending.days.join(" · ")} · {pending.start}–{pending.end}
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-[18px] py-[9px] font-mono text-13 text-ink-muted transition-colors hover:border-ink hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRemove}
                className="cursor-pointer rounded-[3px] bg-ink px-[18px] py-[9px] text-13 font-medium text-canvas transition-colors hover:bg-accent-dark"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {undo && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-4 rounded-full bg-ink px-5 py-3 shadow-xl animate-[vcin_0.3s_ease]">
            <div className="font-mono text-13 text-canvas">
              Removed “{undo.name}” · {undoSeconds}s
            </div>
            <button
              type="button"
              onClick={handleUndo}
              className="cursor-pointer rounded-full bg-canvas px-4 py-[6px] font-mono text-12 font-medium text-ink transition-colors hover:bg-panel"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => setUndo(null)}
              aria-label="Dismiss"
              className="cursor-pointer font-mono text-13 leading-none text-grey-ghost hover:text-canvas"
            >
              ×
            </button>
          </div>
          <div className="mx-auto mt-2 h-1 w-[220px] overflow-hidden rounded-full bg-ink/20">
            <div
              className="h-full bg-accent transition-all duration-1000 ease-linear"
              style={{ width: `${(undoSeconds / 5) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
