# Rocky on Android: manual device tests

Run these on a real phone after installing a new APK (debug from the
`Android debug APK` workflow artifact, or a release from
`rocky-android-releases`). Automated coverage is in `npm test`
(driver, updater, tabs), `npm run test:agent-android` (agent against the fake
booking site through a mocked plugin) and the Kotlin unit test
`AgentCoordsTest` (runs in the Android CI workflow).

## Install and sign in
1. Allow "Install unknown apps" for the browser / file manager you use, open the APK, install.
2. Open Rocky: splash in the app's canvas colour (light or dark with the phone), then sign-in.
3. Sign in with the same email and password as on the laptop (the APK must be built with the
   `VITE_SUPABASE_*` secrets, otherwise there is no sign-in). Kill the app and reopen: still signed in.
4. "Forgot password" email: the link opens Rocky (needs the Supabase redirect URL
   `com.rocky.calendar.android://auth`).

## Pair and the two tabs
5. Pairing is still a code, after sign-in (one code per account; no site address to type):
   - Laptop: open Rocky → Profile → Devices; note the 8-character pairing code. Keep Rocky open.
   - Phone: "Pair with your laptop." → Enter code → type the 8 characters → "Connecting to your
     laptop…" → "You're connected." → Open calendar.
   - Wrong or old code: a clear message, the code stays in the boxes. Unpair (phone settings) and
     pair again works; signing out keeps the pairing.
6. Calendar tab: today, chip "Laptop online", day/week, week strip; rotate the phone (no broken layout).
7. Back button: Chat → Calendar; on Calendar → the app goes to the background.
8. Chat tab: type "add gym tomorrow at 7 PM" → receipt with Undo; it shows on the laptop.
9. Mic: tap, allow the microphone the first time, say "what do I have tomorrow"; Rocky says "One moment" and the reply is spoken without a second tap.
10. Keyboard: tap the message box; the tab bar hides, the box stays above the keyboard.
11. Airplane mode: offline banner; back online: the banner goes and the calendar refreshes.
12. Leave the app 1 minute, come back: the calendar refreshes, the chip is right.

## Booking with the laptop closed (on-phone agent)
13. Close the laptop lid. In Chat: "book a table for 2 at <a restaurant> on Saturday at 7 PM".
14. Rocky reads the plan back; say yes. The booking page opens full screen with
    "Rocky is driving" and Stop; the screen stays on.
15. When Rocky asks something, the page steps aside; answer in Chat; the page comes back.
16. CAPTCHA or payment: Rocky says it's your turn; solve it in the page, tap "Rocky", say "continue".
17. A texted code for the booking's phone number: say the digits; they appear as dots.
18. Final step: Rocky asks for a yes before the last click; say yes.
19. Done: "Booked. Reference …" only when the page shows a confirmation; the hold on the calendar is renamed.
20. Stop mid-run: tap Stop → "Stopped"; the hold is removed.
21. Start a booking, swipe Rocky away from recents mid-run, reopen: the hold says "booking failed - finish by hand".

## Updates
22. Publish a web-only release (`android-v<next>`), reopen the app twice: "Updated to x.y.z".
23. Publish a release with `rocky.androidMinNative` bumped: "Update available (x.y.z, N MB)" →
    Update → allow installs from Rocky once → Android's installer → Install.
