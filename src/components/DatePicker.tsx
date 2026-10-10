import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(v: string): Date | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  align?: "left" | "right";
};

export default function DatePicker({ value, onChange, placeholder = "Select date", align = "left" }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const parsed = parseISO(value);
  const today = new Date();
  const todayISO = toISO(today);
  const initial = parsed ?? today;
  const [cursor, setCursor] = useState<Date>(initial);

  useEffect(() => {
    if (parsed) setCursor(parsed);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      const w = 300;
      let left = align === "right" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = r.bottom + 8;
      if (top + 360 > window.innerHeight) top = r.top - 360 - 8;
      if (top < 8) top = 8;
      setPos({ left, top });
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      const inWrap = wrapRef.current?.contains(t);
      const portalEl = document.getElementById("rk-datepicker-portal");
      const inPortal = portalEl?.contains(t);
      if (!inWrap && !inPortal) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, align]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells: { day: number; iso: string; muted: boolean; isToday: boolean; isSelected: boolean }[] = [];
  for (let i = 0; i < firstDay; i += 1) {
    const d = daysInPrev - firstDay + 1 + i;
    const date = new Date(year, month - 1, d);
    const iso = toISO(date);
    cells.push({ day: d, iso, muted: true, isToday: iso === todayISO, isSelected: iso === value });
  }
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = new Date(year, month, d);
    const iso = toISO(date);
    cells.push({ day: d, iso, muted: false, isToday: iso === todayISO, isSelected: iso === value });
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d += 1) {
    const date = new Date(year, month + 1, d);
    const iso = toISO(date);
    cells.push({ day: d, iso, muted: true, isToday: iso === todayISO, isSelected: iso === value });
  }

  const display = value ? (() => { const d = parseISO(value); if (!d) return ""; return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); })() : "";

  return (
    <div ref={wrapRef} className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between border-0 border-b border-line-strong bg-transparent pb-[9px] text-left font-mono text-lead text-ink outline-none transition-colors hover:border-ink focus:border-ink"
      >
        <span className={value ? "" : "text-grey-faint"}>{value ? display : placeholder}</span>
        <span className="ml-2 flex h-6 w-6 items-center justify-center rounded-[3px] border border-line-strong bg-card text-grey-mid">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            id="rk-datepicker-portal"
            style={{ position: "fixed", left: pos.left, top: pos.top, width: 300 }}
            className="z-[100] overflow-hidden rounded-[3px] border border-line-strong bg-panel shadow-xl animate-[vcin_0.2s_ease]"
          >
          <div className="flex items-center justify-between border-b border-line-panel bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <select
                value={month}
                onChange={(e) => setCursor(new Date(year, Number(e.target.value), 1))}
                className="cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-panel px-2 py-1 pr-6 font-mono text-13 text-ink outline-none hover:border-ink"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i}>{m}</option>
                ))}
              </select>
              <select
                value={year}
                onChange={(e) => setCursor(new Date(Number(e.target.value), month, 1))}
                className="cursor-pointer appearance-none rounded-[3px] border border-line-strong bg-panel px-2 py-1 pr-6 font-mono text-13 text-ink outline-none hover:border-ink"
              >
                {Array.from({ length: 20 }, (_, i) => year - 5 + i).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => setCursor(new Date(year, month - 1, 1))} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[3px] border border-line-strong bg-panel font-mono text-13 text-grey-mid hover:border-ink hover:text-ink">‹</button>
              <button type="button" onClick={() => setCursor(new Date(year, month + 1, 1))} className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[3px] border border-line-strong bg-panel font-mono text-13 text-grey-mid hover:border-ink hover:text-ink">›</button>
            </div>
          </div>

          <div className="px-3 pt-3">
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map((w) => (
                <div key={w} className="flex h-7 w-full items-center justify-center font-mono text-micro tracking-tab uppercase text-grey-faint">{w}</div>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1 pb-1">
              {cells.map((c) => (
                <button
                  key={c.iso}
                  type="button"
                  onClick={() => { onChange(c.iso); setOpen(false); }}
                  className={`flex h-[36px] w-full items-center justify-center rounded-[2px] font-mono text-13 transition-colors ${
                    c.isSelected ? "bg-ink text-canvas hover:bg-accent" : c.muted ? "text-grey-faint hover:bg-line-panel hover:text-ink" : c.isToday ? "border border-accent bg-accent-bg text-accent-dark hover:bg-accent-bg" : "text-ink hover:bg-line-panel"
                  }`}
                >
                  {c.day}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-line-panel bg-panel px-4 py-3">
            <button type="button" onClick={() => { onChange(""); setOpen(false); }} className="cursor-pointer font-mono text-13 text-accent hover:text-accent-deep">Clear</button>
            <button type="button" onClick={() => { onChange(todayISO); setCursor(today); setOpen(false); }} className="cursor-pointer font-mono text-13 text-accent hover:text-accent-deep">Today</button>
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
