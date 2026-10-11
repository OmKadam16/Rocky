import { motion } from "motion/react";
import { CalendarIcon, ChatIcon } from "../NavIcons";
import type { PhoneTab } from "../../lib/phoneTabs";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const TABS: { id: PhoneTab; label: string; Icon: typeof ChatIcon }[] = [
  { id: "chat", label: "Chat", Icon: ChatIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarIcon },
];

/** Bottom nav: Chat · Calendar, with the same sliding pill as the view tabs. */
export default function PhoneTabBar({ tab, onChange }: { tab: PhoneTab; onChange: (t: PhoneTab) => void }) {
  return (
    <nav className="flex-none border-t border-line bg-canvas px-5 pb-[calc(0.5rem+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] pt-2">
      <div role="tablist" aria-label="Rocky" className="grid grid-cols-2 gap-1 rounded-[3px] border border-line bg-card p-1">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`phone-tab-${id}`}
              aria-selected={active}
              aria-controls={`phone-panel-${id}`}
              onClick={() => onChange(id)}
              className={`relative flex h-11 cursor-pointer items-center justify-center gap-2 rounded-[3px] font-mono text-micro tracking-tab uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                active ? "text-canvas" : "text-grey-mid hover:text-ink"
              }`}
            >
              {active && <motion.span layoutId="phone-tab-pill" className="absolute inset-0 rounded-[3px] bg-ink" transition={{ duration: 0.22, ease: EASE }} />}
              <span className="relative flex items-center gap-2">
                {/* On the ink pill the icon's "ink" is the canvas colour. */}
                <span style={active ? ({ "--color-ink": "var(--color-canvas)" } as React.CSSProperties) : undefined}>
                  <Icon active={active} />
                </span>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
