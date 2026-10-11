import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantState, AssistantTurn } from "../types";
import { askPlanner } from "../lib/planner";
import { createBargeInAnalyser, ensureAudioUnlocked, speak, startRecognition, stopSpeaking } from "../lib/speech";

export const DEFAULT_SILENCE_MS = 1200;
export const SILENCE_STORAGE_KEY = "vc-silence-ms";

export function getSilenceMs(): number {
  try {
    const raw = localStorage.getItem(SILENCE_STORAGE_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 500 && n <= 5000) return Math.round(n);
  } catch {}
  return DEFAULT_SILENCE_MS;
}

/** Per-turn latency breakdown for the hidden debug readout. */
export type AssistantTiming = {
  plannerMs: number;
  snapshotMs: number;
  llmMs: number;
  toolMs: number;
  rounds: number;
  ttsMs: number;
  sendMs: number;
  spoken: boolean;
};

export type SendOpts = {
  /**
   * False for typed sends: the reply shows as text and the turn goes idle
   * immediately instead of waiting on speech synthesis + playback. Voice
   * turns (mic, confirm buttons, conversation mode) leave it true.
   */
  speak?: boolean;
};

let turnId = 0;
const nextId = () => `turn-${(turnId += 1)}`;

/**
 * Things people say while thinking. Acting on these is what makes an assistant
 * feel like it is talking over you, so we let the turn keep running instead.
 */
const FILLER = /^(uh+|um+|hmm+|erm?|ah+|like|so|well|okay|ok|yeah|yep|right|mhm)[\s.,!?]*$/i;

/**
 * Confirmations must always reach the planner — "yes" after "say yes or tap
 * Confirm" is the whole booking/delete gate, and the filler rule below eats
 * single short words. The planner decides from history what "ok" means.
 */
const CONFIRM_WORD = /^(yes|yeah|yep|yup|no|nope|sure|okay|ok|cancel|confirm|confirmed|stop|go ahead|do it)\s*[.!?]*$/i;

function isFiller(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (CONFIRM_WORD.test(trimmed)) return false;
  if (FILLER.test(trimmed)) return true;
  // A single stray word is almost always a misfire, not a request.
  return trimmed.split(/\s+/).length < 2 && trimmed.length < 4;
}

export function useAssistant(onScheduleChange: () => void) {
  const [state, setState] = useState<AssistantState>("idle");
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [caption, setCaption] = useState("");
  // Desktop transcription has no interim text, so the UI shows mic level instead.
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isConversation, setIsConversation] = useState(false);
  const [lastTiming, setLastTiming] = useState<AssistantTiming | null>(null);

  const stopListening = useRef<(() => void) | null>(null);
  const turnsRef = useRef<AssistantTurn[]>([]);
  const isConversationRef = useRef(false);

  const push = useCallback((turn: Omit<AssistantTurn, "id">) => {
    const full = { ...turn, id: nextId() };
    turnsRef.current = [...turnsRef.current, full];
    setTurns(turnsRef.current);
    return full;
  }, []);

  const send = useCallback(
    async (text: string, opts?: SendOpts) => {
      const speakReply = opts?.speak !== false;
      const tSend = Date.now();
      push({ role: "user", text });
      setCaption("");
      setState("thinking");
      setError(null);

      try {
        let response;
        try {
          response = await askPlanner(text, turnsRef.current.slice(0, -1));
        } catch (failure) {
          if ((failure as Error)?.name === "AbortError") {
            setCaption("");
            return;
          }
          const message = failure instanceof Error ? failure.message : String(failure);
          setError(message);
          push({ role: "assistant", text: `I couldn't reach the planner — ${message}` });
          return;
        }
        // Planner succeeded — the text reply stays visible even if voice fails.
        push({ role: "assistant", text: response.reply });
        if (response.schedule_changed) onScheduleChange();
        const base: AssistantTiming = {
          plannerMs: response.timing.totalMs,
          snapshotMs: response.timing.snapshotMs,
          llmMs: response.timing.llmMs,
          toolMs: response.timing.toolMs,
          rounds: response.timing.rounds,
          ttsMs: 0,
          sendMs: Date.now() - tSend,
          spoken: speakReply,
        };
        setLastTiming(base);
        try {
          console.debug(`[rocky] turn ${base.sendMs}ms (planner ${base.plannerMs}: snap ${base.snapshotMs} + llm ${base.llmMs} in ${base.rounds} rounds + tools ${base.toolMs}) spoken=${speakReply}`);
        } catch {}
        // Typed sends end here: text is up, calendar refreshed, turn idle.
        // Speaking every typed reply made texting feel as slow as voice.
        if (!speakReply) return;

        setState("speaking");
        const controller = new AbortController();
        let stopBarge: (() => void) | null = null;
        // Only listen for interruptions in hands-free mode; otherwise the mic
        // button is the way to cut in, and an open mic just risks false trips.
        if (isConversationRef.current) {
          stopBarge = createBargeInAnalyser(() => {
            controller.abort();
            stopSpeaking();
          });
        }
        try {
          await speak(response.reply, { signal: controller.signal });
          setLastTiming((t) => (t ? { ...t, ttsMs: Date.now() - tSend - t.plannerMs, sendMs: Date.now() - tSend } : t));
        } catch (speakFailure) {
          if ((speakFailure as Error)?.name === "AbortError") {
            setCaption("");
          } else {
            // Never fail silently: keep the text reply, show the voice error.
            const message = speakFailure instanceof Error ? speakFailure.message : String(speakFailure);
            setError(message);
          }
        } finally {
          stopBarge?.();
        }
      } finally {
        setState("idle");
      }
    },
    [onScheduleChange, push],
  );

  /**
   * One listening turn. End-of-turn detection lives in startRecognition, which
   * waits out real pauses instead of finalising at the first breath.
   */
  const listen = useCallback(
    (mode: "tap" | "conversation") => {
      // Mobile unlock: first mic tap prepares audio so replies can play.
      void ensureAudioUnlocked();
      setError(null);
      setCaption("");
      setLevel(0);
      setState("listening");
      stopSpeaking();

      const silenceMs = getSilenceMs();
      const stop = startRecognition(
        {
          onPartial: setCaption,
          onLevel: setLevel,
          onFinal: (text) => {
            if (isFiller(text)) {
              // Nothing worth acting on — stay quiet and let them try again.
              setCaption("");
              return;
            }
            void send(text.trim());
          },
          onError: (message) => {
            setError(message);
            setState("idle");
          },
          onEnd: () => {
            stopListening.current = null;
            setState((current) => (current === "listening" ? "idle" : current));
          },
        },
        mode === "conversation"
          ? { silenceMs, settledSilenceMs: Math.max(800, silenceMs - 100), openingMs: 8000 }
          : // Tap-to-talk: pauses never end the turn — only the next tap does.
            // Opening timeout and hard cap still apply as safety nets.
            { silenceMs, settledSilenceMs: Math.max(800, silenceMs - 100), openingMs: 20000, manualStop: true },
      );

      if (!stop) {
        setState("idle");
        if (mode === "conversation") {
          isConversationRef.current = false;
          setIsConversation(false);
        }
        return;
      }
      stopListening.current = stop;
    },
    [send],
  );

  const endTurn = useCallback(() => {
    stopListening.current?.();
    stopListening.current = null;
  }, []);

  const stopConversation = useCallback(() => {
    isConversationRef.current = false;
    setIsConversation(false);
    endTurn();
    stopSpeaking();
    setState("idle");
    setCaption("");
  }, [endTurn]);

  const startConversation = useCallback(() => {
    isConversationRef.current = true;
    setIsConversation(true);
    listen("conversation");
  }, [listen]);

  // Hands-free: after the assistant finishes speaking, open the mic again.
  useEffect(() => {
    if (!isConversationRef.current || state !== "idle") return;
    const t = setTimeout(() => {
      if (isConversationRef.current) listen("conversation");
    }, 450);
    return () => clearTimeout(t);
  }, [state, isConversation, listen]);

  const toggleConversation = useCallback(() => {
    if (isConversationRef.current) {
      stopConversation();
      return;
    }
    if (state === "thinking") return;
    stopSpeaking();
    startConversation();
  }, [state, startConversation, stopConversation]);

  /** Mic button: start a turn, end a turn early, or interrupt playback. */
  const toggle = useCallback(() => {
    if (isConversationRef.current) {
      stopConversation();
      return;
    }
    if (state === "listening") {
      // Not a cancel — finish the turn now with whatever was said.
      endTurn();
      return;
    }
    if (state === "speaking") {
      stopSpeaking();
      setState("idle");
      return;
    }
    if (state === "thinking") return;
    listen("tap");
  }, [state, listen, endTurn, stopConversation]);

  return {
    state,
    turns,
    caption,
    level,
    error,
    lastTiming,
    toggle,
    toggleConversation,
    isConversation,
    send,
    startConversation,
    stopConversation,
  };
}
