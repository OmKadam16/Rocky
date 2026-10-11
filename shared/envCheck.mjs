// Build-time config values (Supabase URL/key, phone URL, signing secrets) must
// be plain printable ASCII with no surrounding whitespace. A UTF-8 BOM from a
// Windows PowerShell pipe once got into the secrets: the minifier folded the
// app's .trim() at build time without removing U+FEFF, and fetch() rejected
// the header ("non ISO-8859-1 code point"). Shared by the app (startup check)
// and CI (scripts/check-build-env.mjs). Messages never include the value.

/** null when fine, else what is wrong (without the value). */
export function envValueProblem(value) {
  if (value == null || value === "") return "is empty";
  if (value.charCodeAt(0) === 0xfeff) return "starts with a byte-order mark (BOM)";
  if (/^\s|\s$/.test(value)) return "has leading or trailing whitespace";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c > 0x7e) return `has a non-ASCII character at position ${i + 1} (U+${c.toString(16).toUpperCase().padStart(4, "0")})`;
    if (c < 0x21) return `has a control or space character at position ${i + 1}`;
  }
  return null;
}

/** The first bad entry of [name, value] pairs, skipping empty values when allowEmpty. */
export function firstEnvProblem(entries, { allowEmpty = false } = {}) {
  for (const [name, value] of entries) {
    if (allowEmpty && (value == null || value === "")) continue;
    const problem = envValueProblem(value);
    if (problem) return { name, problem };
  }
  return null;
}
