/**
 * Features that ship with student mode rather than the everyone build.
 *
 * Flip ASSIGNMENTS_ENABLED to true to restore the Assignments page, its nav
 * item, the dashboard sections and the assistant's assignment tools. Nothing
 * is deleted while it is false — the page, the hook, the tool handlers and
 * every stored row stay exactly where they are.
 */
export const ASSIGNMENTS_ENABLED = false;

/**
 * In-app updates need a signed build: macOS routes the install through
 * Squirrel.Mac, which refuses to replace an app it cannot verify. Rocky is a
 * personal build installed with `npm run install:app`, so the check button
 * could only ever fail — the card shows the version and nothing more.
 *
 * Flip to true alongside a Developer ID signature and a published release
 * feed; the whole updater is still wired up behind it.
 */
export const UPDATES_ENABLED = false;
