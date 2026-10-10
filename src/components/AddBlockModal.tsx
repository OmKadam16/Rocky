import { useEffect, useState } from "react";
import DatePicker from "./DatePicker";

type Props = {
  open: boolean;
  mode: "day" | "week" | "month";
  defaultDate: string;
  weekDates?: string[];
  onClose: () => void;
  onSave: (data: { title: string; date: string; start: string; end: string; note?: string }) => void;
};

const FIELD_LABEL = "font-mono text-micro tracking-tab uppercase text-grey-mid";

export default function AddBlockModal({ open, mode, defaultDate, weekDates, onClose, onSave }: Props) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [weekDay, setWeekDay] = useState(defaultDate);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setDate(defaultDate);
      setWeekDay(defaultDate);
      setTitle("");
      setNote("");
      setStart("09:00");
      setEnd("10:00");
    }
  }, [open, defaultDate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const effectiveDate = mode === "week" ? weekDay : date;
  const timeValid = end > start;
  const ready = title.trim().length > 0 && effectiveDate && timeValid;

  const handleSave = () => {
    if (!ready) return;
    onSave({ title: title.trim(), date: effectiveDate, start, end, note: note.trim() || undefined });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-[2px] p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-[480px] rounded-[4px] border border-line-strong bg-panel px-7 py-6 shadow-xl animate-[vcin_0.2s_ease]" onClick={(e) => e.stopPropagation()}>
        <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Add block · {mode}</div>
        <h2 className="mt-3 text-15 font-medium leading-[1.45] text-ink">New {mode === "day" ? "time block" : mode === "week" ? "weekly block" : "dated block"}</h2>

        <div className="mt-6 flex flex-col gap-5">
          <label className="flex flex-col gap-2">
            <span className={FIELD_LABEL}>Name</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Study session" className="w-full rounded-[3px] border border-line-strong bg-card px-3 py-2.5 text-15 text-ink outline-none placeholder:text-grey-faint focus:border-ink" />
          </label>

          {mode === "week" && weekDates && (
            <label className="flex flex-col gap-2">
              <span className={FIELD_LABEL}>Day</span>
              <select value={weekDay} onChange={(e) => setWeekDay(e.target.value)} className="w-full cursor-pointer rounded-[3px] border border-line-strong bg-card px-3 py-2.5 font-mono text-13 text-ink outline-none focus:border-ink">
                {weekDates.map((d) => {
                  const dt = new Date(d);
                  const label = dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                  return <option key={d} value={d}>{label} — {d}</option>;
                })}
              </select>
            </label>
          )}

          {mode === "month" && (
            <label className="flex flex-col gap-2">
              <span className={FIELD_LABEL}>Date</span>
              <DatePicker value={date} onChange={setDate} placeholder="mm/dd/yyyy" />
            </label>
          )}

          {mode === "day" && (
            <div className="font-mono text-12 text-grey">
              Date: <span className="text-ink">{effectiveDate}</span>
            </div>
          )}

          <div className="flex gap-4">
            <label className="flex flex-1 flex-col gap-2">
              <span className={FIELD_LABEL}>Start</span>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-[3px] border border-line-strong bg-card px-3 py-2 font-mono text-13 text-ink outline-none focus:border-ink" />
            </label>
            <label className="flex flex-1 flex-col gap-2">
              <span className={FIELD_LABEL}>End</span>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-[3px] border border-line-strong bg-card px-3 py-2 font-mono text-13 text-ink outline-none focus:border-ink" />
            </label>
          </div>
          {!timeValid && <div className="font-mono text-micro text-red-500">End must be after start</div>}

          <label className="flex flex-col gap-2">
            <span className={FIELD_LABEL}>Note <span className="normal-case text-grey-faint">(optional)</span></span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. bring notes" rows={2} className="w-full resize-none rounded-[3px] border border-line-strong bg-card px-3 py-2 text-14 text-ink outline-none placeholder:text-grey-faint focus:border-ink" />
          </label>
        </div>

        <div className="mt-8 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-5 py-2.5 font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">Cancel</button>
          <button type="button" onClick={handleSave} disabled={!ready} className={`cursor-pointer rounded-[3px] px-6 py-2.5 text-13 font-medium ${ready ? "bg-ink text-canvas hover:bg-accent" : "bg-line-strong text-grey-mid cursor-not-allowed"}`}>Add block</button>
        </div>
      </div>
    </div>
  );
}
