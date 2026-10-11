/** Types for shared/agentCore.mjs (the parts the Android app uses). */
export type Viewport = { width: number; height: number };
export type AgentDeps = {
  callModel: (body: unknown) => Promise<unknown>;
  screenshot: () => Promise<{ dataUrl: string; width: number; height: number }>;
  navigate: (url: string) => Promise<void>;
  history: (dir: "back" | "forward") => Promise<void>;
  input: (step: InputStep) => Promise<void>;
  settle: (opts?: { minMs?: number; capMs?: number; afterType?: boolean; afterScroll?: boolean }) => Promise<void>;
  probe: () => Promise<Record<string, unknown>>;
  describePoint: (x: number, y: number) => Promise<Record<string, unknown> | null>;
  describeFocus: () => Promise<Record<string, unknown> | null>;
  pageText: () => Promise<string>;
  codeContext: () => Promise<Record<string, unknown> | null>;
  fillCode: (code: string, point: { x: number; y: number } | null) => Promise<{ ok: boolean; masked: boolean }>;
  emit: (e: Record<string, unknown> & { type: string }) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
export type InputStep =
  | { insertText: string }
  | { input: { type: string; x?: number; y?: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number; keyCode?: string; modifiers?: string[] } };
export class BookingRun {
  constructor(task: unknown, deps: AgentDeps, opts?: { limits?: Record<string, number>; viewport?: Viewport });
  task: { type: string; venue: string; date: string; time: string; holdBlockId?: string | null };
  state: string;
  start(): Promise<void>;
  answer(text: string): boolean;
  submitCode(text: string): Promise<{ ok: boolean; error?: string }>;
  confirm(yes: boolean): boolean;
  continueRun(): boolean;
  cancel(message?: string): boolean;
  trail(): Record<string, unknown>[];
}
export const OPENAI_RESPONSES_URL: string;
export const VIEWPORT: Viewport;
export function startUrlFor(task: unknown): string;
export function toInputSteps(action: unknown, scale: { x: number; y: number }, viewport?: Viewport): InputStep[];
export function isFinalClickTarget(target: unknown, contactTyped: boolean): boolean;
export function overlayHit(target: unknown, viewport?: Viewport): string | null;
export function isWatchedClick(target: unknown): boolean;
