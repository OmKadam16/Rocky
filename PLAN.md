# Rocky: build plan

Last updated: 2026-10-10. Owner: Om Kadam. Builder: OpenCode. Auditor: Claude (when available).

Rocky is a voice-first student planner. You talk, it plans your week around your fixed
commitments, and the calendar updates live on the laptop and the phone. An optional
**Memory** feature runs a small local model on the laptop. Built for a 2-day hackathon.

Read `AGENTS.md` for the working rules before you change anything.

---

## 1. Where things are

| Thing | Where |
|---|---|
| Code (the only working copy) | `C:\Rocky` on Om's laptop, branch `main` |
| GitHub | `OmKadam16/Rocky` (all work goes to `main`) |
| Old history backup | `OmKadam16/Rocky-demo` (v1 app, read-only) |
| Old prototype | `OmKadam16/Rocky-Planner` (ignore, copy nothing) |
| Database / accounts | Supabase project "Rocky2.0" (URL and publishable key in `.env.local`, never committed) |
| Hosting (planned) | Render static site, from `render.yaml` |

`.env.local` (not in git):
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...   (the publishable sb_publishable_... key, never the service-role key)
```

## 2. Stack

- Vite 8, React 19, TypeScript, Tailwind v4. Electron wrapper in `electron/` (main.cjs, preload.cjs).
- Supabase: auth (email + password, PKCE), Postgres with RLS "own rows only", Realtime.
- `src/lib/supaDb.ts`: a Dexie-compatible facade over Supabase. Known fields go to columns,
  anything else goes to the `extra` jsonb column. When signed out or not configured, the app
  falls back to local Dexie (`src/lib/db.ts`).
- AI while building: **OpenAI** (planner, `src/lib/plannerLocal.ts` + `plannerTools.ts`) and
  **ElevenLabs** (Scribe speech-to-text, text-to-speech). Keys are entered by the user in
  onboarding and stored **only on the device** (localStorage per user, or the Electron keychain).
- AI for the demo: **Gemini Live** (phase 5, last).
- Memory: **Ollama** on the laptop with `qwen3.5:2b` (`src/lib/ollama.ts`).

## 3. Data model (contract, do not change without telling Om)

Migrations in `supabase/migrations/`, tested by `supabase/tests/migrations.test.ts`.

- `0001_rocky_schema.sql`: `profiles`, `preferences` (one row per user), `fixed_commitments`,
  `tasks`, `scheduled_blocks` (PK `user_id + id`, text ids), `handle_new_user` trigger, RLS,
  realtime publication.
- `0002_devices_commands.sql`: `devices`, `commands`, `claim_pair` RPC (SECURITY DEFINER),
  `voice-clips` storage bucket.
- `0003_claim_pair_static.sql`: `claim_pair` keeps the laptop row's code on success —
  one static code per user. Apply to the live project by hand (SQL editor).
- `0004_devices_pair_code_8.sql`: pair codes are 8 Crockford chars (`XXXX-XXXX`;
  legacy 6-char rows still accepted). Apply to the live project by hand (SQL editor).

Rules:
- Fixed commitments never move. Only flexible tasks/blocks get rescheduled.
- API keys (`llm_key_enc`, `el_key_enc`, `browser_key_enc`) sync per user through the
  profile row's `extra` column (one key for all of a user's devices; RLS "own rows only"
  scopes them). `llm_key` drives the planner, `browser_key` drives the Booking Agent
  (read only by the Electron main process, sent only to api.openai.com; the planner never
  reads it), `el_key` is ElevenLabs only.
  Claiming still needs the account's own session, so a leaked code alone grants nothing.
  Leak response: hidden 5-tap rotate panel in Profile → Devices (rotate code, wipe keys
  everywhere + revoke at the provider dashboards).
- Any schema change = a new numbered migration + a test in `migrations.test.ts` + a note here.

## 4. Status

### Done
- [x] Accounts: sign up, sign in, forgot/reset password. `AuthGate` re-checks the session with the
      server on startup and on focus (a deleted user is signed out).
- [x] All data in Supabase, synced live between devices (Realtime).
- [x] Onboarding: sign up → name → keys (AI provider + ElevenLabs, both tested; optional Memory
      model with one-click download) → your day (text, voice or photos, analyzed into
      commitments) → commitments → dashboard. Resumes where you left off.
- [x] Emails feature fully removed.
- [x] Phone remote: laptop shows one static 8-char code (XXXX-XXXX, no QR) in Profile → Devices;
      phone opens `/remote`, signs in, enters the code, sees the calendar, talks to Rocky with the
      account's shared keys (phone keys card removed). Visible Rotate code disconnects the
      phone (it must enter the new code); hidden 5-tap panel still holds key wipe.
- [x] Memory page UI (`src/pages/MemoryPage.tsx`), model check/download via Ollama.
- [x] Everything consolidated into `OmKadam16/Rocky` main. `tsc`, 42 tests and build pass.

### Om to do by hand (GitHub settings, agents cannot)
- [ ] Settings → General → default branch = `main`.
- [ ] Close PR #1, delete branch `feat/phone-remote`.
- [ ] Optional: make the repo private.

---

## 5. Phases (do them in order, one at a time)

Each phase ends with: checks pass (section 7), commit + push to `main`, a short report to Om
(what changed, how to test it, anything not done).

### Phase 1: Deploy + real phone test
Goal: the phone works over HTTPS (mic and camera need HTTPS).
1. Om creates a Render static site from the repo (`render.yaml`), sets `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY` in Render.
2. In Supabase → Auth → URL configuration: add the Render URL as Site URL and redirect URL
   (keep `http://localhost:8080`).
3. Pairing is code-only (no QR): the laptop shows its static 8-char code in
   Profile → Devices; the phone enters it at `/remote`. Rotating the code on
   the laptop disconnects the phone until it enters the new one.
4. Test on a real Android phone: open `/remote`, pair with the laptop code, see the calendar,
   say "add gym tomorrow at 7pm", see it appear on the laptop within a few seconds.
5. Fix anything that breaks. Note phone model + browser in the report.

Done when: the full pair → talk → laptop updates loop works on a real phone.

### Phase 2: Polish the core loop
1. Voice: mic button, transcription (ElevenLabs Scribe), planner reply, spoken answer
   (ElevenLabs TTS, system voice fallback). Show clear states: listening, thinking, speaking, error.
2. Planner edge cases: conflicts with fixed commitments, "move my essay to Friday",
   "what's my day look like", deleting, recurring commitments. The planner never moves fixed items.
3. Error messages people understand (bad key, no internet, Supabase down). No raw stack traces.
4. Empty states for a brand new account.
5. Log latency (speech-to-text ms, planner ms, total ms) in a small debug panel (hidden by default).

### Phase 3: Memory (local, optional)
Goal: Rocky can answer "what did I read about X" from things the user saved, without
anything leaving the laptop.
1. User turns Memory on in onboarding or the Memory page; app checks Ollama is running and
   `qwen3.5:2b` is installed (download button if not).
2. Saving: user can paste text / drop a file / add a note on the Memory page. Store it
   **locally** (IndexedDB via Dexie, a new local-only table). **Never upload Memory content to Supabase.**
3. Search: simple keyword + recency search locally, then send the top few snippets to
   `qwen3.5:2b` (`think: false`, temperature 0.1) to write a short answer with which notes it used.
4. Planner hook: if the user asks a memory question by voice, route it to Memory instead of the planner.
5. If Ollama is not running, Memory shows a clear "Start Ollama" message; the rest of the app works.
6. Electron: Windows build target so the desktop app can install/run Ollama (`ollama:installOfficial` in main process only).

### Phase 4: Keys on the server (Supabase Edge Function)
Goal: no API keys in the browser for the demo.
1. Edge Function `planner` that calls the AI provider; keys stored as **Supabase secrets**
   (Om sets them in the dashboard; never in code, never pasted into an agent chat).
2. Edge Function `tts` / `stt` for ElevenLabs the same way.
3. App calls the functions with the user's session token. Functions check the user is signed in.
4. Keep the old "bring your own key" path behind a setting as a fallback.

### Phase 5: Gemini Live (do last, only when everything above works)
1. Add Gemini Live as a voice mode: Edge Function mints a short-lived **ephemeral token**;
   the browser opens the Live websocket with that token (the real Gemini key stays a Supabase secret).
2. Gemini Live returns tool calls; reuse the same planner tools (`plannerTools.ts`).
3. Keep OpenAI + ElevenLabs as the fallback, and a typed text box fallback if voice fails.
4. Cost is small (about $0.005/min audio in, $0.018/min audio out), but add a session time limit.

### Phase 6: Landing page
- Lots of white space, direct headlines, real screenshots of the app, one clear "Get started" button.
- Match the app's look (fonts, colors, `ThemeToggle`). Reference: `Rocky Landing.html` in the repo.
- Must not change the app's routes or auth flow.

### Phase 7: Demo prep
- Demo account with a realistic week (no real personal data).
- Script: sign up → onboarding with a photo of a schedule → dashboard → phone pairs →
  "I have a chem exam Friday, plan study time" → laptop updates live → Memory question → done.
- Rehearse with Wi-Fi only (Supabase + AI need internet; Memory works offline).

### Phase 8: Booking Agent v2 (real bookings from voice)
Goal: "book a barber Saturday at 3" really books it. Rocky drives a visible browser window
with GPT-5.4 computer use (`browser_key`), asks the user for anything it needs mid-run
(pause/resume in the same page), and only clicks the final button after a spoken/tapped yes.
Planner stays on `llm_key` and never reads `browser_key`. No schema change, no migration.
- [x] Core loop in the Electron main process (`electron/agentCore.cjs`): Responses API
      `computer` tool (screenshot → actions → screenshot), `previous_response_id` chaining,
      tools ask_user / request_final_confirmation / report_booked / handoff_to_user /
      open_url / give_up. Code-enforced gates: final click needs a recorded yes (one yes = one
      click), never types card/CVV/password/2FA/ID, CAPTCHA/login/payment/deposit → user
      takeover, user data only into the matching field, "booked" needs confirmation text on the
      page, limits (40 steps, 6 active minutes, screenshots, repeated-action loop). Unit tests in
      `electron/agentCore.test.mjs`.
- [x] Agent window (fixed 1280x800 site view + "Rocky is driving" banner with Stop),
      capturePage screenshots, sendInputEvent input, IPC start/answer/confirm/continue/cancel.
- [x] Fake multi-step booking site (`electron/test/fixtures`) + scripted-model Electron run
      (`npm run test:agent-e2e`, 17 checks: real clicks/typing, ask/resume, injection refused,
      final click blocked until yes, exactly one booking after it, reference read off the page).
- [x] Generic task types (restaurant / appointment / tickets) and slots; planner tools
      find_place, propose_booking, book_appointment, answer_agent_question, continue_agent.
- [x] Laptop UI: question card, Confirm/Cancel/Stop, status, activity log; voice in/out.
      Agent questions/results are spoken in code-built words; yes/no/stop/continue go straight to
      the agent (the planner can never approve the final click). Model picker (gpt-5.4 / -mini)
      in Profile → Model.
- [x] Phone relay through the existing `commands` table (no migration; `commands` is already in
      the realtime publication). Phone sends start/answer/confirm/continue/cancel rows, laptop runs
      them and publishes sanitized events (question, plan summary, status, reference — never
      screenshots, page text, URLs or the step log). Relay rows are deleted within ~2 minutes.
      Phone shows the same agent card above the talk button and speaks the questions; the laptop
      shows the run silently when the phone started it.
- [x] Local booking records (separate local Dexie DB `RockyBookingRecords`, never synced) +
      reference on the calendar block (title + notes); failed → "(booking failed - finish by hand)",
      cancelled → hold removed.
- [ ] Om: one real low-stakes free booking with the window visible.

Docs check (OpenAI computer-use guide + API reference, 2026-10-10): the GA tool is
`{ type: "computer" }` with no display size or environment fields; a `computer_call` carries an
ordered `actions` array (batched), not one `action`; screenshots go back as
`computer_call_output` with `detail: "original"`; safety checks arrive as
`pending_safety_checks` and are echoed back as `acknowledged_safety_checks` only after the user
approves. The guide's examples use newer models; `gpt-5.4` still lists computer use.

---

## 6. Do not build
- Emails / Gmail features (removed on purpose).
- Pomodoro or focus timers.
- Anything not in this plan without asking Om first.

## 7. Checks before every push
```
git pull
npx tsc -b
npx vitest run
npm run build
```
All must pass. Then click through the changed screens in `npm run dev` (http://localhost:8080).

## 8. Changelog
- 2026-10-10: Plan rewritten for the new repo `OmKadam16/Rocky`. Working copy moved to `C:\Rocky`.
- 2026-10-10: Phase 1 code part done: pairing QR encodes `VITE_PUBLIC_URL` when set, else the page origin (`resolvePairOrigin`, tested; documented in `.env.example`). Render site creation, Supabase redirect URLs and the real-phone test are still open (Om).
- 2026-10-10: Phones now land on the mobile UI (calendar + talk) on any path, not just `/remote` (`shouldShowMobileUi`, tested; verified at 390px with no overflow). Desktop browsers unchanged.
- 2026-10-10: One key per user shared across devices (keys sync via profile `extra`, phone keys card removed); one static QR per user (`0003_claim_pair_static.sql`, no single-use clear, far-future expiry); hidden 5-tap rotate panel in Profile → Devices (rotate code, wipe keys everywhere). Apply 0003 to the live project by hand.
- 2026-10-10: QR scan hardening (phone couldn't scan while typed codes worked): plain-English insecure-context guard (LAN http blocks the camera — points to the Render link), video attach retries on `playing` event, BarcodeDetector failure fallback to jsQR, 12s no-decode hint, fixed stale expiry copy.
- 2026-10-10: QR decode round-trip proven (the exact `qrcode.react` output decodes to the exact pair URL);
  both decoders now run in parallel so an empty native result can never block jsQR.
- 2026-10-10: Keys must prove they work: Profile → Voice has Run voice check (saved keys →
  real planner ping → real spoken reply, staged results); Profile saves no longer clear
  key fields on failure; empty mic captures say so instead of vanishing (deliberate
  tap-offs stay silent).
- 2026-10-10: QR removed entirely (scanner never worked on-device): pairing is code-only with
  static 8-char codes (`XXXX-XXXX`, `0004` accepts legacy 6-char rows); visible Rotate code
  disconnects the phone until it enters the new code; `qrcode.react`/`jsqr` deps removed.
- 2026-10-10: Phone UI fixes from the on-device screenshot: talk dock is a solid bottom bar
  (replies sit inside it, above the mic, instead of   floating over events), mic level bars moved
  directly above the mic button, calendar list scrolls in its own container (`h-dvh` layout).
- 2026-10-10: Laptop global smoothing: assistant turns fade/slide in, 150ms sidebar
  transitions, `overscroll-contain` on all laptop scroll areas. No new colors —
  dark mode contrast unchanged (existing tokens only).
- 2026-10-10: Tap to talk everywhere: mic button taps to start and taps to finish
  (no hold — a slipping thumb can't cancel a turn), and pauses never end a tap
  turn early. Opening timeout and 90 s cap remain as safety nets.
- 2026-10-10: Phone reply clears 2 s after the turn goes idle (errors stay); calendar
  scroller gets mobile touch treatment (`touch-pan-y`, contained overscroll, momentum).
- 2026-10-10: UI polish (motion lib): `ExpandableCard` accordion for Profile Model/Voice
  (single expanding card, chevron, one-open-at-a-time), spring bottom sheet + theme pill +
  swipe-down in phone Settings, sliding tab pills, mic press + reply transitions, pair-flow
  step transitions, safe-area padding, shared motion tokens + reduced-motion support.
- 2026-10-10: Gemini model list refreshed for booking-agent work: 2.5 ids replaced with
  low-token `gemini-3.5-flash-lite` (default, cheap passes) + `gemini-3.5-flash`/`3.8-flash`
  (Computer Use preview). Still `tested:false` until tool-call verification; planner default
  stays GPT-4o. Key handling unchanged: Gemini key lives as a Supabase secret set by Om,
  never in code or chat.
- 2026-10-10: Gemini key probe fixed (`providerTest.ts`): thinking models fail closed on a
  1-token cap, so Gemini probes uncapped; failures now name provider + model for diagnosis.
- 2026-10-10: Provider-switch key hygiene (Profile + onboarding): changing provider clears
  the key field so an old OpenAI key can't be tested/saved as Gemini; Profile shows a
  "Saved key is for X — paste your Y key" hint on mismatch. Network-level failures now say
  "couldn't reach the server" instead of "Connection error."
- 2026-10-10: OpenAI model list refreshed: added `gpt-5-mini`/`gpt-5-nano` (cheap daily
  turns) + `gpt-5.4-mini`/`gpt-5.4` (native computer use for browser-agent work), all
  `tested:false` until tool-call verification. Planner default stays `gpt-4o`.
- 2026-10-10: Two LLM keys, routed and separated: new `browser_key` (own Profile section
  with a GPT-5.4-pinned Test button, keychain allowlist, masks, export-strip and leak-wipe
  coverage) reserved for the computer-use runner; the planner, voice check and onboarding
  analysis read only `llm_key`. No migration needed — keys ride the profile `extra` column.
- 2026-10-10: Browser booking agent foundations (restaurant-first): `browserAgent.ts`
  (slot-filling, proposal copy, hold titles, search fallback, single-step GPT-5.4-mini worker
  on `browser_key`, 7 tests) + desktop agent window (visible Chromium via Electron, no new
  deps: open/navigate/snapshot/click/type over IPC) + planner tools `find_restaurant`,
  `propose_booking` (calendar-checked hold), `book_appointment` (confirm-gated, deep-link
  fallback without desktop). Multi-step drive loop + live booking test still open (Om).
- 2026-10-10: Drive loop wired (`runBookingLoop`): snapshot → GPT-5.4-mini → act, up to
  10 steps / 2 minutes, still in the renderer over IPC so the user watches. Terminal states
  annotate the hold (`(booked)` / `(booking failed — finish by hand)`), window stays open
  as proof or for takeover; login walls and garbage output hand to the user, never act.
  `book_appointment` (confirmed) runs it and returns booked / needs_user / failed.
- 2026-10-10: Booking honesty fixes from a real transcript: booked-language now requires a
  tool returning status booked (fabricated "Done" gets bounced, then refused plainly);
  voice "yes/no/ok" always reaches the planner (filler exemption); re-proposing moves the
  existing hold instead of stacking a second one and bouncing off it; contact slots added
  (first/last name, phone, email with account-email suggestion, occasion); prompt rules for
  time windows (slot-finder, never pin to window start), holds-are-not-bookings, and
  spoken/on-screen receipts only (no email sending).
- 2026-10-10: Turn latency, measured then cut: every planner turn now records timing
  (snapshot / llm-per-round / tools / total) with a hidden debug readout (AssistantPanel,
  `vc-debug=1` in localStorage) plus a console line; preferences ride the snapshot (one
  fewer database round-trip); typed sends stay silent (text up, turn idle immediately)
  instead of waiting on speech synthesis — mic turns and yes/cancel still speak.
- 2026-10-10: Booking Agent v2 started (Phase 8): main-process computer-use core with code-enforced safety gates and limits, 35 unit tests. Not wired to the app yet.
- 2026-10-10: Booking Agent v2 wired in: agent window (banner + Stop, capturePage, sendInputEvent, isolated-world DOM probes for the gates), IPC start/answer/confirm/continue/cancel + events, generic planner tools (find_place, propose_booking, book_appointment, answer_agent_question, continue_agent), laptop agent card + spoken questions, local evidence records. Old selector agent (`browserAgent.ts`, `browserDriver.ts`) removed. `build:electron` now runs on Windows too (`scripts/build-electron.mjs`). 128 unit tests + 15-check Electron E2E.
- 2026-10-10: Booking Agent v2 phone relay over `commands` (no migration): phone card + spoken questions, laptop host runs the agent, sanitized events only. 131 unit tests.
- 2026-10-10: Booking Agent v2 review fixes: CAPTCHA/card detection counts visible widgets only (invisible reCAPTCHA v3 no longer forces a takeover; E2E proves both ways), a visible password box alone no longer stops the run (typing into one still does), "yes" without a hold id books the plan just read back (planner history is text-only), a browser key synced from another device is pulled into the keychain before the agent starts. 133 unit tests + 17-check E2E.
- 2026-10-10: Windows desktop build: `npm run build:win` → `release/Rocky Setup <version>.exe` (NSIS, per-user, x64, unsigned; uses the local Electron dist because the zip extract-rename hits EPERM on this machine). Single-instance lock so a second launch can't run a second agent / relay host. Installed on Om's laptop for the live booking test.
- 2026-10-10: Fix from the first live run (Nobu): OpenAI 400 "Computer tool only allows input image without previous response". After open_url / a continued handoff the loop no longer sends a plain screenshot message; it asks the model to take a screenshot, which comes back as computer_call_output. Regression tests added (135 unit, E2E 17/17). Installer rebuilt and reinstalled.
