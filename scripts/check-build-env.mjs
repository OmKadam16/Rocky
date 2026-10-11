// CI guard: node scripts/check-build-env.mjs NAME [NAME...]
// Fails if any named env var is empty, non-ASCII, or has surrounding
// whitespace. Prints only the NAME and the problem, never the value.
import { envValueProblem } from "../shared/envCheck.mjs";

const names = process.argv.slice(2);
let bad = 0;
for (const name of names) {
  const problem = envValueProblem(process.env[name]);
  if (problem) {
    bad++;
    console.log(`::error title=Bad secret ${name}::${name} ${problem}. Re-set it (no BOM, no newline): see docs/RELEASING.md.`);
  } else {
    console.log(`${name}: ok`);
  }
}
process.exit(bad ? 1 : 0);
