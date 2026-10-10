# Rocky Calendar

A voice-driven personal calendar. You talk, an OpenAI-backed planner reasons over your real
week, edits the schedule, and the views update live. Everything lives on your machine.

```bash
npm install
npm run dev            # http://localhost:8080
```

There is no server and no cloud database. On first run the app walks you through onboarding,
where you paste an OpenAI API key (and optionally an ElevenLabs key for a better voice).

## How it fits together

```
browser / desktop app
  ├── Dexie (IndexedDB)          calendar, assignments, commitments, preferences, profile
  ├── planner  (src/lib/plannerLocal.ts)   OpenAI tool loop, runs client-side
  │     └── 12 tools (src/lib/plannerTools.ts) → Dexie
  ├── voice in   Web Speech API (browser) · OpenAI transcription (desktop)
  └── voice out  ElevenLabs if a key is set, otherwise the system voice
```

## Data model

`shared/db.ts` defines the row shapes; `src/lib/db.ts` is the Dexie database.

- `fixed_commitments` — classes, shifts, standing appointments. Never moved by the assistant.
- `tasks` — work needing a slot. Assignments are tasks with a deadline.
- `scheduled_blocks` — anything occupying time. `previous_start_time` drives the
  "moved from" annotation; `source_id` links a block to its task.
- `preferences` — earliest start, latest end, buffer after fixed events, preferred study hours.
- `profiles` — single `local` row: name, model, voice, about text, key storage.

`EventBlock` (what the views render) is assembled in `src/lib/schedule.ts` from
`scheduled_blocks` plus the `fixed_commitments` matching that weekday. `status` is computed
against the wall clock; `tag` is `moved` when `previous_start_time` is set and `new` for
blocks created in the last five minutes.

## The planner

`src/lib/plannerLocal.ts` runs the tool loop in the browser (max 8 rounds). Its tools, in
`src/lib/plannerTools.ts`, are real database operations:

| Tool | Does |
| --- | --- |
| `get_week_schedule` / `get_pending_tasks` | Read the week, read unscheduled and blocked work |
| `add_task` / `add_one_off_event` | Record work; place a fixed event (then resolve conflicts) |
| `find_open_slot` | Honours preferences, buffers, commitments and existing blocks |
| `move_task_to_slot` / `reschedule_block` / `delete_block` | Move or remove, recording where it came from |
| `add_assignment` / `add_assignment_part` | Chunk an assignment across slots, or place one session |
| `add_note_to_block` | Attach a short summarised note |
| `flag_unresolvable_conflict` | The one case the model surfaces as a question |

Conflict resolution (`src/lib/scheduling.ts`) reschedules displaced *task* blocks
lowest-priority-first into the next slot that still meets each task's deadline; anything
that won't fit is flagged rather than dropped. `pickSlot` is pure and DB-free so it can be
tested in isolation. Spoken weekday names resolve from an `upcoming_dates` map, and the write
tools refuse past dates and anything overlapping a fixed commitment.

## Voice

`src/hooks/useAssistant.ts` drives `idle → listening → thinking → speaking → idle`.
End-of-turn detection lives in `src/lib/speech.ts`: recognition runs continuously and
restarts across Chrome's own auto-stops, so a pause mid-sentence never ends your turn — only
a real silence does (2s hands-free, 2.6s tap-to-talk). Tapping the mic while listening
finishes the turn rather than discarding it.

## Not built yet

Wake word, streaming/interruptible voice, external calendar sync (Google Calendar/Canvas).

## Desktop (macOS)

Rocky runs as a native Mac app via Electron.

```bash
npm run electron:dev   # build the renderer and launch the app
npm run build:mac      # produce release/Rocky Calendar-<version>-arm64.dmg
```

**How the desktop build differs from the browser build**

| Concern | Desktop | Browser |
| --- | --- | --- |
| Page origin | Custom `app://rocky` scheme (real origin, so CORS to OpenAI/ElevenLabs and mic permissions behave) | `http://localhost` |
| Voice input | Records with MediaRecorder, transcribes via OpenAI `gpt-4o-mini-transcribe` | Web Speech API |
| API keys | Encrypted in the macOS Keychain via Electron `safeStorage` | Dexie (IndexedDB) |
| Calendar data | Dexie, same as browser | Dexie |

**Why voice input differs:** Electron ships without Google’s speech service keys, so
`webkitSpeechRecognition` fails there with a network error — there is no flag that turns it
on. `src/lib/transcribe.ts` records the turn and transcribes it instead, reusing the same
patient end-of-turn timing as the Web Speech path. `startRecognition` picks the right one at
runtime, so nothing above it changes.

**Keys** move out of Dexie into the Keychain the first time the desktop app reads them
(`src/lib/secrets.ts`). Read every key through `getSecret` — reading `profile.llm_key_enc`
directly will come back empty on desktop after that migration.

The build is **unsigned**. On another Mac, Gatekeeper will block it until the user
right-clicks the app and chooses Open. Signing needs an Apple Developer certificate.

## Landing page

`landing/` is the public coming-soon site — one self-contained `index.html`, no build step.
Preview it with `npx serve landing`, deploy it to Vercel with **Root Directory = `landing`**.

It has no download link and no link to the app by design. To turn on the email waitlist,
set `WAITLIST_ENDPOINT` at the top of the script to a Formspree/Tally POST URL; while it is
empty every call to action renders as an inert "Coming soon" pill.

The app itself is no longer published to GitHub Pages — `.github/workflows/deploy.yml` now
only publishes a redirect to the landing site, and only when run manually.

## Security

**Keys never belong to the app.** Rocky is bring-your-own-key: each user pastes their
own provider key, it is stored in the macOS Keychain (desktop, via Electron `safeStorage`)
or Dexie (browser), and requests go straight from their machine to the provider. There is
no server and no shared key, so there is no balance of yours for anyone to drain. Keep it
that way — the moment a backend holds your key, it needs auth, per-user rate limits and
spend caps before it ships.

**Never prefix a secret with `VITE_`.** Vite inlines those into the bundle, where anyone can
read them. The build currently contains no secrets of any kind.

**Pre-commit hook** (`.githooks/pre-commit`, enabled via `git config core.hooksPath
.githooks`) refuses to commit OpenAI/Anthropic/ElevenLabs/AWS/GitHub credentials, JWTs,
private keys and `.env` files — including **base64-encoded** ones, which is how a live key
reached this repository history once already. Bypass with `--no-verify` only when certain.

**Content-Security-Policy** is attached to every packaged-app response in
`electron/main.cjs`: scripts from the bundle only, network access limited to
`api.openai.com` and `api.elevenlabs.io`, frames denied. Dev-server responses are exempt so
HMR keeps working. Navigation off the app origin is blocked and sent to the system browser.
The policy was verified by serving `dist/` under the identical header — the app renders with
zero violations.

**Set a spend cap** in the OpenAI dashboard anyway (Settings → Limits), with a separate
project and key per app. It is the only control that still holds if a key does leak.
