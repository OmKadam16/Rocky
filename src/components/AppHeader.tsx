type Props = {
  dateLabel: string;
  onPrev?: () => void;
  onNext?: () => void;
  onToday?: () => void;
  showToday?: boolean;
  todayLabel?: string;
};

export default function AppHeader({ dateLabel, onPrev, onNext, onToday, showToday, todayLabel }: Props) {
  return (
    <div className="flex items-center gap-[18px]">
      <div className="font-mono text-label tracking-label uppercase text-grey">{dateLabel}</div>
      {onPrev && onNext && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-label text-grey-mid transition-colors hover:border-ink hover:text-ink"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={onNext}
            className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-label text-grey-mid transition-colors hover:border-ink hover:text-ink"
          >
            ›
          </button>
        </div>
      )}
      {showToday && onToday && (
        <button
          type="button"
          onClick={onToday}
          className="font-mono text-meta tracking-tab uppercase text-accent transition-colors hover:text-ink"
        >
          {todayLabel ?? "Today"}
        </button>
      )}
    </div>
  );
}
