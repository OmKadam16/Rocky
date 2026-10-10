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

Rules:
- Fixed commitments never move. Only flexible tasks/blocks get rescheduled.
- API keys (`llm_key_enc`, `el_key_enc`) are `localOnly` in `supaDb.ts` and must never be sent to Supabase.
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
- [x] Phone remote: laptop shows QR + 6-char code (XXX-XXX, 5 min expiry) in Profile → Devices;
      phone opens `/remote`, signs in or pairs, sees the calendar, talks to Rocky.
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
3. Make sure the pairing QR code points to the **deployed** URL, not localhost
   (use `window.location.origin`, or a `VITE_PUBLIC_URL` if set).
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
