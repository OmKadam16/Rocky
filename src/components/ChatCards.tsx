import { useEffect, useState } from "react";
import type { useAssistant } from "../hooks/useAssistant";
import type { ChatCard, CommitmentFields } from "../types";
import { DAY_SHORT, editProposal, getProposal, subscribeProposals, summarize } from "../lib/commitmentProposals";
import { canUndo, subscribeUndo } from "../lib/undoJournal";
import MemoryResultCard from "./MemoryResultCard";

type Assistant = ReturnType<typeof useAssistant>;
type Props = { card: ChatCard; assistant: Assistant };

const btn = "cursor-pointer rounded-[3px] px-[14px] py-[7px] text-13";
const primary = `${btn} bg-ink font-medium text-canvas hover:bg-accent`;
const ghost = `${btn} border border-line-strong font-mono text-ink-muted hover:border-ink hover:text-ink`;
const label = "font-mono text-micro tracking-tab uppercase text-grey";
const input = "rounded-[3px] border border-line-strong bg-card px-2 py-[6px] text-13 text-ink outline-none focus:border-ink";

/** Rich chat cards, by kind. */
export default function ChatCardView({ card, assistant }: Props) {
  switch (card.kind) {
    case "commitment":
      return <CommitmentCard card={card} assistant={assistant} />;
    case "receipt":
      return <ReceiptCard card={card} assistant={assistant} />;
    case "memory":
      return <MemoryResultCard status={card.status} answer={card.answer} sources={card.sources} />;
    default:
      return null;
  }
}

function useProposal(id: string) {
  const [, force] = useState(0);
  useEffect(() => subscribeProposals(() => force((n) => n + 1)), []);
  return getProposal(id);
}

const STATUS_TEXT = { confirmed: "Saved", cancelled: "Cancelled — nothing saved", replaced: "Replaced by a newer version" } as const;

function CommitmentCard({ card, assistant }: { card: Extract<ChatCard, { kind: "commitment" }>; assistant: Assistant }) {
  const live = useProposal(card.proposalId);
  const fields = live?.fields ?? card.fields;
  const conflicts = live?.conflicts ?? card.conflicts;
  const status = live?.status ?? "expired";
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const isDelete = card.op === "delete";
  const heading = isDelete ? "Remove commitment" : card.op === "update" ? "Change commitment" : "New commitment";

  const confirm = async () => {
    setBusy(true);
    const line = await assistant.confirmCommitment(card.proposalId);
    setBusy(false);
    if (line !== "Saved." && line !== "Removed.") setNote(line);
  };

  return (
    <div className="rounded-[4px] border border-line bg-card px-[16px] py-[14px]">
      <div className="flex items-center justify-between gap-3">
        <span className={label}>{heading}</span>
        {status !== "pending" && (
          <span className={`font-mono text-micro tracking-tab uppercase ${status === "confirmed" ? "text-accent" : "text-grey-mid"}`}>
            {status === "expired" ? "Expired — ask again" : STATUS_TEXT[status]}
          </span>
        )}
      </div>
      {editing && status === "pending" ? (
        <CommitmentEditor
          fields={fields}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            const r = await editProposal(card.proposalId, patch);
            if (r.ok) {
              setEditing(false);
              setNote(null);
            } else setNote(r.error ?? "Check the fields.");
          }}
        />
      ) : (
        <div className={`mt-[8px] text-15 leading-[1.45] ${isDelete ? "text-ink-muted line-through decoration-grey-mid" : "text-ink"}`}>{summarize(fields)}</div>
      )}
      {!isDelete && conflicts.length > 0 && (
        <ul className="mt-[8px] flex flex-col gap-1 font-mono text-meta leading-[1.5] text-warm">
          {conflicts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {note && <div className="mt-[8px] font-mono text-meta text-warm">{note}</div>}
      {status === "pending" && !editing && (
        <div className="mt-[12px] flex items-center gap-2">
          <button type="button" className={primary} disabled={busy} onClick={() => void confirm()}>
            {busy ? "Saving…" : "Confirm"}
          </button>
          {!isDelete && (
            <button type="button" className={ghost} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button type="button" className={ghost} onClick={() => assistant.cancelCommitment(card.proposalId)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function CommitmentEditor({ fields, onSave, onCancel }: { fields: CommitmentFields; onSave: (p: Partial<CommitmentFields>) => void; onCancel: () => void }) {
  const [f, setF] = useState(fields);
  const set = <K extends keyof CommitmentFields>(k: K, v: CommitmentFields[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleDay = (d: number) =>
    set("days_of_week", f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort((a, b) => a - b));
  return (
    <div className="mt-[10px] flex flex-col gap-[10px]">
      <input className={input} value={f.name} onChange={(e) => set("name", e.target.value)} aria-label="Name" />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
        {DAY_SHORT.map((d, i) => (
          <button
            key={d}
            type="button"
            onClick={() => toggleDay(i)}
            className={`cursor-pointer rounded-[3px] border px-[9px] py-[5px] font-mono text-meta ${f.days_of_week.includes(i) ? "border-ink bg-ink text-canvas" : "border-line-strong text-grey-mid hover:border-ink"}`}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="time" className={input} value={f.start_time} onChange={(e) => set("start_time", e.target.value)} aria-label="Start" />
        <span className="font-mono text-meta text-grey">to</span>
        <input type="time" className={input} value={f.end_time} onChange={(e) => set("end_time", e.target.value)} aria-label="End" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={label}>From</span>
        <input type="date" className={input} value={f.active_from ?? ""} onChange={(e) => set("active_from", e.target.value || null)} />
        <span className={label}>Until</span>
        <input type="date" className={input} value={f.active_until ?? ""} onChange={(e) => set("active_until", e.target.value || null)} />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={primary} onClick={() => onSave(f)}>
          Done
        </button>
        <button type="button" className={ghost} onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  );
}

function ReceiptCard({ card, assistant }: { card: Extract<ChatCard, { kind: "receipt" }>; assistant: Assistant }) {
  const [, force] = useState(0);
  const [undone, setUndone] = useState(false);
  useEffect(() => subscribeUndo(() => force((n) => n + 1)), []);
  const can = canUndo(card.undoId);
  return (
    <div className="flex items-center gap-3 font-mono text-meta leading-[1.5]">
      <span className={undone ? "text-grey-mid line-through" : "text-accent-deep"}>✓ {card.text}</span>
      {can && !undone && card.undoId && (
        <button
          type="button"
          onClick={async () => {
            if (await assistant.undo(card.undoId as string)) setUndone(true);
          }}
          className="cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid underline-offset-2 hover:text-ink hover:underline"
        >
          Undo
        </button>
      )}
      {undone && <span className="text-micro uppercase tracking-tab text-grey-mid">Undone</span>}
    </div>
  );
}
