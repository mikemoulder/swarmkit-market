import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sqliteStore } from '../scripts/store.mjs';
import { marketController } from '../src/controller.mjs';
import { createMarketServer } from '../scripts/server.mjs';

function temporaryStore() { return sqliteStore(join(mkdtempSync(join(tmpdir(), 'swarmkit-market-')), 'state.sqlite')); }
test('a process killed after durable broadcast recovers the original payment without duplicate ledger entries', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'swarmkit-crash-')), 'state.sqlite');
  const worker = fileURLToPath(new URL('./restart-worker.mjs', import.meta.url));
  const crashed = spawnSync(process.execPath, [worker, path, 'crash'], { encoding: 'utf8' });
  assert.equal(crashed.status, 73, crashed.stderr);
  const beforeStore = sqliteStore(path);
  const before = (await beforeStore.read()).value;
  const firstHash = Object.keys(before.sent)[0];
  assert.ok(firstHash);
  beforeStore.close();
  const resumed = spawnSync(process.execPath, [worker, path, 'resume'], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  const view = JSON.parse(resumed.stdout);
  assert.ok(view.settled);
  assert.ok(view.receipts.some(r => r.transactionHash === firstHash));
  assert.equal(view.prepared, view.plan.payments.length);
  assert.equal(view.broadcasts, view.plan.payments.length);
  assert.equal(view.accounting.money, view.accounting.initialMoney);
  assert.equal(view.accounting.stock, view.accounting.initialStock);
  const store = sqliteStore(path);
  const state = (await store.read()).value;
  assert.equal(new Set(state.applied).size, state.plan?.payments.length ?? view.plan.payments.length);
  store.close();
});

test('twelve rounds adapt prices, conserve accounted funds and inventory, and remain reproducible', async () => {
  const run = async () => {
    const store = temporaryStore(), controller = marketController(store);
    try {
      let view = await controller.command('create', { id: 'repeatable', scenario: 'normal' });
      while (view.number < 13) view = await controller.command('advance');
      assert.ok(view.history.every(r => r.quantity > 0));
      assert.ok(new Set(view.history.map(r => r.total)).size > 1);
      assert.equal(view.accounting.money, view.accounting.initialMoney + view.accounting.income - view.accounting.productionCosts);
      assert.equal(view.accounting.stock, view.accounting.initialStock + view.accounting.produced - view.accounting.consumed);
      assert.ok(view.agents.every(a => a.balance >= 0 && a.stock >= 0));
      assert.ok(view.history.every(r => r.baseline === null || r.total <= r.baseline));
      return view.history;
    } finally { store.close(); }
  };
  assert.deepEqual(await run(), await run());
});

test('no-sale, missing reveal and buyer approval scenarios remain inspectable', async () => {
  for (const configuration of [{ supply: 'tight' }, { scenario: 'missing' }, { scenario: 'approval' }]) {
    const store = temporaryStore(), controller = marketController(store);
    try {
      let view = await controller.command('create', configuration);
      while (view.stage !== 'closed') view = await controller.command('advance');
      if (configuration.supply) assert.equal(view.plan.payments.length, 0);
      if (configuration.scenario === 'missing') assert.equal(view.explanation.sellers.find(s => s.sellerId === 'seller-1').reason, 'missing-reveal');
      if (configuration.scenario === 'approval') {
        view = await controller.command('advance');
        assert.ok(view.interrupted);
        const buyer = view.plan.payments[0].buyerId;
        assert.ok(view.receipts.filter(r => JSON.parse(r.paymentId)[1] === buyer).every(r => !r.transactionHash));
        view = await controller.command('resume');
        assert.ok(view.settled);
      }
    } finally { store.close(); }
  }
});

test('policy edits persist before demand, freeze afterwards, and SQLite rejects stale writes', async () => {
  const store = temporaryStore(), controller = marketController(store);
  try {
    await controller.command('create');
    await controller.command('configure-agent', { agentId: 'buyer-1', requested: 4, limit: 7 });
    let configured = await controller.read();
    assert.equal(configured.agents.find(a => a.id === 'buyer-1').requested, 4);
    await controller.command('advance');
    await assert.rejects(controller.command('configure-agent', { agentId: 'buyer-1', requested: 2, limit: 1 }), /frozen/);
    const view = await controller.command('advance');
    assert.equal(view.stage, 'commit');
    assert.ok(view.snapshot.bids.every(b => !b.reveal));
    assert.ok(!JSON.stringify(view).includes('sealedOffers'));
    const { value, revision } = await store.read();
    await store.write(value, revision);
    await assert.rejects(store.write(value, revision), /conflict/);
  } finally { store.close(); }
});

test('local coordinator requires an operator token and rejects cross-origin mutations', async () => {
  const store = temporaryStore();
  const launched = [];
  const server = createMarketServer({ store, token: 'test-operator', jobs: {
    read: async () => ({ status: 'idle' }),
    start: async scenario => { launched.push(scenario); return { status: 'running' }; },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = headers => fetch(url + '/api/command', { method: 'POST', headers, body: JSON.stringify({ command: 'create' }) });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: 'Bearer test-operator', origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ authorization: 'Bearer test-operator' })).status, 200);
    const view = await (await fetch(url + '/api/state')).json();
    assert.equal(view.stage, 'ready');
    assert.equal(view.snapshot.buyers.length, 0);
    assert.equal((await fetch(url + '/api/session')).status, 403);
    const launch = headers => fetch(url + '/api/testnet', { method: 'POST', headers, body: JSON.stringify({ configuration: { scenario: 'split' } }) });
    assert.equal((await launch({})).status, 401);
    assert.equal((await launch({ authorization: 'Bearer test-operator', origin: 'https://example.com' })).status, 403);
    assert.deepEqual(launched, []);
    assert.equal((await launch({ authorization: 'Bearer test-operator' })).status, 202);
    assert.deepEqual(launched, ['split']);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
