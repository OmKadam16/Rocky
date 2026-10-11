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
- Chat memory syncs per user through the profile row's `extra.chat_memory` (facts + summary, no
  migration). It is built only from planner-visible chat turns: never Memory (browsing) content,
  codes, passwords, card or ID numbers. Which of a device's turns are summarised stays local.
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
> Superseded by Phase 10 (2026-10-10, Om): storage moves from Dexie to an SQLite store in the
> Electron main process, fed by a Chrome extension. Items 1, 3–5 carry over there.
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
- [x] Speed pass (measured first): per-step timing (screenshot / model / action / settle / nav,
      shot size) + run summary in the debug readout (`vc-debug=1`) and the main-process log;
      event-based settle (load done + no request in flight + 250ms DOM quiet, cap 2s / 4s while
      a page loads) instead of fixed sleeps; JPEG q85 screenshots; low reasoning effort with one
      medium step after a blocked/looping step; stable `prompt_cache_key`; the start page
      pre-opens while the plan is read back (the run waits for the yes, then reuses that load);
      answers to an agent question skip the planner; TTS fetches the next chunk while one plays.
- [x] Spoken progress updates (`src/lib/progressTalker.ts`): code-built filler lines from agent
      events + a timer (first ~3s, then ≤1 per ~8s, no repeats, silenced by real events, user
      speech, pauses). Shown as the status line on laptop + phone (relayed as `progress`), spoken
      only on the device the user talks to. Setting: Profile → Voice → "Spoken progress updates"
      (on by default; profile `extra.progress_speech`, no migration).
- [x] Booking-contact verification codes (narrow exception): `request_verification_code` tool;
      code decides booking-contact vs sign-in (code field's form text, URL, model reason; unsure →
      handoff), normalizes 4-8 spoken/typed digits, types them itself (masked; one per box when
      split), 3 tries then handoff. Never logged, emitted, relayed, stored, or sent to a model or
      the planner. Phone: codes are entered on the laptop only (the relay is Supabase).
      Sign-in 2FA, authenticator/backup codes, passwords, cards, IDs, CAPTCHAs, payment: handoff.
- [ ] Om: one real low-stakes free booking with the window visible (`vc-debug=1` to read timings).
- [ ] Om: decide how a code said to the phone should reach the laptop (today: laptop only).

Docs check (OpenAI computer-use guide + API reference, 2026-10-10): the GA tool is
`{ type: "computer" }` with no display size or environment fields; a `computer_call` carries an
ordered `actions` array (batched), not one `action`; screenshots go back as
`computer_call_output` with `detail: "original"`; safety checks arrive as
`pending_safety_checks` and are echoed back as `acknowledged_safety_checks` only after the user
approves. The guide's examples use newer models; `gpt-5.4` still lists computer use.

### Phase 9: Universal chat dashboard
Goal: one chat on the Dashboard handles commitments, calendar/tasks, bookings and Memory.
- [x] Dashboard = [Sidebar] | [chat ~55%] | [selected day ~30%, prev/next/Today, live]. Chat-only
      under 1100px. Side AssistantPanel hidden on the Dashboard only; other pages and the phone
      unchanged. Same assistant (useAssistant), typed + mic, listening/thinking state.
- [x] Chat history local only (separate Dexie DB `RockyChat`, last 200, Clear chat). Private
      turns (Memory, receipts) never go to the cloud planner (`plannerHistory`, tested).
- [x] Commitments by chat: `propose_commitment` / `_change` / `_removal` → CommitmentCard
      (Confirm / Edit inline / Cancel, conflicts on the card); only Confirm or the user's own
      yes (code fast path, latest pending card only) writes; idempotent; one question at a time,
      never invented times. Tests: no write on propose, write once, double-confirm, cancel,
      conflicts, weekday recurrence + active_until, spoken yes.
- [x] Booking cards inline (live AgentCard at the end of the thread; answers by voice or typing)
      + "added to your calendar" receipts with Undo for the last action (per-turn snapshot diff,
      only the latest is undoable; tested).

### Phase 10: Memory + Chrome extension (all local)
Goal: "what did I read about X" works from pages the user actually visited; nothing leaves
the laptop. Model: Ollama `qwen3.5:2b` (think:false, temperature 0.1) only writes the answer;
code does the search.
- [x] Store in the Electron main process: `node:sqlite` (built into Electron 44, FTS5 + BM25
      verified, no native build) in userData. Retention (default 90 days) + size cap.
- [x] Ingest server on 127.0.0.1 only, POST /ingest, pairing token + extension Origin check,
      body cap, no CORS wildcard; runs only while the app runs and Memory is on.
- [x] Chrome MV3 extension (`extension/`, `npm run build:extension` → `extension/dist`):
      capture on tab complete via the service worker + `chrome.scripting` (no static
      content script); automatic capture needs the user to grant optional host access in the
      popup, otherwise only "Save this page now" (`activeTab`). Exclusions, pause, no incognito,
      no password/payment pages, never input/textarea text, dedupe, offline queue.
- [x] Memory page = control panel (on/off, pause, pairing token, excluded sites, storage,
      retention, saved pages list with delete / delete everything, Ollama status, install steps).
- [x] Memory in the chat: code-side intent + date parser, local search, local Qwen answer,
      MemoryResultCard with sources; the planner only ever gets "Answered from Memory, shown
      to the user". Clear one-line messages when Memory is off / Ollama down / nothing found.

### Phase 11: Unified Memory: gists, vectors, monthly compaction
Goal: Memory stores the gist of what the user read (not raw pages), searchable by meaning, and
old months shrink automatically. All local: memory text, gists and vectors never go to Supabase,
OpenAI, any cloud, logs, the relay or the phone. No Supabase schema change.
Decision (Om, 2026-10-11): the old retention setting (7/30/90 days/Forever) is replaced by
monthly compaction + the size cap (default 500 MB); "Keep shrinking older months" is the only
further shrink.
- [x] Inbox → gist pipeline: `pages` is a temporary inbox (raw text ≤ 24 h, deleted as soon as
      gisted); background worker in main (`electron/memoryWorker.cjs`): one item at a time, waits
      while the user is mid-turn or a booking run is going (`memory:busy`), per-minute cap, 30 s
      timeout, 3 tries then a title-only memory, queue cap 300 (oldest dropped and counted).
- [x] Gists (`electron/memoryGist.cjs`): local model with Ollama `format` JSON schema (title, gist,
      key_points ≤5, topics ≤5, entities ≤8, kind, importance 0-3, paper authors/venue/year),
      validated + clamped in code; DOI / arXiv ids by regex; page text fenced as data; secrets
      (API keys, cards, SSN, IBAN, JWTs, private keys) redacted first; search pages stored as
      "searched: <query>" without a model; login / empty / feed pages skipped.
- [x] Sessions + dedupe: same URL or content hash or near-identical gist → the same memory
      (visit_count, last_seen); same topic within 30 minutes → one merged entry (all URLs,
      first/last seen, minutes). "Save this page" is pinned (optional small thumbnail).
- [x] Local vectors (`electron/memoryVectors.cjs`): Ollama /api/embed with `nomic-embed-text`
      (EMBED_MODEL), batches of 16, Float32 blobs in `vectors`, in-memory cosine index; vectors
      backfill when the model is installed later; keyword (BM25) fallback otherwise.
- [x] Hybrid search (`electron/memorySearch.cjs`): cosine + BM25 over title/gist/topics/entities/
      body, recency boost, date/site/kind filters, tier-aware, relevance threshold (unrelated →
      nothing). `ask_memory` answers only from retrieved gists/digests and is honest about
      resolution ("I only have a summary of that month now").
- [x] Monthly compaction (`electron/memoryCompact.cjs`): an ended month is compacted once
      (clusters → digest per theme + a month overview; pinned / importance-3 kept as highlights
      with full gists); one transaction per run; 7-day undo backup; idempotent + resumable
      (a failed cluster keeps its originals, month marked done only when all succeed); runs at
      start and daily, never while busy; size cap (oldest uncompacted month, then oldest
      unimportant digests); "Keep shrinking older months" (off) → yearly overview after 12 months.
- [x] Memory page: tier counts, storage, queue, last/next compaction, Compact now, Undo, Keep
      shrinking, search model download, browse by month with Pin / Delete / Delete this month.
- [x] Extension: time on page (`/visit`, active tab only), "Save this page" marked manual.
- [x] Tests: `electron/memoryUnified.test.mjs` (fake Ollama + fake clock) + ported
      `memory.test.mjs`; fixture `electron/test/fixtures/memory-pages.json`
      (`node scripts/memory-fixtures.mjs`); eval `node scripts/memory-eval.mjs [--real]`.
- [ ] Om: download the search model (Memory page → Search model), rebuild/reload the extension,
      browse for a while, and run the eval with `--real`.

### Phase 12: Phone connect fix
Goal: the phone pairs with the typed 8-char code and stays connected to the desktop app
(renderer on app://rocky). No schema change; live project checked: 0003 (static claim) and
0004 (8-char check) are applied.
- [x] Phone URL: Devices shows "On your phone, open <URL> and enter this code" with Copy.
      URL = saved "Phone site address" (profile extra `phone_site_url`) or `VITE_PUBLIC_URL`
      baked at build time; only http(s), never app://rocky; warns on localhost / LAN / plain http.
      `build:win` / `build:mac` warn loudly when `VITE_PUBLIC_URL` is unset
      (`ROCKY_REQUIRE_PUBLIC_URL=1` makes it an error) and stop on a non-http(s) value
      (`scripts/publicUrlGuard.mjs`). **`VITE_PUBLIC_URL` must be the https Rocky website** the
      phone opens (the phone mic needs https).
- [x] Keys: desktop `setSecret` writes the keychain AND the shared profile row (it used to clear
      the shared copy, so the phone never had a key); `getSecret` falls back to the shared copy;
      one-time startup sync pushes keychain-only keys up; wipe clears both.
- [x] Laptop stays online: `backgroundThrottling: false`, powerSaveBlocker
      "prevent-app-suspension" while a phone is paired (released on unpair / quit), heartbeat at
      start / focus / online / visible / wake from sleep (`power:resume`) + one retry after 3 s.
      The phone says "Your laptop is asleep or closed. Wake it and open Rocky."
- [x] Connection check (phone pair flow + home, collapsed, opens on failure): signed in,
      claim_pair result with errcode, heartbeat age, realtime subscribed, keys present/missing,
      ping round trip (relay ops `ping` / `report` on the existing `commands` rows). Laptop Devices
      shows the phone's last seen and last ping ms.
- [x] Code-only flow: dash / spaces / lowercase accepted; wrong code → "Wrong code", "No laptop
      on this account" or "No code on the laptop"; Devices self-check warns with the 0004 SQL
      when the code is 6 chars or the constraint rejects 8.
- [ ] Om: host the web app on https (e.g. Render), set `VITE_PUBLIC_URL` to it (or paste it in
      Devices → Change address), rebuild, and run the phone test in the report.

### Phase 13: Smarter, faster planner
Goal: the planner understands the calendar, clears several blocks with one confirmation, answers
faster on gpt-5-nano, and the voice says "one moment" while it thinks.
- [x] Speed: GPT-5 models (OpenAI) run with `reasoning_effort: "low"`, `verbosity: "low"`
      (they defaulted to medium on every round); note summaries use "minimal".
- [x] Calendar understanding: context covers today + the next 7 days (the Mon-Sun week left out
      tomorrow on a Sunday) and starts with a plain-text CALENDAR AT A GLANCE (every entry in time
      order with kind, over / now / later today, id, per-day totals and free windows, pending tasks).
- [x] Prompt: THE CALENDAR guide (fixed commitments, blocks, holds, tasks, free windows,
      preferences), what users' words mean (all / clear / tonight / this afternoon / that one),
      answering calendar questions from the glance, a silent 5-step routine, worked examples
      (including "remove all the blocks today").
- [x] `delete_blocks`: one preview naming every block, one question, one confirmed call that deletes
      the whole list (the preview is remembered, so a bare "yes" works); fixed commitments stay.
- [x] Spoken "One moment" (fits the request) if the planner takes more than 0.6 s, "Still on it"
      after 9 s; the reply waits for it; follows Profile → Voice → Spoken progress updates.

### Phase 14: Phone: Chat + Calendar tabs
Goal: the phone web app gets a bottom tab bar with CHAT and CALENDAR, and can ask Memory questions
that the laptop answers. No Supabase schema change.
Exception to "Memory content never goes to Supabase" (Om's spec, 2026-10-11): a Memory question
from the phone and its answer card ride ONE transient `commands` row (text `rocky-memory:v1`);
the phone deletes it right after reading, the laptop purges memory rows older than 2 minutes on
start and every minute. Memory itself (pages, gists, vectors) never leaves the laptop.
- [x] Tab bar (role=tablist, sliding pill, 44 px targets): last tab remembered, Calendar on first
      open, `?tab=chat` deep link; 220 ms fade/slide between tabs; hidden while the keyboard is up
      (the shell follows `visualViewport`, so the composer stays above the keyboard).
- [x] Calendar tab: same header, chip, day/week, strip and list; TalkDock replaced by a floating
      mic (bottom-right), a reply toast (2 s after the turn, "Open chat"), and any pending
      Confirm/Cancel or booking AgentCard kept above the tab bar.
- [x] Chat tab: thread (user right, Rocky left), cards (commitment, receipt + Undo, Memory, agent),
      composer (input, Send, mic), thinking/listening/speaking, errors, laptop-asleep notice,
      Confirm/Cancel; header with chip, Memory · N (shared ChatMemoryPanel), Clear chat, settings.
- [x] Phone chat history in local Dexie (last 200); private turns (Memory Q&A) never saved.
- [x] Memory relay (`src/lib/memoryRelay.ts` protocol, `memoryRelayLive.ts` Supabase binding):
      laptop answers with the same local path; 30 s timeout; asleep / Memory off / Ollama down /
      nothing found / toggle off each one sentence. "Allow Memory questions from my phone"
      (profile extra `phone_memory_questions`, default on) in laptop Profile → Devices and the
      phone settings sheet; the laptop enforces it. The first relayed card notes "Sent through your
      account for a moment, then deleted."
- [x] Tests: tabs / deep link / persistence / keyboard / toast / pending cards, private turns not
      saved, relay protocol with a fake Supabase (round trip, delete-after-read, expiry, purge,
      toggle off, laptop offline, timeout), planner never sees memory text. Screenshots:
      `npm run screens:phone` (mocked Supabase; 390x844 + 360x740, light + dark, keyboard open).
- [ ] Om: deploy the web build where the phone loads it (Render), refresh the phone, run the
      manual test in the report.

### Phase 15: Android app (Capacitor)
Goal: the phone UI as a real Android app (same code, same login, same tabs). No schema change.
- [x] Capacitor 8 (`capacitor.config.ts`): appId `com.rocky.calendar.android` (debug builds add
      `.debug`), webDir `dist`, androidScheme https (origin https://localhost). The app always
      boots into the phone UI (`shouldShowMobileUi`). Web and desktop builds unchanged
      (`CAPACITOR=1` only switches the asset base).
- [x] `android/` in git (no local.properties, keystores or build output), Gradle wrapper 8.14.3,
      AGP 8.13, Kotlin 2.2.20, minSdk 24, target/compile 36. Icons (adaptive) and light/dark
      splash from build/icon.png (`node scripts/android-icons.mjs`); bar icons follow the theme.
- [x] Permissions: INTERNET, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, REQUEST_INSTALL_PACKAGES (updater).
      Mic via Capacitor's WebChromeClient; spoken replies play without a second tap. Voice already
      uses recorded audio + ElevenLabs STT (no Web Speech API anywhere).
- [x] allowBackup false + data-extraction rules, no cleartext, release not debuggable, WebView
      debugging off. Supabase session in Android Keystore-backed storage
      (@aparajita/capacitor-secure-storage); API keys aren't stored on the phone (read from the
      profile row when needed).
- [x] Email links: `com.rocky.calendar.android://auth` deep link → PKCE code exchange
      (Supabase redirect URL to add by hand). Back button (settings → Chat → Calendar → leave),
      resume (session, realtime, calendar refresh), offline banner, screen kept on only during a
      booking run, safe areas via --safe-area-inset-*, no zoom/overscroll.
- [x] Pairing exactly as the phone site; Devices notes the app needs only the code.
- [x] `npm run build:android` (debug), `npm run build:android:release` (keystore from env /
      gradle properties, `scripts/android-keystore.md`); CI debug APK on every push
      (`.github/workflows/android-build.yml`). Version: package.json → versionName, versionCode
      = x*10000 + y*100 + z.

### Phase 16: Auto-update
- [x] Desktop: "Check automatically on start and every 6 hours, download in the background, ask
      before restarting" (profile extra `desktop_auto_update`, default on); unsigned NSIS
      (no publisherName → no signature check; full downloads, no differential); clear message
      when Windows refuses. `release-desktop.yml` on tag `v*` → `OmKadam16/rocky-releases`.
- [x] Android web layer over the air: @capgo/capacitor-updater in manual mode (no capgo cloud,
      stats off), SHA-256 checked, applied on next launch, rollback when the bundle doesn't call
      notifyAppReady in 10 s, failed versions never retried, `minNativeVersion` gating, check on
      start/foreground at most every 6 h, "Updated to x.y.z" once (`src/lib/appUpdate*.ts`).
- [x] Android APK: "Update available (x.y.z, N MB)" card, download + SHA-256 in Kotlin
      (`RockyApkUpdaterPlugin`), FileProvider → Android's installer (never silent).
- [x] `release-android.yml` on tag `android-v*` → APK + dist.zip + android-update.json in
      `OmKadam16/rocky-android-releases`. Docs: `docs/RELEASING.md`.
- [ ] Om: create both releases repos, RELEASES_REPO_TOKEN and build secrets, run keytool once,
      add the Supabase redirect URL, publish the first releases, then set UPDATES_ENABLED = true.
      - [x] Release keystore generated outside the repo (`%USERPROFILE%\rocky-keys\`, gitignored).
      - [x] Releases repos renamed to `rocky-releases` / `rocky-android-releases`.
      - [x] Actions secrets set: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_PUBLIC_URL,
            the four ANDROID_*, RELEASES_REPO_TOKEN.

### Phase 17: On-phone booking agent
Goal: bookings work from the Android app with the laptop off, with exactly the desktop's gates.
- [x] One agent core for both: `shared/agentCore.mjs` (moved from electron/agentCore.cjs, which now
      re-exports it via require(esm)) and `shared/agentPageScripts.mjs` (the in-page probes and
      settle timings). Desktop behaviour and tests unchanged (core 53/53, Electron E2E 28/28).
- [x] `RockyAgentBrowser` (Kotlin): full-screen visible WebView with "Rocky is driving" + Rocky /
      Stop; own WebView profile (cookie jar), JS on, popups denied, http(s) only, downloads
      ignored, no file/content access, no JS bridge, permissions denied, Safe Browsing on, no zoom,
      pages laid out at the WebView's CSS width (screenshot px = page px). open, navigate,
      screenshot (CSS-px JPEG), pointer (touch, CSS→physical via AgentCoords, unit-tested), key,
      insertText (key events: a code never goes into a script string), evaluate (read-only
      probes), history, state, setBanner, show/hide, close.
- [x] `src/lib/agentAndroid.ts`: the driver + controller in the app's JS, registered as the local
      agent (agentClient.setLocalAgentBridge), so AgentCard, voice, planner tools, codes and
      confirmations work as on the laptop. The page steps aside for questions/confirmations and
      comes back for takeovers; screen kept on only during a run; a run Android killed marks the
      hold "booking failed - finish by hand" on the next start. APKs without the plugin keep the
      laptop relay. OpenAI calls go phone → api.openai.com with the shared browser key.
- [x] Tests: driver/plugin contract + controller (`src/lib/agentAndroid.test.ts`), the fake
      booking site through a Playwright-backed mock plugin at phone size
      (`npm run test:agent-android`, 23/23), Kotlin `AgentCoordsTest`; manual list
      `docs/ANDROID-DEVICE-TESTS.md`.
- [ ] Om: run the device tests on a real phone (booking with the laptop closed).

### Phase 17.1: Android blank screen fix (0.1.15)
- [x] Cause: `secureAuthStorage` resolved a promise WITH the SecureStorage plugin; Capacitor's
      plugin Proxy answers `then` with a native call, so the promise never settled, getSession()
      hung and the app sat on the "Rocky" loading screen. Now the module is resolved and the
      plugin reached through it (test reproduces the hang with a Capacitor-like Proxy).
- [x] Never blank again: startup watchdog (`src/lib/boot.ts`, 8 s, plain-DOM "Rocky could not
      start" with the real error, the stuck step, the version, Retry); `[rocky:boot]` console
      steps; root ErrorBoundary shows the error + version; a failed session read goes to sign-in
      with the reason.
- [x] Version shown in Profile and phone settings; debug APKs inspectable via chrome://inspect
      (release builds still not).

### Phase 17.2: Bad characters in build secrets
- [x] Cause: the secrets were set through a Windows PowerShell 5.1 pipe, which prefixes a UTF-8
      BOM; the APK's Supabase URL and anon key started with U+FEFF (the minifier folded `.trim()`
      at build time without removing it), so sign-in's fetch rejected the header. All 7 secrets
      re-set from BOM-free files (`gh secret set NAME < file`), checked printable ASCII.
- [x] `shared/envCheck.mjs` + `scripts/check-build-env.mjs`: every workflow (debug APK, Android
      and desktop releases) stops first with the secret's NAME and the problem, never the value.
- [x] App: a bad Supabase URL/key shows "Rocky is misconfigured: <NAME> has invalid characters.
      Rebuild the app." instead of a raw fetch error (checked on the raw value, not trim).
- [x] Found on the way: `.gitignore`'s `release-*` (local build folders) also matched
      `.github/workflows/release-*.yml`, so neither release workflow was ever committed and tags
      would have done nothing. Exception added; both workflows now in git.

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
- 2026-10-10: Added `gpt-5.5` to the OpenAI picker as a browser-work step-up option
  (`tested:false`; worker default stays `gpt-5.4-mini` on cost).
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
- 2026-10-10: Retrying a booking reuses its earlier failed/unclear hold instead of reporting a clash with it (the in-memory draft doesn't survive an app restart). 136 unit tests. Installer rebuilt and reinstalled.
- 2026-10-10: Booking Agent v2 speed, reassurance and OTP: per-step timing + run summary (debug readout); event-based settle, JPEG shots, pre-opened start page, planner-free answers, TTS prefetch (local overhead per acting step on the E2E fixture ~594ms → ~350-410ms; model time not measurable here, see report); spoken progress updates with the new Profile → Voice setting (no migration); booking-contact verification codes typed by code, never stored or relayed. 174 unit tests + 28-check E2E. Installer rebuilt and reinstalled.
- 2026-10-10: Phase 9 started: Dashboard is now Sidebar | universal chat | selected day (chat-only under 1100px), chat history in a local-only Dexie DB (last 200, Clear chat), private turns never reach the cloud planner. Old DashboardPage removed.
- 2026-10-10: Phase 9 done: commitments by chat (propose → confirm card, code-enforced confirm), receipts with Undo for the last action, booking card inline in the chat.
- 2026-10-10: Phase 10 part 1: Memory store (`electron/memoryStore.cjs`, node:sqlite FTS5/BM25, dedupe, default + user exclusions, retention, size cap, screenshots on disk with a cap), code-side query parser (`memoryQuery.cjs`: today/yesterday/last week/on Tuesday/this morning/in September…), local answers (`memoryAnswer.cjs`, Ollama only, searches answered in code), 127.0.0.1 ingest server (`memoryServer.cjs`: pinned extension Origin, Host check, token, body cap, no CORS wildcard) and IPC (`memoryMain.cjs`). 22 tests incl. real HTTP and a privacy test (no cloud imports, only 127.0.0.1 peers, no logging).
- 2026-10-10: Phase 10 part 2: Rocky Memory Chrome extension (MV3, plain JS, no deps). Fixed ID `jdnejbolgdoclegdleaaddghjbgbdidh` from a public key in the manifest (the server pins that Origin; the build fails if they differ). Permissions: storage, activeTab, scripting, alarms + host 127.0.0.1 only; automatic capture is an optional all-sites grant from the popup. Popup: connect with token, On/Pause, Save this page now (+ optional screenshot), Don't save this site, saved count. Extractor tested in real Chromium (`npm run test:extract-e2e`, 6/6).
- 2026-10-10: Memory page is now the control panel: on/off + pause, live Ollama/model status with Download model, extension install steps, pairing token (show/copy/rotate), server status, inline Ask with MemoryResultCard, saved pages (filter, Open, Delete, Delete everything with a second click), excluded sites editor, retention (7/30/90 days/Forever) and the size cap note.
- 2026-10-10: Phase 10 done: Memory in the chat. Memory questions are routed in code (`memoryIntent.ts`) and never reach the cloud planner (question + answer turns are private); the planner's fallback `ask_memory` tool returns only "Answered from Memory, shown to the user." (tested). MemoryResultCard inline, spoken answer = the short answer only. Verified against the real local qwen3.5:2b: 3 pages ingested over HTTP, answers grounded with titles, searches answered in code, "couldn't find" when nothing matches.
- 2026-10-10: Fix from Om's first extension connect ("Rocky refused the connection"): Chrome omits the Origin header on some extension GETs, so /status got 403. The extension now also sends `X-Rocky-Extension: <its id>`; the server accepts that only when there's no Origin (a web page can't send it without a preflight, which carries an Origin and is refused). Token still always required. Popup errors now say which check failed. Tested.
- 2026-10-10: Memory fixes from the first live test in Om's Chrome (3 Wikipedia pages captured automatically): search tries the words as a phrase, then all words, then any word (BM25 alone couldn't separate pages where Wikipedia's "[edit]" links put common words everywhere); keywords match stemmed or prefix forms; #fragments stripped on save; one source per page (redirects); extractor skips edit links/citation markers/nav; longer snippets; if the local model can't extract an answer but pages matched, it says so and shows them. Verified against the real captured pages + qwen3.5:2b: base editing / Qwen / sourdough answered from the right page, an unknown topic says it couldn't find it.
- 2026-10-10: Booking draft fixes from a live Nobu chat: correcting the type ("appointment" → restaurant) or naming the place more fully ("Nobu" → "Nobu Newport Beach") no longer wipes the draft (it re-asked everything twice); a different place keeps who's booking. Name, phone and email given in a booking are remembered right away (profile `extra`: booking_first_name/last_name/booking_email, no migration) and reused silently next time, still shown in the plan read-back. Type follows the kind of place (a restaurant never gets "Which service?"). Regression test replays the chat. Installer rebuilt and reinstalled.
- 2026-10-10: Booking go-ahead fixed from a second live chat (plan read back three times, agent never started): a go-ahead right after the read-back ("yes", "Yes, make the appointment", "just book it") now starts the agent in code with no planner round trip; changes ("yes but at 9") and later unrelated yeses still go to the planner; book_appointment and the yes-to-suggestion accept the same natural wording. Agent prompt: TASK details are never re-asked, how to reach and fill a booking widget, ask with the closest open times when the exact one is taken. Installer rebuilt and reinstalled.
- 2026-10-10: Chat memory (`src/lib/chatMemory.ts`, local Dexie `RockyChatMemory`, this device only, never Supabase): facts the user asks Rocky to keep (planner tools remember_fact / forget_fact; same topic replaces, secrets refused) plus a running summary of conversation that has left the planner's 8-turn window, folded in the background and on Clear chat (which now clears messages, not memory). The planner reads chat_memory first every turn. Chat header: "Memory · N" lists it, with per-item ✕ and Forget everything. No migration. Installer rebuilt and reinstalled.
- 2026-10-11: Chat memory now syncs between laptop and phone through profile `extra.chat_memory` (no migration): facts and the summary are shared, folding bookkeeping stays per device, every write reads fresh first so neither device drops the other's change, a change on one device refreshes the other's Memory list over realtime, and the laptop's earlier local-only memory is merged in once. Installer rebuilt and reinstalled.
- 2026-10-11: Phase 11 Unified Memory: raw pages are a 24 h inbox; a background worker gists them with the local model (JSON schema, injection-safe, secrets redacted), merges reading sessions and dedupes, embeds locally (nomic-embed-text, BM25 fallback); hybrid search with a relevance threshold; monthly compaction into digests + overviews (pinned / important kept, 7-day undo, resumable, size cap); retention setting replaced by compaction (Om's call); Memory page shows tiers, storage, queue, compaction and browse-by-month; extension sends time on page. Fixture: a busy month (200 entries) compacts 11.4x. No Supabase change.
- 2026-10-11: Phase 12 Phone connect fix: Devices shows the phone address (VITE_PUBLIC_URL or a saved "Phone site address", never app://rocky) + build guard; desktop keys now also go to the shared profile row (they were only in the keychain, so the phone had no key) with cloud fallback and a one-time sync; the desktop window isn't throttled when minimized, stays unsuspended while a phone is paired and heartbeats on focus/online/wake with a retry; phone Connection check (6 steps) and specific wrong-code messages; laptop shows the phone's last ping. No schema change.
- 2026-10-11: Phase 13 Smarter, faster planner: low reasoning effort for GPT-5 models, 8-day rolling context with a plain-text calendar glance, a detailed calendar guide in the prompt, `delete_blocks` (one confirmation clears several blocks), and a spoken "One moment" while the planner thinks.
- 2026-10-11: Network errors are named and retried: voice-to-text, voice reply, calendar reads and the planner each retry once on a network blip and say which service dropped instead of "Failed to fetch"; a small local error log (service + browser message, no user text) shows in the vc-debug readout.
- 2026-10-11: 12-hour clock in replies: the prompt teaches "8 AM / 12 PM / 8 to 10 PM" both ways (user commands in, replies out), the calendar glance shows each time's spoken form, and every assistant reply (on screen and spoken, laptop and phone) passes through `speakableTimes` so no 24-hour time or ISO date reaches the user.
- 2026-10-11: Phase 14 Phone: Chat + Calendar tabs (bottom tab bar, floating mic + reply toast + pending cards on Calendar, full chat with cards and composer, keyboard-aware), phone chat history without private turns, Memory questions from the phone answered on the laptop through one transient relay row (deleted after reading, purged after 2 min), "Allow Memory questions from my phone" toggle. No schema change.
- 2026-10-11: Phase 15 Android app (Capacitor 8): same web build in the phone UI, mic + spoken replies in the WebView, Keystore-backed session, deep-link email links, back button / resume / offline banner, icons + light/dark splash, debug + signed release builds, CI debug APK. No schema change.
- 2026-10-11: Phase 16 Auto-update: desktop checks on start and every 6 h (download in background, ask before restart; unsigned NSIS, full downloads) + release-desktop.yml; Android OTA web bundles (SHA-256, rollback, minNativeVersion) + APK update card via the package installer + release-android.yml.
- 2026-10-11: Phase 17 On-phone booking agent: shared agent core + page probes (desktop unchanged), Kotlin RockyAgentBrowser (hardened visible WebView), the same BookingRun gates running in the Android app, laptop relay kept as the fallback; Android agent E2E through a mocked plugin 23/23.
- 2026-10-11: Release setup: release keystore made outside the repo (gitignored), device test list matches the current sign-in + pairing-code flow; repos found under doubled names, secrets waiting on the gh CLI.
- 2026-10-11: Release setup done: Actions secrets set (values never printed), releases repos renamed to the short names.
- 2026-10-11: 0.1.15 Android blank screen fix: Supabase session storage no longer resolves a promise with a Capacitor plugin proxy (getSession hung); startup watchdog + [rocky:boot] logs + root error boundary with version; version in Profile; debug APKs inspectable.

### Phase 18: Calendar import (iCal + Google)

Goal: Students can connect club/class/org calendars so those events appear in Rocky; imported events are read-only copies that the planner treats as fixed time, and the user can hide occurrences via chat/voice ("remove the Thursday robotics meeting") to free up time for planning.

**Part 1: iCal URL import (no OAuth)**
1. Profile → Calendars (laptop and phone settings, read-only list): "Add calendar by link". User pastes an iCal URL (Google's "Secret address in iCal format", webcal://, https://). Normalize webcal:// to https://, validate, fetch on laptop (Electron main, avoid CORS), parse VEVENT (title, start/end, all-day, location, description trimmed, RRULE/EXDATE/RECURRENCE-ID, VTIMEZONE/TZID, cancelled status). Expand recurring events into a rolling window (−7 days to +120 days), apply EXDATEs and overrides.
2. Name + color per calendar, on/off toggle per calendar, "Sync now", last synced time, error state in plain English, Remove calendar (removes its imported blocks).
3. Sync: on app start, every 15 min while open, on window focus, and Sync now. Idempotent by (calendar_id, external_id, occurrence date): update changed events, remove events that disappeared from the feed, never duplicate, never resurrect a hidden event (hidden flags persist across syncs). Feed URLs stored in the OS keychain/secrets path, never in Supabase, never in logs or chat. Validate URLs (https only, no localhost/private IPs, ~5 MB cap, 15 s timeout, content-type sanity) to avoid SSRF.

**Part 2: Google Calendar OAuth (read-only)**
1. Desktop OAuth 2.0 with PKCE and loopback redirect (http://127.0.0.1:<random port>) opened in system browser from Electron main. Scope: https://www.googleapis.com/auth/calendar.readonly ONLY (plus openid email). Google OAuth client ID from build/env config (GOOGLE_CLIENT_ID); document where in .env.example and PLAN.md. Never hardcode a client secret in the repo; read from env/local config. Refresh token goes in the OS keychain (safeStorage) only, never Supabase, never the renderer, never logs.
2. "Connect Google Calendar" button in Profile → Calendars. After consent, call calendarList.list and show every calendar (name, color, account, primary vs subscribed/shared) with toggles; default ON only for primary calendar and user-selected calendars; default OFF for holidays/birthdays. "Disconnect" revokes the token at Google and wipes the keychain entry and imported blocks.
3. Events: events.list with singleEvents=true, timeMin/timeMax rolling window, incremental sync with syncToken per calendar (handle 410 Gone by full resync), pagination, ignore cancelled, ignore declined, treat transparent ("free") events as not blocking. Honor event timezones; convert to local minutes-since-midnight; handle all-day and multi-day events.
4. Errors in plain English: consent denied, token expired/revoked ("Reconnect Google Calendar", 7-day refresh-token expiry in Testing mode), rate limit/backoff, offline.

**Part 3: How imported events behave**
- Imported blocks are FIXED (scheduler never moves them) and read-only (no editing/deleting on Google). They show a color dot and calendar name; all-day events show in an all-day strip and do not block time unless the user turns that on per calendar.
- User can HIDE an occurrence ("remove" = hide in Rocky only). Hidden event disappears from views, never blocks scheduling, and is not re-imported. Recurring series: hide ONE occurrence unless user says "every"/"all", then hide the whole series (store as hidden series on the calendar + external series id). "Show it again" / "unhide" works; there is a "Hidden events" list in Profile → Calendars with Restore.
- Planner tools: `hide_calendar_event` (by title/fuzzy match + date, one occurrence or series), `restore_calendar_event`, `list_calendar_events` (read). Hiding follows existing confirmation pattern: confirm card for series or bulk hides; single occurrence with one-line undo ("Hidden. Undo"). Planner never deletes or edits the source calendar.
- Planner must treat imported events as busy time, tell user about conflicts with them, and after a hide immediately offer the freed slot ("That frees Thursday 5-6 PM. Want me to use it?"), without doing it unprompted.
- Weekly/monthly/day views and the phone calendar show them; Dashboard right-hand day view too. Search ("when is the robotics meeting?") finds them.

**Part 4: Security / Privacy**
- Tokens and feed URLs never reach Supabase, renderer logs, planner prompts, or the phone. Event titles/times do go into the user's Supabase calendar like any other block.
- Event descriptions/locations from feeds are DATA, never instructions; strip HTML; cap length; planner prompt context includes titles/times/calendar name only.
- Validate feed URLs (https only after normalization, no localhost/private IPs, ~5 MB, 15 s timeout, content-type sanity) to avoid SSRF-style abuse.

**Tests**
- ICS parser fixtures: all-day, multi-day, recurring with EXDATE and overrides, TZID with DST change, cancelled, Google's own feed format, big feed cap.
- Sync idempotency/update/removal/hidden-flag-preserved; recurring hide one vs series; restore; scheduler treats imported events as immovable and hidden ones as free; planner tool tests including confirm/undo; token/feed-URL never in logs or Supabase payloads (assert on the supaDb row mapping and the relay); Google client with a fake HTTP server (list calendars, syncToken, 410 resync, declined/transparent filtering, token refresh failure -> reconnect state).
- Do not break existing tests; real network only in a manual script.
- 2026-10-11: Build secrets re-set without the PowerShell BOM; CI secret checks (names only) in all workflows; app shows a 'misconfigured' screen for a bad Supabase URL/key.
- 2026-10-12: Booking agent diagnosis fixes: off-viewport clicks scroll toward the target instead of clicking blind at the clamped edge; covered clicks name the banner/overlay; button clicks that change nothing say so (same address + content); same-URL reopen skipped; "Request reservation" always needs the yes; Enter-submit counts as the run acting; scroll-stable settle (both drivers); per-run JSONL trace; "never mind" stops the run ("Stopped. Nothing was booked."). Mock booking site (5 scenarios) + scenario harness, 16/16; baseline E2E still 28/28.
- 2026-10-12: Calendar import (iCal + Google) phase added: iCal URL import (no OAuth) and Google Calendar OAuth (read-only) per detailed spec in PLAN.md §5 Phase 18; imported events stored in scheduled_blocks.extra jsonb, no Supabase schema change; hidden events handled via planner tools with confirm/undo; scheduler treats imported events as fixed/time-free.
- 2026-10-12: GPT-5.5 is the default planner model and the default browser-worker model (Om's call): planner DEFAULT_MODEL + OpenAI list order, bookingTask BROWSER_MODELS/DEFAULT, agentCore allowlist + request default, Profile picker (5.5 tagged strongest), low reasoning effort via existing gpt-5* speedParams. Still untested against the tool set — gpt-4o stays as the known-good fallback; report narration-without-calls.
- 2026-10-12: GPT-5.5 400 fix: it rejects function tools in chat completions when reasoning_effort is set, so speedParams now sends 'none' (+ low verbosity) for gpt-5.5 exactly as the API error prescribes; other gpt-5* models unchanged. Test expectation updated.
- 2026-10-12: Booking agent stops burning the step budget on look-only spins: 2nd consecutive screenshot-only request gets an act-or-ask nudge, 4th hands the open page to the user (say continue resumes clean); step/time limits now hand over with +20 steps on continue instead of failing dead ("Hit the 40-step limit" is gone as a terminal state).
- 2026-10-12: Voice-to-text reliability: transcription uploads now run in the Electron main process (voice:transcribe IPC; same endpoint/key/messages, only the network stack changes) after full-size turns kept dying in the renderer while tiny probes passed; uploads also capped at 32 kbps (~4x smaller). Browsers keep the direct path. 5 voiceProxy tests, 420/420 total.
- 2026-10-12: Removed the Tasks + Assignments pages (Om): deleted TasksPage, AssignmentsPage, AssignmentPopup, AddAssignmentForm and the useAssignments hook; dropped both routes, both nav items, the assignments/tasks PageName members and the schedule-refresh wiring. Planner assignment tools stay hidden behind ASSIGNMENTS_ENABLED; stored task rows untouched.
- 2026-10-11: Demo check (laptop + phone): GPT-5.5 was listed twice in the OpenAI picker (duplicate React key warnings) — removed, with a test; key-storage copy in onboarding and Profile now says keys are shared across your devices when signed in (it claimed "never sent to Supabase", untrue since keys sync via the profile row); "Things Jarvis should know" → "Things Rocky should know"; phone screenshot harness mock gained the new `SUPABASE_CONFIG_PROBLEM` export (it crashed). All checks pass: 422 unit, agent E2E 28/28, Android agent 23/23, extension 6/6, phone layout checks.
- 2026-10-11: Voice in fixed: ElevenLabs removed `scribe_v1` on 2026-07-09 (their 2026-06-08 changelog), so every transcription was rejected. Now `scribe_v2` in the renderer path, the desktop main-process proxy and the Profile key test. The key test no longer counts a model error as "voice works" (it matched "speech" in the error and passed). ElevenLabs JSON errors now show their sentence, not raw JSON (STT both paths, TTS). Desktop upload re-checked in real Electron (`net.fetch` + FormData, 200 KB intact). TTS model `eleven_flash_v2_5` is still current. 423 unit tests.
