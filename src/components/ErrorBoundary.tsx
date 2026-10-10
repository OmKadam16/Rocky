import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; error: string | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  static getDerivedStateFromError(e: unknown): State {
    return { hasError: true, error: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown, info: unknown) {
    console.error("[rocky] unhandled", e, info);
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-10 text-ink">
        <div className="max-w-[620px]">
          <h1 className="text-[30px] font-medium">Something broke</h1>
          <p className="mt-4 font-mono text-[12px] leading-[1.6] text-grey whitespace-pre-wrap break-words">{this.state.error}</p>
          <button onClick={() => location.reload()} className="mt-6 rounded-[3px] bg-ink px-5 py-2.5 text-[14px] font-medium text-canvas">Reload</button>
          <p className="mt-4 font-mono text-[11px] text-grey-soft">If this keeps happening, reload the page. Hosted builds need VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY set at build time.</p>
        </div>
      </div>
    );
  }
}
