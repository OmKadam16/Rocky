# Rules for agents working on Rocky (read PLAN.md first)

1. Work only in `C:\Rocky` on the `main` branch. Never create branches, never merge, never force push.
2. Before starting: `git pull`. After finishing: run the checks in PLAN.md section 7, then commit and push to `main`.
3. Follow PLAN.md phases in order. Do one phase at a time and report to Om when it is done.
4. Never commit secrets: `.env.local`, API keys, the Gemini key, the Supabase service-role key.
   Never paste keys into code or chat. Server keys go in Supabase secrets, set by Om.
5. API keys entered by users stay on the device (see `localOnly` in `src/lib/supaDb.ts`). Memory content never goes to Supabase.
6. Fixed commitments never move. Only flexible tasks get rescheduled.
7. Schema changes need a new migration file + a test + a note in PLAN.md, and Om's OK first.
8. Keep the current look: minimal, lots of white space, existing fonts/colors and `ThemeToggle`.
9. Do not run `npm audit fix --force`. Do not add big new dependencies without asking.
10. If something is unclear, stop and ask Om. Do not invent features.
11. When you finish a task, tick it in PLAN.md section 4/5 and add a line to the changelog.
