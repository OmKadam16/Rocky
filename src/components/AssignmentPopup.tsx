import { useEffect, useState } from "react";
import { PASTEL_ORDER, type PastelColor } from "../types";
import DatePicker from "./DatePicker";

const FIELD_LABEL = "font-mono text-micro tracking-tab uppercase text-grey-mid";
const UNDERLINE_INPUT =
  "w-full border-0 border-b border-line-strong bg-transparent pb-[9px] text-ink outline-none focus:border-ink";



type Part = { id: string; name: string; duration: number };

type Props = {
  open: boolean;
  editing?: { id: string; name: string; course?: string | null; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: PastelColor; parts?: Part[] } | null;
  onClose: () => void;
  onSave: (data: { name: string; course?: string; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: PastelColor; parts: Part[] }) => void;
};

export default function AssignmentPopup({ open, editing, onClose, onSave }: Props) {
  const [name, setName] = useState("");
  const [course, setCourse] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<"high" | "normal" | "low">("normal");
  const [color, setColor] = useState<PastelColor | null>(null);
  const [parts, setParts] = useState<Part[]>([]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setCourse(editing.course ?? "");
      setDeadline(editing.deadline);
      setPriority(editing.priority);
      setColor(editing.color ?? null);
      setParts(editing.parts ?? []);
    } else {
      setName("");
      setCourse("");
      setDeadline("");
      setPriority("normal");
      setColor(null);
      setParts([]);
    }
  }, [open, editing]);

  const totalDuration = parts.length ? parts.reduce((t, p) => t + (p.duration || 0), 0) : 0;
  const ready = name.trim().length > 0 && deadline && Boolean(color) && (parts.length === 0 || parts.every((p) => p.name.trim().length > 0));

  const addPart = () => setParts((l) => [...l, { id: `p-${Date.now()}-${Math.random()}`, name: "", duration: 60 }]);
  const updatePart = (id: string, patch: Partial<Part>) => setParts((l) => l.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const removePart = (id: string) => setParts((l) => l.filter((p) => p.id !== id));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-[2px] p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="flex max-h-[90vh] w-full max-w-[680px] flex-col rounded-[4px] border border-line-strong bg-panel shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line-panel px-[34px] pb-[22px] pt-[30px]">
          <div className="font-mono text-label tracking-label uppercase text-grey">{editing ? "Edit assignment" : "Add assignment"}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer font-mono text-13 text-grey-ghost hover:text-ink">×</button>
        </div>

        <div className="flex flex-1 flex-col gap-[28px] overflow-y-auto px-[34px] py-[30px]">
          <div className="flex flex-col gap-[10px]">
            <div className={FIELD_LABEL}>Assignment</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Biology essay" className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`} />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="flex flex-col gap-[10px]">
              <div className={FIELD_LABEL}>Course / Project</div>
              <input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="Biology" className={`${UNDERLINE_INPUT} text-input placeholder:text-grey-faint`} />
            </div>
            <div className="flex flex-col gap-[10px]">
              <div className={FIELD_LABEL}>Due date</div>
              <DatePicker value={deadline} onChange={setDeadline} placeholder="Select due date" />
            </div>
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
            <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">{color ? color : "Pick a color"} {totalDuration ? `· total ${totalDuration}m · ${parts.length ? `${parts.length} parts` : "no parts"}` : ""}</div>
          </div>

          <div className="rounded-[3px] border border-line-panel bg-card/50 p-0">
            <div className="flex items-center justify-between border-b border-line-panel px-6 py-4">
              <div>
                <div className={FIELD_LABEL}>Parts</div>
                <div className="mt-1 font-mono text-micro tracking-tab uppercase text-grey-faint">{parts.length ? `${parts.length} parts · ${totalDuration} min total` : "Split into named pieces — the assistant will schedule each part before the due date"}</div>
              </div>
              <button type="button" onClick={addPart} className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-4 py-2 font-mono text-micro tracking-tab uppercase text-ink-muted hover:border-ink hover:text-ink">+ Add part</button>
            </div>

            {parts.length === 0 ? (
              <div className="px-6 py-8 text-center">
                <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">No parts yet</div>
                <div className="mt-2 text-15 leading-[1.5] text-grey">Add parts like “Research”, “Draft”, “Edit”. Each becomes a chunk on the calendar. Or leave empty and let AI split by 1-hour.</div>
                <button type="button" onClick={addPart} className="mt-4 cursor-pointer rounded-[3px] bg-ink px-5 py-2 text-13 font-medium text-canvas hover:bg-accent">Add first part</button>
              </div>
            ) : (
              <div className="flex max-h-[32vh] flex-col gap-3 overflow-y-auto px-6 py-4">
                {parts.map((p, idx) => (
                  <div key={p.id} className="rounded-[3px] border border-line-block bg-card px-4 py-4">
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Part {idx + 1}</div>
                      <button type="button" onClick={() => removePart(p.id)} className="cursor-pointer font-mono text-13 text-grey-ghost hover:text-ink">× Remove</button>
                    </div>
                    <div className="mt-3">
                      <input value={p.name} onChange={(e) => updatePart(p.id, { name: e.target.value })} placeholder={`Part ${idx + 1} name — e.g. ${idx === 0 ? "Research" : idx === 1 ? "Draft" : "Edit"}`} className={`${UNDERLINE_INPUT} text-15 placeholder:text-grey-faint`} />
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {[30, 45, 60, 90, 120].map((d) => (
                        <button key={d} type="button" onClick={() => updatePart(p.id, { duration: d })} className={`cursor-pointer rounded-[3px] border px-3 py-1.5 text-13 transition-colors ${p.duration === d ? "border-ink bg-ink text-canvas" : "border-line-strong text-ink-muted hover:border-ink hover:text-ink"}`}>
                          {d >= 60 ? `${d / 60}h` : `${d}m`}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line-panel px-[34px] pb-[30px] pt-[22px]">
          <div className="font-mono text-label leading-[1.5] text-grey">{ready ? (parts.length ? `${parts.length} parts · ${totalDuration}m` : "AI will chunk into 1-hour blocks") : !color ? "Pick a color to continue" : "Name and due date required"}</div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="cursor-pointer rounded-[3px] border border-line-strong bg-transparent px-[18px] py-[11px] font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">Cancel</button>
            <button
              type="button"
              onClick={() => {
                if (!ready || !color) return;
                onSave({ name: name.trim(), course: course.trim() || undefined, deadline, estimatedDuration: totalDuration || 60, priority, color, parts });
                onClose();
              }}
              className={`cursor-pointer rounded-[3px] px-[26px] py-[13px] text-14 font-medium transition-colors ${ready ? "bg-ink text-canvas hover:bg-accent" : "bg-line-strong text-grey-mid cursor-not-allowed"}`}
            >
              {editing ? "Update" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
