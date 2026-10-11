import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantState, AssistantTurn } from "../types";
import { askPlanner } from "../lib/planner";
import { createBargeInAnalyser, ensureAudioUnlocked, speak, startRecognition, stopSpeaking } from "../lib/speech";
import { answerAgent, cancelAgent, confirmAgent, continueAgent, getAgentView, isAgentActive, onFillerCancel, setProgressBusy, submitAgentCode, subscribeAgent } from "../lib/agentClient";
import { loadProgressSpeech, progressSpeechOn } from "../lib/progressSetting";
import { isContinue, isExplicitNo, isExplicitYes, isStop } from "../lib/bookingTask";
import { clearChat as clearStoredChat, loadChat, saveTurn } from "../lib/chatHistory";
import { commitmentCardFromTools, pendingProposalId } from "../lib/chatCards";
import { cancelProposal, commitmentReply, confirmProposal, receiptText } from "../lib/commitmentProposals";
import { beginCapture, endCapture, registerUndo, runUndo } from "../lib/undoJournal";
import { isMemoryQuestion, memoryCardFor, takeMemoryCard } from "../lib/memoryIntent";

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

/** What the chat shows (and the planner's history holds) instead of a code. */
export const CODE_PLACEHOLDER = "•••• (verification code)";

let turnId = 0;
// Unique across sessions: the persisted chat keys on it.
const SESSION = Date.now().toString(36);
const nextId = () => `turn-${SESSION}-${(turnId += 1)}`;

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
const CONFIRM_WORD = /^(yes|yeah|yep|yup|no|nope|sure|okay|ok|cancel|confirm|confirmed|stop|go ahead|do it|continue|done)\s*[.!?]*$/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** The mic picked up Rocky's own progress line, not the user. */
export function isEchoOf(text: string, recent: string[]): boolean {
  const t = norm(text);
  // Control words always get through ("say stop any time" -> the user says stop).
  if (!t || t.split(" ").length < 2 || isStop(text) || CONFIRM_WORD.test(text.trim())) return false;
  return recent.some((r) => {
    const f = norm(r);
    return f.includes(t) || (t.includes(f) && t.length - f.length < 6);
  });
}

function isFiller(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (CONFIRM_WORD.test(trimmed)) return false;
  if (FILLER.test(trimmed)) return true;
  // A single stray word is almost always a misfire, not a request.
  return trimmed.split(/\s+/).length < 2 && trimmed.length < 4;
}

/**
 * Booking agent control words, handled in code before the planner sees them.
 * The final-click yes must come from the user, never from the planner model,
 * so a pending confirmation is answered here directly. Returns the reply to
 * show/speak, or null to let the planner take the turn.
 */
export async function agentFastPath(text: string): Promise<string | null> {
  const v = getAgentView();
  if (v.phase === "code") {
    // The site's one-time code. It goes straight to the agent and nowhere
    // else: this branch never returns null for anything but stop, so the
    // turn can never fall through to the planner.
    if (isStop(text)) {
      await cancelAgent();
      return null;
    }
    const r = await submitAgentCode(text);
    if (r.ok) return "Got it, entering the code.";
    switch (r.error) {
      case "format":
        return "I need the 4 to 8 digit code from the message. What is it?";
      case "laptop_only":
        return "Codes don't go through the phone link. Say it to Rocky on your laptop, or type it into the agent window.";
      case "handoff":
      case "no_field":
        return "Please enter the code in the agent window, then say continue.";
      default:
        return "That code request has closed.";
    }
  }
  if (v.phase === "confirm") {
    if (isExplicitYes(text)) return (await confirmAgent(true)) ? "Booking it now." : "That confirmation already closed.";
    if (isExplicitNo(text) || isStop(text)) {
      await confirmAgent(false);
      return null; // the agent announces the cancel itself
    }
    return "Say yes to book it, or no to stop.";
  }
  if (v.phase === "question") {
    // The agent asked; this is the answer. Verbatim, straight to the agent,
    // no planner round trip.
    if (isStop(text)) {
      await cancelAgent();
      return null;
    }
    return (await answerAgent(text)) ? "Got it." : null;
  }
  if (v.phase === "takeover") {
    if (isContinue(text) || isExplicitYes(text)) return (await continueAgent()) ? "Carrying on." : null;
    if (isStop(text) || isExplicitNo(text)) {
      await cancelAgent();
      return null;
    }
  }
  if (isAgentActive() && isStop(text)) {
    await cancelAgent();
    return null;
  }
  return null;
}

/**
 * Who takes this turn while the agent runs: the agent (fast path, with an
 * optional reply of ours) or the planner. A turn that starts while the
 * site's code is pending never goes to the planner, whatever happens.
 */
export async function routeAgentTurn(text: string): Promise<{ planner: boolean; reply: string | null }> {
  if (!isAgentActive()) return { planner: true, reply: null };
  const v = getAgentView().phase;
  const reply = await agentFastPath(text);
  if (reply) return { planner: false, reply };
  if (v === "code") return { planner: false, reply: null };
  // Handled with no reply of our own: the agent's own announcement follows.
  if (v === "confirm" || (v === "takeover" && (isStop(text) || isExplicitNo(text))) || isStop(text)) return { planner: false, reply: null };
  return { planner: true, reply: null };
}

export type AssistantOptions = {
  /** Keep the chat in local history (Dashboard chat). Off for the phone and side panel. */
  persist?: boolean;
};

export function useAssistant(onScheduleChange: () => void, options: AssistantOptions = {}) {
  const persist = options.persist === true;
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
    const full: AssistantTurn = { ...turn, id: nextId(), at: Date.now() };
    turnsRef.current = [...turnsRef.current, full];
    setTurns(turnsRef.current);
    if (persist) void saveTurn(full);
    return full;
  }, [persist]);

  // Persisted chat: earlier turns come back on load (oldest first).
  useEffect(() => {
    if (!persist) return;
    let live = true;
    void loadChat().then((saved) => {
      if (!live || !saved.length) return;
      const ids = new Set(turnsRef.current.map((t) => t.id));
      turnsRef.current = [...saved.filter((t) => !ids.has(t.id)), ...turnsRef.current];
      setTurns(turnsRef.current);
    });
    return () => {
      live = false;
    };
  }, [persist]);

  const clearChat = useCallback(async () => {
    turnsRef.current = [];
    setTurns([]);
    if (persist) await clearStoredChat();
  }, [persist]);

  /** The only way a chat commitment gets written: the card's Confirm or the user's own yes. */
  const confirmCommitment = useCallback(
    async (id: string): Promise<string> => {
      const r = await confirmProposal(id);
      if (!r.ok) return r.error ?? "That didn't save.";
      if (r.already || !r.proposal) return "Already saved.";
      const undoId = r.undo ? registerUndo(r.undo) : null;
      push({ role: "assistant", text: "", private: true, card: { kind: "receipt", text: receiptText(r.proposal), undoId } });
      onScheduleChange();
      return r.proposal.op === "delete" ? "Removed." : "Saved.";
    },
    [push, onScheduleChange],
  );
  const cancelCommitment = useCallback((id: string) => cancelProposal(id), []);
  const undo = useCallback(
    async (undoId: string) => {
      const ok = await runUndo(undoId);
      if (ok) onScheduleChange();
      return ok;
    },
    [onScheduleChange],
  );

  const send = useCallback(
    async (text: string, opts?: SendOpts) => {
      const speakReply = opts?.speak !== false;
      const tSend = Date.now();
      // While the site's code is pending, the code never lands in the chat
      // (or the planner's history, which is built from these turns).
      // Memory questions are decided in code and never reach the cloud planner.
      const memoryQ = !isAgentActive() && isMemoryQuestion(text);
      const userTurn = push({ role: "user", text: getAgentView().phase === "code" ? CODE_PLACEHOLDER : text, ...(memoryQ ? { private: true } : {}) });
      setCaption("");
      setState("thinking");
      setError(null);

      try {
        const routed = await routeAgentTurn(text);
        if (!routed.planner) {
          if (routed.reply) {
            push({ role: "assistant", text: routed.reply });
            if (speakReply) {
              setState("speaking");
              await speak(routed.reply).catch(() => {});
            }
          }
          return;
        }
        if (memoryQ) {
          const card = await memoryCardFor(text);
          push({ role: "assistant", text: "", private: true, card });
          // Spoken: the short answer only, never the source list.
          if (speakReply) {
            setState("speaking");
            await speak(card.answer).catch(() => {});
          }
          return;
        }
        // A yes / no to the commitment card on screen is handled here, in code:
        // the planner can never write a commitment.
        const reply = commitmentReply(text, pendingProposalId(turnsRef.current.slice(0, -1)));
        if (reply) {
          const line = reply.action === "confirm" ? await confirmCommitment(reply.id) : (cancelProposal(reply.id), "Cancelled — nothing saved.");
          push({ role: "assistant", text: line });
          if (speakReply) {
            setState("speaking");
            await speak(line).catch(() => {});
          }
          return;
        }
        let response;
        beginCapture();
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
          await endCapture();
          return;
        }
        // Planner succeeded — the text reply stays visible even if voice fails.
        const card = commitmentCardFromTools(response.tools_used);
        const memoryCard = takeMemoryCard();
        if (memoryCard) {
          // The planner routed it to Memory: show the local answer, privately,
          // and keep the question out of the planner's history from now on.
          turnsRef.current = turnsRef.current.map((t) => (t.id === userTurn.id ? { ...t, private: true } : t));
          if (persist) void saveTurn({ ...userTurn, private: true });
          push({ role: "assistant", text: "", private: true, card: memoryCard });
          await endCapture();
          if (speakReply) {
            setState("speaking");
            await speak(memoryCard.answer).catch(() => {});
          }
          return;
        }
        push({ role: "assistant", text: response.reply, ...(card ? { card } : {}) });
        const receipt = await endCapture();
        if (receipt) push({ role: "assistant", text: "", private: true, card: { kind: "receipt", text: receipt.text, undoId: receipt.undoId } });
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
    [onScheduleChange, push, confirmCommitment],
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
            const recent = recentFillers.current.filter((f) => Date.now() - f.at < 15000).map((f) => f.text);
            if (isFiller(text) || isEchoOf(text, recent)) {
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

  const announceQueue = useRef<string[]>([]);
  const lastSeq = useRef(getAgentView().seq);
  const lastProgressSeq = useRef(getAgentView().progressSeq);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(level);
  levelRef.current = level;
  const captionRef = useRef(caption);
  captionRef.current = caption;

  // ---- spoken progress fillers ------------------------------------------
  // Fillers never take the turn: no chat bubble, state stays as it is, and
  // anything real (an announcement, the user's voice, a mic tap) cuts them.
  const filler = useRef<{ abort: AbortController; stopBarge: (() => void) | null } | null>(null);
  /** Recent filler lines, so an open mic hearing Rocky isn't taken as the user. */
  const recentFillers = useRef<{ text: string; at: number }[]>([]);
  const stopFiller = useCallback(() => {
    const f = filler.current;
    if (!f) return;
    filler.current = null;
    f.abort.abort();
    f.stopBarge?.();
    stopSpeaking();
  }, []);
  const speakFiller = useCallback(
    async (text: string) => {
      if (filler.current || !progressSpeechOn()) return;
      const s = stateRef.current;
      // Real speech, thinking, or the user mid-sentence: drop it, never queue.
      if (s === "speaking" || s === "thinking") return;
      if (s === "listening" && (captionRef.current || levelRef.current > 0.12)) return;
      const abort = new AbortController();
      // Barge-in: with the mic closed, watch for the user starting to talk.
      const stopBarge = s === "listening" ? null : createBargeInAnalyser(() => stopFiller());
      filler.current = { abort, stopBarge };
      recentFillers.current = [...recentFillers.current.filter((f) => Date.now() - f.at < 15000), { text, at: Date.now() }];
      try {
        await speak(text, { signal: abort.signal });
      } catch {
        /* a filler failing is never worth an error */
      } finally {
        if (filler.current?.abort === abort) {
          filler.current = null;
          stopBarge?.();
        }
      }
    },
    [stopFiller],
  );
  // An open mic (hands-free) that hears the user stops a playing filler.
  useEffect(() => {
    if (filler.current && state === "listening" && level > 0.25) stopFiller();
  }, [level, state, stopFiller]);
  useEffect(() => {
    void loadProgressSpeech();
    setProgressBusy(() => {
      const s = stateRef.current;
      if (s === "speaking" || s === "thinking") return true;
      if (s === "listening" && (captionRef.current || levelRef.current > 0.12)) return true;
      return Boolean(filler.current);
    });
    const off = onFillerCancel(stopFiller);
    return () => {
      off();
      setProgressBusy(() => false);
      stopFiller();
    };
  }, [stopFiller]);
  const flushAnnouncements = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    const next = announceQueue.current.shift();
    if (!next) return;
    push({ role: "assistant", text: next });
    setState("speaking");
    try {
      await speak(next);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally {
      setState("idle");
    }
  }, [push]);
  useEffect(
    () =>
      subscribeAgent((v) => {
        const here = !(v.origin === "phone" && !v.remote);
        if (v.progressSeq !== lastProgressSeq.current) {
          lastProgressSeq.current = v.progressSeq;
          // Same rule as announcements: the device the user talks to speaks.
          if (v.progress && here && ["running", "starting"].includes(v.phase)) void speakFiller(v.progress);
        }
        if (v.seq === lastSeq.current) return;
        lastSeq.current = v.seq;
        stopFiller();
        // A run the phone started is spoken on the phone; the laptop just shows it.
        if (v.announce && here) announceQueue.current.push(v.announce);
        if (["done", "failed", "cancelled"].includes(v.phase)) onScheduleChange();
        void flushAnnouncements();
      }),
    [flushAnnouncements, onScheduleChange, speakFiller, stopFiller],
  );
  useEffect(() => {
    if (state === "idle" && announceQueue.current.length) void flushAnnouncements();
  }, [state, flushAnnouncements]);

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
    pushTurn: push,
    clearChat,
    confirmCommitment,
    cancelCommitment,
    undo,
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
