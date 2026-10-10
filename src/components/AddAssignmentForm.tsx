import { useEffect, useState } from "react";
import { PASTEL_ORDER, type PastelColor } from "../types";
import DatePicker from "./DatePicker";

const FIELD_LABEL = "font-mono text-micro tracking-tab uppercase text-grey-mid";
const UNDERLINE_INPUT =
  "w-full border-0 border-b border-line-strong bg-transparent pb-[9px] text-ink outline-none focus:border-ink";

const DURATIONS = [
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "1.5 hr", value: 90 },
  { label: "2 hr", value: 120 },
  { label: "3 hr", value: 180 },
  { label: "4 hr", value: 240 },
  { label: "5 hr", value: 300 },
];

type Props = {
  onAdd: (a: { name: string; course?: string; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: PastelColor }) => void;
  onUpdate?: (a: { id: string; name: string; course?: string; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: PastelColor }) => void;
  editing?: { id: string; name: string; course?: string | null; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: PastelColor } | null;
  onCancelEdit?: () => void;
  variant?: "aside" | "inline";
};

export default function AddAssignmentForm({ onAdd, onUpdate, editing, onCancelEdit, variant = "aside" }: Props) {
  const isEditing = Boolean(editing);
  const [name, setName] = useState("");
  const [course, setCourse] = useState("");
  const [deadline, setDeadline] = useState("");
  const [duration, setDuration] = useState(60);
  const [priority, setPriority] = useState<"high" | "normal" | "low">("normal");
  const [color, setColor] = useState<PastelColor | null>(null);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setCourse(editing.course ?? "");
      setDeadline(editing.deadline);
      setDuration(editing.estimatedDuration);
      setPriority(editing.priority);
      setColor(editing.color ?? null);
    } else {
      setName("");
      setCourse("");
      setDeadline("");
      setDuration(60);
      setPriority("normal");
      setColor(null);
    }
  }, [editing]);

  const ready = name.trim().length > 0 && deadline && duration > 0 && Boolean(color);

  const submit = () => {
    if (!ready || !color) return;
    if (isEditing && editing && onUpdate) {
      onUpdate({ id: editing.id, name: name.trim(), course: course.trim() || undefined, deadline, estimatedDuration: duration, priority, color });
    } else {
      onAdd({ name: name.trim(), course: course.trim() || undefined, deadline, estimatedDuration: duration, priority, color });
      setName("");
      setCourse("");
      setDeadline("");
      setDuration(60);
      setColor(null);
    }
  };

  const isInline = variant === "inline";
  const wrapper = isInline
    ? "flex flex-col rounded-[3px] border border-line-strong bg-panel"
    : "flex w-[452px] flex-none flex-col border-l border-line bg-panel";
  const headerPad = isInline ? "px-6 pb-4 pt-5" : "px-[34px] pb-[22px] pt-[30px]";
  const bodyPad = isInline ? "px-6 py-6 gap-[22px]" : "px-[34px] py-[30px] gap-[30px]";
  const footerPad = isInline ? "px-6 pb-5 pt-4" : "px-[34px] pb-[30px] pt-[22px]";

  return (
    <aside className={wrapper}>
      <div className={`border-b border-line-panel ${headerPad}`}>
        <div className="font-mono text-label tracking-label uppercase text-grey">{isEditing ? "Edit assignment" : "Add assignment"}</div>
      </div>
      <div className={`flex flex-1 flex-col overflow-y-auto ${bodyPad}`}>
        <div className="flex flex-col gap-[10px]">
          <div className={FIELD_LABEL}>Assignment</div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Biology essay" className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`} />
        </div>
        <div className="flex flex-col gap-[10px]">
          <div className={FIELD_LABEL}>Course / Project</div>
          <input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="Biology" className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`} />
        </div>
        <div className="flex flex-col gap-[10px]">
          <div className={FIELD_LABEL}>Due date</div>
          <DatePicker value={deadline} onChange={setDeadline} placeholder="Select due date" />
        </div>
        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>How long will it take?</div>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button key={d.value} type="button" onClick={() => setDuration(d.value)} className={`cursor-pointer rounded-[3px] border px-[12px] py-2 text-13 transition-colors ${duration === d.value ? "border-ink bg-ink text-canvas" : "border-line-strong text-ink-muted hover:border-ink hover:text-ink"}`}>
                {d.label}
              </button>
            ))}
          </div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">AI will chunk 1–2hr into 1hr pieces, 4–5hr into daily chunks until due date</div>
        </div>
        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>Priority</div>
          <div className="flex gap-2">
            {(["high", "normal", "low"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPriority(p)} className={`cursor-pointer rounded-[3px] border px-[15px] py-2 text-13 capitalize transition-colors ${priority === p ? "border-ink bg-ink text-canvas" : "border-line-strong text-ink-muted hover:border-ink hover:text-ink"}`}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className={FIELD_LABEL}>Color</div>
          <div className="flex gap-[10px]">
            {PASTEL_ORDER.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-pressed={color === c} className={`h-[30px] w-[30px] cursor-pointer rounded-full border-2 transition-all ${color === c ? "border-ink ring-2 ring-ink ring-offset-2 ring-offset-panel scale-105" : "border-transparent hover:scale-105"}`} style={{ background: `var(--color-pastel-${c})`, boxShadow: color === c ? "none" : `inset 0 0 0 1px var(--color-pastel-${c}-line)` }} />
            ))}
          </div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">{color ? color : "Pick a color"}</div>
        </div>
      </div>
      <div className={`flex items-center gap-[12px] border-t border-line-panel ${footerPad}`}>
        {isEditing ? (
          <>
            <button type="button" onClick={submit} className={`cursor-pointer rounded-[3px] px-[26px] py-[13px] text-14 font-medium transition-colors ${ready ? "bg-ink text-canvas hover:bg-accent" : "bg-line-strong text-grey-mid cursor-not-allowed"}`}>Update</button>
            <button type="button" onClick={() => onCancelEdit?.()} className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-[18px] py-[11px] font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">Cancel</button>
          </>
        ) : (
          <button type="button" onClick={submit} className={`cursor-pointer rounded-[3px] px-[26px] py-[13px] text-14 font-medium transition-colors ${ready ? "bg-ink text-canvas hover:bg-accent" : "bg-line-strong text-grey-mid cursor-not-allowed"}`}>Add assignment</button>
        )}
        <div className="font-mono text-label leading-[1.5] text-grey">{ready ? "AI will chunk and schedule it." : "Name, due date, color required."}</div>
      </div>
    </aside>
  );
}
