import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRound, cheapestCapacity } from 'near-swarmkit';
import { createCoop, setRequest, runWeek, startShock, YOU } from '../src/coop-economy.mjs';

async function weeks(state, n, outageAt) {
  const reports = [];
  for (let w = 1; w <= n; w++) {
    if (w === outageAt) state = startShock(state);
    state = await runWeek(state);
    reports.push(state.report);
  }
  return { state, reports };
}

test('the same seed and request give the same weeks', async () => {
  const a = await weeks(createCoop(7), 6, 3), b = await weeks(createCoop(7), 6, 3);
  assert.deepEqual(a.state.history, b.state.history);
  assert.deepEqual(a.state.feed, b.state.feed);
});

test('no team spends over its weekly budget, and every served team gets exactly the hours it asked for', async () => {
  const { reports } = await weeks(createCoop(2026), 8, 4);
  for (const r of reports) {
    const asked = new Map(r.demand.map(d => [d.id, d]));
    const got = new Map();
    const spent = new Map();
    for (const l of r.lines) {
      got.set(l.buyerId, (got.get(l.buyerId) ?? 0) + l.hours);
      spent.set(l.buyerId, (spent.get(l.buyerId) ?? 0) + l.amount);
    }
    for (const [id, hours] of got) {
      assert.equal(hours, asked.get(id).hours, `${id} is filled exactly`);
      assert.ok(spent.get(id) <= hours * asked.get(id).cap, `${id} spent ${spent.get(id)} over its budget`);
    }
    assert.equal(r.payments.reduce((t, p) => t + p.amount, 0), r.total, 'the settlement plan pays exactly the allocation');
  }
});

test('your request is respected, and a top price below the market releases you instead of overcharging', async () => {
  const served = (await weeks(setRequest(createCoop(2026), { name: 'Acme', hours: 40, cap: 320 }), 1)).reports[0];
  assert.equal(served.you.status, 'filled');
  assert.equal(served.you.hours, 40);
  assert.ok(served.you.amount <= 40 * 320 && served.you.saved > 0);
  const priced = (await weeks(setRequest(createCoop(2026), { name: 'Acme', hours: 40, cap: 150 }), 1)).reports[0];
  assert.equal(priced.you.status, 'released');
  assert.ok(!priced.lines.some(l => l.buyerId === YOU));
});

test('an outage raises the pool price and releases the lowest bidders, then the market recovers', async () => {
  const { state } = await weeks(createCoop(2026), 9, 4);
  const h = state.history, calm = h.slice(0, 3), outage = h.filter(x => x.outage);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.equal(outage.length, 3);
  assert.ok(mean(outage.map(x => x.price)) > mean(calm.map(x => x.price)));
  assert.ok(outage.some(x => x.short > 0));
  assert.ok(h.at(-1).short === 0, 'the pool is filled again after the outage');
});

test('every week replays from its SDK transcript to the same allocation', async () => {
  const { reports } = await weeks(createCoop(2026), 6, 3);
  for (const r of reports) {
    const replayed = await replayRound(r.transcript, cheapestCapacity);
    assert.equal(Number(replayed.splitAllocation.total), r.total);
  }
});
