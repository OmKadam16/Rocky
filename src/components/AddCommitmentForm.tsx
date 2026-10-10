import { useEffect, useState } from "react";
import { minutesOf } from "../../shared/datetime";
import {
  PASTEL_ORDER,
  WEEKDAYS,
  type Commitment,
  type CommitmentKind,
  type PastelColor,
  type Weekday,
} from "../types";
import DatePicker from "./DatePicker";

const KINDS: CommitmentKind[] = ["Class", "Work", "Gym", "Other"];

const FIELD_LABEL = "font-mono text-micro tracking-tab uppercase text-grey-mid";
const UNDERLINE_INPUT =
  "w-full border-0 border-b border-line-strong bg-transparent pb-[9px] text-ink outline-none focus:border-ink";

function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rawH, rawM] = value.split(":");
  const hour = rawH ?? "09";
  const minute = rawM ?? "00";
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const baseMinutes = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
  const minutes = baseMinutes.includes(minute) ? baseMinutes : [...baseMinutes, minute].sort();
  return (
    <div className="group flex items-center gap-[2px] border-b border-line-strong pb-[9px] transition-colors focus-within:border-ink">
      <div className="relative">
        <select
          value={hour}
          onChange={(e) => onChange(`${e.target.value}:${minute}`)}
          className="cursor-pointer appearance-none bg-transparent pr-[14px] font-mono text-lead tracking-[-0.02em] text-ink outline-none"
        >
          {hours.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 font-mono text-[10px] text-grey-faint">
          ▾
        </span>
      </div>
      <span className="font-mono text-lead text-grey-faint">:</span>
      <div className="relative">
        <select
          value={minute}
          onChange={(e) => onChange(`${hour}:${e.target.value}`)}
          className="cursor-pointer appearance-none bg-transparent pr-[14px] font-mono text-lead tracking-[-0.02em] text-ink outline-none"
        >
          {minutes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 font-mono text-[10px] text-grey-faint">
          ▾
        </span>
      </div>
    </div>
  );
}

type Props = {
  onAdd: (c: Commitment) => void;
  onUpdate?: (c: Commitment) => void;
  editing?: Commitment | null;
  onCancelEdit?: () => void;
};

export default function AddCommitmentForm({ onAdd, onUpdate, editing, onCancelEdit }: Props) {
  const isEditing = Boolean(editing);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CommitmentKind>("Class");
  const [otherLabel, setOtherLabel] = useState("");
  const [days, setDays] = useState<Weekday[]>([]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("10:00");
  const [color, setColor] = useState<PastelColor | null>(null);
  const [notes, setNotes] = useState("");
  const [activeFrom, setActiveFrom] = useState("");
  const [activeUntil, setActiveUntil] = useState("");

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setKind(editing.kind);
      setOtherLabel(editing.otherLabel ?? "");
      setDays(editing.days);
      setStart(editing.start);
      setEnd(editing.end);
      setColor(editing.color ?? null);
      setNotes(editing.notes ?? "");
      setActiveFrom(editing.activeFrom ?? "");
      setActiveUntil(editing.activeUntil ?? "");
    } else {
      setName("");
      setKind("Class");
      setOtherLabel("");
      setDays([]);
      setStart("09:00");
      setEnd("10:00");
      setColor(null);
      setNotes("");
      setActiveFrom("");
      setActiveUntil("");
    }
  }, [editing]);

  const timeValid = minutesOf(end) > minutesOf(start);
  const rangeValid = !activeFrom || !activeUntil || activeFrom <= activeUntil;
  const ready = name.trim().length > 0 && days.length > 0 && Boolean(color) && timeValid && rangeValid;

  const toggleDay = (day: Weekday) =>
    setDays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
    );

  const submit = () => {
    if (!ready || !color) return;
    const range = {
      activeFrom: activeFrom || undefined,
      activeUntil: activeUntil || undefined,
    };
    if (isEditing && editing && onUpdate) {
      onUpdate({
        ...editing,
        name: name.trim(),
        kind,
        otherLabel: kind === "Other" ? otherLabel.trim() || undefined : undefined,
        days: WEEKDAYS.filter((d) => days.includes(d)),
        start,
        end,
        color,
        notes: notes.trim() || undefined,
        ...range,
      });
    } else {
      onAdd({
        id: `c-${Date.now()}`,
        name: name.trim(),
        kind,
        otherLabel: kind === "Other" ? otherLabel.trim() || undefined : undefined,
        days: WEEKDAYS.filter((d) => days.includes(d)),
        start,
        end,
        color,
        notes: notes.trim() || undefined,
        ...range,
      });
      setName("");
      setOtherLabel("");
      setDays([]);
      setColor(null);
      setNotes("");
      setActiveFrom("");
      setActiveUntil("");
    }
  };

  const cancel = () => {
    if (onCancelEdit) onCancelEdit();
  };

  return (
    <aside className="flex w-[452px] flex-none flex-col border-l border-line bg-panel">
      <div className="border-b border-line-panel px-[34px] pb-[22px] pt-[30px]">
        <div className="font-mono text-label tracking-label uppercase text-grey">
          {isEditing ? "Edit commitment" : "Add a commitment"}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-[30px] overflow-y-auto px-[34px] py-[30px]">
        <div className="flex flex-col gap-[10px]">
          <div className={FIELD_LABEL}>Name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Studio practice"
            className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`}
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>Type</div>
          <div className="flex gap-2">
            {KINDS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={`cursor-pointer rounded-[3px] border px-[15px] py-2 text-13 transition-colors ${
                  kind === option
                    ? "border-ink bg-ink text-canvas"
                    : "border-line-strong text-ink-muted hover:border-ink hover:text-ink"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {kind === "Other" && (
          <div className="flex flex-col gap-[10px] animate-[vcin_0.4s_ease_both]">
            <div className={FIELD_LABEL}>Describe “Other”</div>
            <input
              value={otherLabel}
              onChange={(e) => setOtherLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Volunteering"
              className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`}
            />
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>Color</div>
          <div className="flex gap-[10px]">
            {PASTEL_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                aria-pressed={color === c}
                className={`h-[30px] w-[30px] cursor-pointer rounded-full border-2 transition-all ${
                  color === c
                    ? "border-ink ring-2 ring-ink ring-offset-2 ring-offset-panel scale-105"
                    : "border-transparent hover:scale-105"
                }`}
                style={{
                  background: `var(--color-pastel-${c})`,
                  boxShadow: color === c ? "none" : `inset 0 0 0 1px var(--color-pastel-${c}-line)`,
                }}
              />
            ))}
          </div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">
            {color ? color : "Pick a color"}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>Repeats on</div>
          <div className="flex gap-[6px]">
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleDay(day)}
                aria-pressed={days.includes(day)}
                className={`flex h-[42px] w-[42px] cursor-pointer items-center justify-center rounded-[3px] border font-mono text-hint transition-colors ${
                  days.includes(day)
                    ? "border-ink bg-ink text-canvas"
                    : "border-line-strong text-grey hover:border-ink hover:text-ink"
                }`}
              >
                {day.slice(0, 2).toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>
            Active dates <span className="font-mono text-micro normal-case tracking-normal text-grey-faint">(optional)</span>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <DatePicker value={activeFrom} onChange={setActiveFrom} placeholder="mm/dd/yyyy" align="left" />
            </div>
            <span className="self-center font-mono text-13 text-grey-faint">→</span>
            <div className="flex-1">
              <DatePicker value={activeUntil} onChange={setActiveUntil} placeholder="mm/dd/yyyy" align="right" />
            </div>
          </div>
          <div className="font-mono text-micro leading-[1.4] text-grey-faint">For semester classes — e.g., Fall Aug → Dec. Leave blank for year-round.</div>
          {!rangeValid && <div className="font-mono text-micro text-red-500">Until must be after From</div>}
        </div>

        <div className="flex gap-[34px]">
          <div className="flex flex-col gap-[10px]">
            <div className={FIELD_LABEL}>Starts</div>
            <TimePicker value={start} onChange={setStart} />
          </div>
          <div className="flex flex-col gap-[10px]">
            <div className={FIELD_LABEL}>Ends</div>
            <TimePicker value={end} onChange={setEnd} />
          </div>
        </div>
        {!timeValid && (
          <div className="font-mono text-micro tracking-tab uppercase text-red-500">
            End must be after start
          </div>
        )}

        <div className="flex flex-col gap-[10px]">
          <div className={FIELD_LABEL}>Note</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. print assignment"
            rows={2}
            className="w-full resize-none rounded-[3px] border border-line-strong bg-transparent px-3 py-2 text-15 leading-[1.45] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">
            For commitments and every block — also via voice “add a note”
          </div>
        </div>
      </div>

      <div className="flex items-center gap-[12px] border-t border-line-panel px-[34px] pb-[30px] pt-[22px]">
        {isEditing ? (
          <>
            <button
              type="button"
              onClick={submit}
              className={`cursor-pointer rounded-[3px] px-[26px] py-[13px] text-14 font-medium transition-colors ${
                ready
                  ? "bg-ink text-canvas hover:bg-accent"
                  : "bg-line-strong text-grey-mid cursor-not-allowed"
              }`}
            >
              Update
            </button>
            <button
              type="button"
              onClick={cancel}
              className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-[18px] py-[11px] font-mono text-13 text-ink-muted transition-colors hover:border-ink hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={submit}
            className={`cursor-pointer rounded-[3px] px-[26px] py-[13px] text-14 font-medium transition-colors ${
              ready
                ? "bg-ink text-canvas hover:bg-accent"
                : "bg-line-strong text-grey-mid cursor-not-allowed"
            }`}
          >
            Add commitment
          </button>
        )}
        <div className="font-mono text-label leading-[1.5] text-grey">
          {ready
            ? "The assistant will schedule around it."
            : !color
              ? "Pick a color to continue."
              : "Name, color and at least one day."}
        </div>
      </div>
    </aside>
  );
}
