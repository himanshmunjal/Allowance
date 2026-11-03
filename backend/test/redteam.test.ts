import "./helpers";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closeDb } from "./helpers";
import { queryOne } from "../src/lib/db";
import { runRedTeam } from "../src/lib/redteam";
import type { AttackReport } from "../src/shared/types";

// Every Attack Lab scenario must hold. With no AI key configured, "ai" attacks exercise the fail-safe.

describe("Attack Lab", () => {
  let report: AttackReport;

  before(async () => {
    report = await runRedTeam({ useAi: false });
  });
  after(closeDb);

  it("stops every attack", () => {
    const failed = report.results.filter((r) => !r.defended).map((r) => `${r.id}: ${r.outcome}`);
    assert.deepEqual(failed, []);
    assert.equal(report.defended, report.total);
    assert.ok(report.total >= 15);
  });

  it("leaves nothing behind", async () => {
    const left = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM users WHERE email LIKE '%@lab.allowance.invalid'");
    assert.equal(left?.n, 0);
    const txs = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM transactions WHERE source = 'lab'");
    assert.equal(txs?.n, 0);
  });

  it("never lets a blocked attack move money", () => {
    for (const r of report.results.filter((x) => x.outcome.startsWith("blocked"))) assert.equal(r.autoPaid, 0, r.id);
  });
});
