/**
 * Features that ship with student mode rather than the everyone build.
 *
 * ASSIGNMENTS_ENABLED gates the assistant's assignment tools only. The
 * Assignments/Tasks pages, their nav items, the hook and the form/popup
 * components were removed (2026-10-12); stored task rows are untouched.
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
