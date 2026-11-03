import { runRedTeam } from "../src/lib/redteam";

// `npm run redteam`: the Attack Lab in a terminal (D-065). Needs DATABASE_URL; PayPal is never called.
// Uses your configured AI for the one "ai" attack; with no key it shows the fail-safe instead.

const report = await runRedTeam();
for (const r of report.results) {
  console.log(`${r.defended ? "✓ stopped" : "✕ GOT THROUGH"}  [${r.layer}] ${r.title}`);
  console.log(`    ${r.outcome}`);
}
console.log(`\n${report.defended}/${report.total} attacks stopped. No PayPal calls were made.`);
process.exit(report.defended === report.total ? 0 : 1);
