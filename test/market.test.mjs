import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReceipts, createSimulatedSettlement, makeIntentsPreview, openMarketRound, startingBalances } from "../src/market.mjs";

test("the installed SDK splits the pool and resumes an interrupted settlement", async () => {
  const round = await openMarketRound({ number: 1, agents: startingBalances });
  assert.equal(round.stages[0].quantity, "14");
  assert.ok(round.stages[1].bids.every(({ reveal }) => reveal === null));
  assert.deepEqual([...new Set(round.plan.payments.map(({ sellerId }) => sellerId))], ["fastlane", "northstar"]);
  const runner = await createSimulatedSettlement(round);
  const first = await runner.run();
  const interrupted = first.receipts.find((receipt) => receipt.broadcastUncertain);
  assert.ok(interrupted?.transactionHash);
  assert.equal(first.summary.paid, false);
  const resumed = await runner.run({ resume: true });
  assert.equal(resumed.summary.paid, true);
  assert.equal(resumed.prepared, round.plan.payments.length);
  assert.equal(resumed.sends, round.plan.payments.length);
  assert.equal(resumed.receipts.find(({ paymentId }) => paymentId === interrupted.paymentId).transactionHash, interrupted.transactionHash);
  assert.ok(resumed.audit.checks.every(({ matches }) => matches));
  const ledger = applyReceipts(startingBalances, round.stages[3], round.plan, resumed.receipts);
  assert.equal(ledger.find(({ id }) => id === "fastlane").stock, 0);
  for (const field of ["stock", "balance"]) {
    assert.equal(ledger.reduce((sum, agent) => sum + agent[field], 0),
      startingBalances.reduce((sum, agent) => sum + agent[field], 0));
  }
  const next = await openMarketRound({ number: 2, agents: ledger });
  assert.ok(next.stages[3].splitAllocation.lines.every(({ sellerId }) => sellerId !== "fastlane"));
});

test("buyer-signed caps gate the whole allocation and insufficient supply clears no payments", async () => {
  const round = await openMarketRound({ number: 1, agents: startingBalances });
  const runner = await createSimulatedSettlement(round, { holdFirst: false, lowerFirstCap: true });
  const first = await runner.run();
  assert.ok(first.receipts.filter(({ paymentId }) => JSON.parse(paymentId)[1] === "research")
    .every(({ status, transactionHash }) => status === "pending" && !transactionHash));
  assert.equal((await runner.run({ resume: true })).summary.paid, true);
  const empty = await openMarketRound({ number: 2, agents: startingBalances, tightSupply: true });
  assert.equal(empty.stages[3].splitAllocation, null);
  assert.deepEqual(empty.plan.payments, []);
});

test("the demo prepares an unsigned Intents request for each payment", async () => {
  const round = await openMarketRound({ number: 1, agents: startingBalances });
  const requests = makeIntentsPreview(round.plan);
  assert.equal(requests.length, round.plan.payments.length);
  assert.equal(requests[0].recipient, "intents.near");
  assert.equal(requests[0].message.intents[0].intent, "transfer");
  assert.equal(requests[0].message.signer_id, "research.swarmkit.near");
  assert.ok(requests[0].message.intents[0].tokens["nep141:wrap.near"]);
});
