// Read-only: re-checks the mainnet Intents settlement with the SDK's own transport reconciliation and
// the audit, then writes public evidence (transcript, plan, receipt, Verifier balances). No keys are read.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nearIntentsTransport, auditSettlement, settlementPlanFromTranscript, cheapestCapacity } from 'near-swarmkit';

const [hash] = process.argv.slice(2);
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash ?? '')) throw new Error('Usage: node scripts/intents-mainnet-evidence.mjs <transaction hash>');
const RPC = 'https://rpc.mainnet.near.org';
const { transcript } = JSON.parse(await readFile(join('.market', 'intents-mainnet', 'round.json'), 'utf8'));
const plan = await settlementPlanFromTranscript(transcript, cheapestCapacity);
const payment = plan.payments[0];
const verifier = nearIntentsTransport({
  asset: plan.asset, relayerId: payment.buyerId, rpcUrl: RPC,
  signIntent: () => { throw new Error('read-only'); }, signTransaction: () => { throw new Error('read-only'); },
});
const status = await verifier.inspect(Object.freeze({ ...payment }), hash);
const audit = await auditSettlement(transcript, [{ paymentId: payment.id, status, transactionHash: hash }], { mechanism: cheapestCapacity, verifier });
const balance = async account => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: {
    request_type: 'call_function', finality: 'final', account_id: 'intents.near', method_name: 'mt_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: account, token_id: plan.asset })).toString('base64') } }) })).json();
  return JSON.parse(Buffer.from(r.result.result).toString());
};
const evidence = {
  network: 'mainnet', execution: 'near-intents', verifier: 'intents.near', checkedAt: new Date().toISOString(),
  transactionHash: hash, explorer: `https://nearblocks.io/txns/${hash}`,
  status, auditMatches: audit.checks.every(c => c.matches), verifiedSummary: audit.verifiedSummary,
  verifierBalancesAfter: { buyer: await balance(payment.buyerId), seller: await balance(payment.sellerId) },
  transcript, plan,
};
await writeFile(join('public', 'intents-mainnet.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ status, auditMatches: evidence.auditMatches, paid: audit.verifiedSummary.paid, verifierBalancesAfter: evidence.verifierBalancesAfter }, null, 2));
