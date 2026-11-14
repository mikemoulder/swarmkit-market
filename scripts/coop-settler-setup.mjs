// Creates the NEAR testnet accounts behind the co-op's "Settle my share" button.
//   swarmkit-coop-<random>.testnet            parent, funded by the public testnet faucet
//   your-team.<parent>                        pays shares; its key goes into the Worker as SETTLER_KEY
//   atlas-compute.<parent> … northbeam.<parent>  the five providers' agent accounts that receive payments
// Keys are written to .market/coop-settler/<parent>.json (git-ignored, owner read only) and never printed.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import { NEAR } from 'near-api-js/tokens';

if (!process.argv.includes('--faucet-testnet')) throw new Error('Pass --faucet-testnet to create testnet accounts from the public faucet.');
const RPC = 'https://test.rpc.fastnear.com';
const PROVIDERS = ['atlas-compute', 'meridian-cloud', 'harbor-gpu', 'summit-cloud', 'northbeam'];
const parentId = `swarmkit-coop-${randomBytes(4).toString('hex')}.testnet`;
const parentKey = KeyPair.fromRandom('ed25519'), settlerKey = KeyPair.fromRandom('ed25519');

const faucet = await fetch('https://helper.testnet.near.org/account', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: parentId, newAccountPublicKey: parentKey.getPublicKey().toString() }),
  signal: AbortSignal.timeout(20_000),
});
if (!faucet.ok) throw new Error(`The testnet faucet returned HTTP ${faucet.status}. Try again in a minute.`);
console.log(`Created ${parentId} from the testnet faucet.`);

const provider = new JsonRpcProvider({ url: RPC });
const parent = new Account(parentId, provider, parentKey.toString());
for (let i = 0; i < 20; i++) { try { await parent.getState(); break; } catch { await new Promise(r => setTimeout(r, 1500)); } }
const { balance } = await parent.getState();
const available = BigInt(balance.available ?? balance.total ?? balance);
const providerFunding = NEAR.toUnits('0.02');
const settlerFunding = available - providerFunding * BigInt(PROVIDERS.length) - NEAR.toUnits('0.5');
if (settlerFunding <= NEAR.toUnits('1')) throw new Error(`The faucet funded only ${NEAR.toDecimal(available)} NEAR; not enough to continue.`);

await parent.createSubAccount({ accountOrPrefix: `your-team.${parentId}`, nearToTransfer: settlerFunding, publicKey: settlerKey.getPublicKey().toString() });
console.log(`Created your-team.${parentId} with ${NEAR.toDecimal(settlerFunding, 2)} NEAR.`);
for (const id of PROVIDERS) {
  await parent.createSubAccount({ accountOrPrefix: `${id}.${parentId}`, nearToTransfer: providerFunding, publicKey: parentKey.getPublicKey().toString() });
  console.log(`Created ${id}.${parentId}.`);
}

const directory = join('.market', 'coop-settler');
await mkdir(directory, { recursive: true });
const file = join(directory, `${parentId}.json`);
await writeFile(file, JSON.stringify({ network: 'testnet', parentId, parentKey: parentKey.toString(), settlerAccount: `your-team.${parentId}`, settlerKey: settlerKey.toString() }, null, 2), { mode: 0o600 });
await writeFile(join(directory, 'SETTLER_KEY'), settlerKey.toString(), { mode: 0o600 });
await chmod(file, 0o600).catch(() => {});

console.log(`
Done. Keys are in ${file} (keep it private; it is git-ignored).

Next, from the worker/ folder:
  1. Set PARENT_ACCOUNT in wrangler.jsonc to "${parentId}"
  2. npx wrangler secret put SETTLER_KEY < ../.market/coop-settler/SETTLER_KEY
  3. npx wrangler deploy
`);
