function isDesktopBuild(): boolean {
  try {
    return Boolean((window as unknown as { rocky?: { isDesktop?: boolean } }).rocky?.isDesktop);
  } catch {
    return false;
  }
}

const SETUP_STEPS = [
  { id: "ollama", title: "Install Ollama", detail: "The runner Memory uses on this laptop.", status: "not started" },
  { id: "model", title: "Download model", detail: "Qwen 3.5 2B — about 2.7 GB.", status: "not started" },
  { id: "on", title: "Turn on", detail: "Start saving pages and screenshots locally.", status: "not started" },
] as const;

const EXCLUDED_DEFAULT = "banking\nemail\nhealth portals";

export default function MemoryPage() {
  const isDesktop = isDesktopBuild();

  return (
    <div className="flex min-w-0 flex-1 flex-col pb-10 pl-[60px] pr-14 pt-[52px]">
      <div className="font-mono text-label tracking-label uppercase text-grey">Memory</div>

      <div className="mt-10 flex items-start justify-between gap-8">
        <div className="max-w-[620px] flex-1">
          <h1 className="text-[42px] font-medium leading-[1.08] tracking-[-0.026em] [text-wrap:pretty]">
            What you read,
            <br />
            still on this laptop.
          </h1>
          <p className="mt-[18px] max-w-[500px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            Everything Memory saves stays on this laptop. Nothing is uploaded.
          </p>
          {!isDesktop && (
            <div className="mt-4 inline-flex rounded-[3px] border border-line bg-panel px-3 py-2 font-mono text-micro tracking-tab uppercase text-grey-mid">
              Memory needs the Rocky desktop app.
            </div>
          )}
        </div>
        <div className="flex flex-none flex-col items-end gap-2 self-start">
          <button
            type="button"
            disabled
            title="Available in the desktop app"
            className="cursor-not-allowed rounded-[3px] border border-line-strong px-[18px] py-[10px] font-mono text-micro tracking-tab uppercase text-grey-faint"
          >
            Recording · Paused
          </button>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Available in the desktop app</div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">What Memory does</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Off by default</div>
        </div>
        <div className="mt-[18px] rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
          <div className="text-[16px] font-medium text-ink-soft">Saves what you read, so you can ask about it later.</div>
          <p className="mt-2 max-w-[560px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            Memory saves the text of pages you read and periodic screenshots of your screen on this laptop,
            so you can ask “what was I reading on Wednesday?”. Off by default — nothing is saved until you turn it on.
          </p>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Setup</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">On this laptop</div>
        </div>
        <div className="mt-[18px] rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Local model</div>
          <div className="mt-2 text-[16px] font-medium text-ink-soft">Memory runs on a small AI model on this laptop: Qwen 3.5 2B (about 2.7 GB).</div>
          <div className="mt-4 flex flex-col gap-2">
            {SETUP_STEPS.map((step, i) => (
              <div key={step.id} className="flex items-center gap-4 rounded-[3px] border border-line bg-panel px-[15px] py-3">
                <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border border-line-strong font-mono text-micro text-grey-mid">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-14 font-medium text-ink-soft">{step.title}</div>
                  <div className="truncate font-mono text-meta text-grey">{step.detail}</div>
                </div>
                <span className="flex-none font-mono text-micro tracking-tab uppercase text-grey-faint">{step.status}</span>
                <button
                  type="button"
                  disabled
                  title="Coming next"
                  className="flex-none cursor-not-allowed rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-grey-faint"
                >
                  Coming next
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Ask Memory</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Disabled until setup</div>
        </div>
        <div className="mt-[18px] rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
          <div className="flex items-center gap-2 opacity-60">
            <input
              type="text"
              disabled
              placeholder="Ask what you were reading…"
              className="flex-1 cursor-not-allowed rounded-[3px] border border-line-strong bg-panel px-3 py-[9px] text-15 leading-[1.4] text-grey outline-none placeholder:text-grey-faint"
            />
            <button
              type="button"
              disabled
              title="Coming next"
              className="flex-none cursor-not-allowed rounded-[3px] bg-line-strong px-[14px] py-[9px] font-mono text-13 text-grey-mid"
            >
              Send
            </button>
            <button
              type="button"
              disabled
              title="Coming next"
              aria-label="Dictate (coming next)"
              className="flex h-[38px] w-[38px] flex-none cursor-not-allowed items-center justify-center rounded-full bg-line-strong text-grey-mid"
            >
              <span className="flex items-center gap-[2px]">
                <span className="h-[12px] w-[2px] rounded-[1px] bg-current" />
                <span className="h-[16px] w-[2px] rounded-[1px] bg-current" />
                <span className="h-[10px] w-[2px] rounded-[1px] bg-current" />
              </span>
            </button>
          </div>
          <div className="mt-2 font-mono text-[10.5px] text-grey-soft">Set up Memory to ask about what you read. Text and mic stay disabled for now.</div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Answer</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-ghost">Empty state</div>
        </div>
        <div className="mt-[18px] rounded-[3px] border border-line bg-card px-[19px] py-[17px]">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Answer</div>
          <div className="mt-2 text-15 leading-[1.55] text-grey">No answer yet — ask something above once Memory is on.</div>
        </div>
        <div className="mt-2 rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center">
          <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">No sources yet</div>
          <div className="mx-auto mt-2 max-w-[460px] font-mono text-meta leading-[1.5] text-grey">
            Sources will appear here with favicon, title, site, time, snippet, Open and Forget.
          </div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Timeline</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-ghost">Grouped by day</div>
        </div>
        <div className="mt-[18px] rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center">
          <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">No captures yet</div>
          <div className="mx-auto mt-2 max-w-[460px] font-mono text-meta leading-[1.5] text-grey">
            Days will group here once Memory is on. Nothing is saved yet.
          </div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className="flex items-baseline justify-between border-b border-line pb-3">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Privacy</div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Coming next</div>
        </div>
        <div className="mt-[18px] flex flex-col gap-2">
          <div className="rounded-[3px] border border-line bg-card px-[19px] py-[17px] opacity-80">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Excluded sites</div>
            <div className="mt-2 font-mono text-meta text-grey">Banking, message, and health sites are never saved.</div>
            <textarea
              disabled
              defaultValue={EXCLUDED_DEFAULT}
              rows={3}
              title="Coming next"
              className="mt-3 box-border w-full cursor-not-allowed resize-none rounded-[3px] border border-line-strong bg-panel px-[13px] py-[11px] font-mono text-[13px] leading-[1.6] text-grey outline-none"
            />
          </div>

          <div className="rounded-[3px] border border-line bg-card px-[19px] py-[17px] opacity-80">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Retention</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["7 days", "30 days", "90 days", "Forever"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled
                  title="Coming next"
                  className="cursor-not-allowed rounded-[3px] border border-line-strong px-[13px] py-[6px] font-mono text-[10px] tracking-[0.14em] uppercase text-grey-faint"
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-grey-soft">Choose how long Memory keeps captures. Disabled for now.</div>
          </div>

          <div className="rounded-[3px] border border-line bg-card px-[19px] py-[17px] opacity-80">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Forget</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["Forget last hour", "Forget today", "Forget all"] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled
                  title="Coming next"
                  className="cursor-not-allowed rounded-[3px] border border-line-strong px-[13px] py-[8px] font-mono text-[10px] tracking-[0.14em] uppercase text-grey-faint"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-grey-soft">Coming next — forgetting is a local delete.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
