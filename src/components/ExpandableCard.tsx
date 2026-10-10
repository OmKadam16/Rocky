import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

type Props = {
  /** Small mono label, e.g. "Model". */
  title: string;
  /** Current value shown in the summary row, e.g. "OpenAI — GPT-4o". */
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
};

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * One container for a summary row + its editor. Expanding animates height
 * in place (with a rotating chevron and `layout` so siblings slide instead
 * of jumping) so editing reads as continuation, not a new card popping in.
 */
export default function ExpandableCard({ title, value, open, onToggle, children }: Props) {
  return (
    <motion.div
      layout
      className="card overflow-hidden"
      animate={{ borderColor: open ? "var(--color-line-strong)" : "var(--color-line)" }}
      transition={{ duration: 0.25, ease: EASE }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-5 px-[19px] py-[17px] text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">{title}</div>
          <div className="mt-2 truncate text-[16px] font-medium">{value}</div>
        </div>
        <span
          aria-hidden
          className="flex-none font-mono text-13 text-grey-mid transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▾
        </span>
        <span className="flex-none font-mono text-[10px] tracking-[0.14em] uppercase text-grey">
          {open ? "Done" : "Change"}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="editor"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <div className="flex flex-col gap-[22px] border-t border-line px-[19px] py-[19px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
