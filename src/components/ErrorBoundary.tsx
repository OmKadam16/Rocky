import { Component, type ReactNode } from "react";
import { bootError, bootReady, errorText } from "../lib/boot";

type Props = { children: ReactNode };
type State = { hasError: boolean; error: string | null };

/** Root boundary: a render crash shows the error (and the version), never a white screen. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };
  static getDerivedStateFromError(e: unknown): State {
    return { hasError: true, error: errorText(e) };
  }
  componentDidCatch(e: unknown, info: unknown) {
    console.error("[rocky:boot] render crashed", e, info);
    bootError(e);
    // This screen already shows the error; the startup watchdog stands down.
    bootReady();
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink sm:p-10">
        <div className="w-full max-w-[620px]">
          <h1 className="text-[28px] font-medium">Something broke</h1>
          <p className="mt-4 max-h-[40vh] overflow-auto font-mono text-[12px] leading-[1.6] text-grey whitespace-pre-wrap break-words">{this.state.error}</p>
          <button onClick={() => location.reload()} className="mt-6 cursor-pointer rounded-[3px] bg-ink px-5 py-2.5 text-[14px] font-medium text-canvas">Retry</button>
          <p className="mt-4 font-mono text-[11px] text-grey-soft">Rocky {__APP_VERSION__}. Hosted builds need VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY set at build time.</p>
        </div>
      </div>
    );
  }
}
