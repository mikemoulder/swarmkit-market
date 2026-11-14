// One real NEAR Intents settlement for the accounts made by intents-mainnet-setup.mjs.
//   node scripts/intents-mainnet-run.mjs --prepare    build a sealed SDK round: buyer pays seller 0.001 wNEAR (no funds move)
//   node scripts/intents-mainnet-run.mjs --review     print the exact settlement plan (no funds move)
//   node scripts/intents-mainnet-run.mjs --preflight  sign the NEP-413 intent locally and simulate it on intents.near (no funds move)
//   node scripts/intents-mainnet-run.mjs --execute    settle it on mainnet through scripts/intents.mjs (moves 0.001 wNEAR)
//   node scripts/intents-mainnet-run.mjs --reconcile  check the journaled transaction without signing anything new
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { base58 } from '@scure/base';
import { simulateProcurement, cheapestCapacity, settlementPlanFromTranscript, prepareNearIntentsTransfers, readNearIntentsSalt, signNearIntentsTransfers, INTENTS_VERIFIER } from 'near-swarmkit';

const dir = join('.market', 'intents-mainnet');
const RPC = process.env.NEAR_MAINNET_RPC ?? 'https://rpc.mainnet.near.org';
const ASSET = 'nep141:wrap.near';
const PRICE = '1000000000000000000000';   // 0.001 wNEAR for one unit
const mode = ['--prepare', '--review', '--preflight', '--execute', '--reconcile'].find(m => process.argv.includes(m));
if (!mode) throw new Error('Choose --prepare, --review, --preflight, --execute or --reconcile.');
const { buyer, seller } = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'));
const roundFile = join(dir, 'round.json'), configFile = join(dir, 'config.json');

if (mode === '--prepare') {
  const { transcript, plan } = await simulateProcurement({
    seed: 2026, mechanism: cheapestCapacity,
    spec: { id: `gpu-coop-intents-${Date.now()}`, mechanismId: cheapestCapacity.id, asset: ASSET,
      resource: { label: 'H100 GPU hours', unit: 'hour', deliveryWindow: 'Next week' },
      demandCloses: 10, commitCloses: 20, revealCloses: 30 },
    buyers: [{ id: buyer.accountId, demand: () => ({ quantity: '1', budget: PRICE }) }],
    sellers: [{ id: seller.accountId, offer: () => ({ capacity: '1', unitPrice: PRICE }) }],
  });
  await writeFile(roundFile, JSON.stringify({ transcript }, null, 2));
  await writeFile(configFile, JSON.stringify({
    relayerId: buyer.accountId, rpcUrl: RPC,
    buyerKeyEnv: { [buyer.accountId]: 'SWARMKIT_INTENTS_BUYER_KEY' }, relayerKeyEnv: 'SWARMKIT_INTENTS_BUYER_KEY',
    maxBuyerAmounts: { [buyer.accountId]: PRICE },
  }, null, 2));
  console.log(JSON.stringify({ round: transcript.spec.id, payments: plan.payments.map(p => ({ from: p.buyerId, to: p.sellerId, amountWNear: '0.001' })) }, null, 2));
} else if (mode === '--preflight') {
  const { transcript } = JSON.parse(await readFile(roundFile, 'utf8'));
  const plan = await settlementPlanFromTranscript(transcript, cheapestCapacity);
  const key = KeyPair.fromString(buyer.secretKey);
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const str = s => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };
  const requests = prepareNearIntentsTransfers(plan, { salt: await readNearIntentsSalt(RPC), deadline: new Date(Date.now() + 5 * 60_000) });
  const args = await signNearIntentsTransfers(requests, async ({ message, nonce, recipient }) => {
    const digest = createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), str(message), Buffer.from(nonce, 'base64'), str(recipient), Buffer.from([0])])).digest();
    return { publicKey: key.getPublicKey().toString(), signature: 'ed25519:' + base58.encode(key.sign(digest).signature) };
  });
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
    request_type: 'call_function', finality: 'final', account_id: INTENTS_VERIFIER, method_name: 'simulate_intents', args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  const body = await response.json();
  if (body.result?.result) {
    const simulation = JSON.parse(Buffer.from(body.result.result).toString());
    const ok = simulation.invariant_violation == null && simulation.intents_executed?.length === 1;
    console.log(JSON.stringify({ preflight: ok ? 'passed' : 'failed', intentsExecuted: simulation.intents_executed?.length ?? 0, invariantViolation: simulation.invariant_violation ?? null }, null, 2));
  } else console.log(JSON.stringify({ preflight: 'rejected by the Verifier', reason: String(body.result?.error ?? JSON.stringify(body.error)).slice(0, 300) }, null, 2));
} else {
  const action = { '--review': '--review', '--execute': '--execute', '--reconcile': '--reconcile' }[mode];
  const run = spawnSync(process.execPath, ['scripts/intents.mjs', roundFile, configFile, action], {
    stdio: 'inherit', env: { ...process.env, SWARMKIT_INTENTS_BUYER_KEY: buyer.secretKey },
  });
  process.exit(run.status ?? 1);
}
