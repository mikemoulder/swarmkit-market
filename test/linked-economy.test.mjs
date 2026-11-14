import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRound, cheapestCapacity } from 'near-swarmkit';
import { createEconomy, stepEconomy, startShock, sumCash } from '../src/linked-economy.mjs';

async function run(seed, ticks, shockAt) {
  let economy = createEconomy(seed);
  const rounds = [];
  for (let i = 1; i <= ticks; i++) {
    if (i === shockAt) economy = startShock(economy);
    economy = await stepEconomy(economy);
    rounds.push(economy.rounds);
  }
  return { economy, rounds };
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

test('the same seed and actions give the same two-market history', async () => {
  const a = await run(2026, 12, 5), b = await run(2026, 12, 5);
  assert.deepEqual(a.economy.history, b.economy.history);
  assert.deepEqual(a.economy.feed, b.economy.feed);
});

test('every credit is accounted for: cash equals opening plus income minus production cost', async () => {
  for (const seed of [1, 2026, 77]) {
    const { economy } = await run(seed, 20, 6);
    const { opening, income, production } = economy.ledger;
    assert.equal(sumCash(economy.agents), opening + income - production);
    for (const agent of Object.values(economy.agents).flat()) assert.ok(agent.cash >= 0, `${agent.id} went negative`);
  }
});

test('a GPU supply shock reaches the inference market only through agent decisions', async () => {
  const { economy } = await run(2026, 14, 6);
  const h = economy.history;
  const before = h.slice(2, 5), during = h.filter(x => x.shock), after = h.slice(9, 14);
  assert.equal(during.length, 4);
  assert.ok(mean(during.map(x => x.gpu.price)) > mean(before.map(x => x.gpu.price)), 'GPU price rises in the shock');
  assert.ok(mean(during.map(x => x.providerCost)) > mean(before.map(x => x.providerCost)), 'provider cost follows the GPU price');
  assert.ok(mean([...during, ...after].map(x => x.inference.price)) > mean(before.map(x => x.inference.price)), 'inference price follows provider cost');
  assert.ok(during.some(x => x.inference.shortfall > 0), 'some apps go short of inference');
});

test('every cleared round replays from its SDK transcript to the same allocation', async () => {
  const { rounds } = await run(2026, 10, 4);
  let checked = 0;
  for (const tick of rounds) for (const market of [tick.gpu, tick.inference]) {
    if (!market.transcript) continue;
    const replayed = await replayRound(market.transcript, cheapestCapacity);
    assert.equal(Number(replayed.splitAllocation.total), market.total);
    assert.equal(replayed.splitAllocation.lines.length, market.lines.length);
    for (const line of replayed.splitAllocation.lines) assert.ok(BigInt(line.quantity) > 0n);
    checked += 1;
  }
  assert.ok(checked >= 18);
});
