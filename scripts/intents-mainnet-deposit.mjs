// Moves real mainnet funds: wraps 0.01 NEAR into wNEAR and deposits it into the NEAR Intents Verifier
// (intents.near) for the buyer created by intents-mainnet-setup.mjs. Run it yourself:
//   node scripts/intents-mainnet-deposit.mjs --mainnet-funds
// Steps: register wNEAR storage (0.00125 NEAR, once) -> near_deposit 0.01 NEAR -> ft_transfer_call to intents.near.
import { readFile } from 'node:fs/promises';
import { Account, JsonRpcProvider } from 'near-api-js';
import { NEAR } from 'near-api-js/tokens';

if (!process.argv.includes('--mainnet-funds')) throw new Error('This moves real NEAR on mainnet. Re-run with --mainnet-funds to confirm.');
const RPC = process.env.NEAR_MAINNET_RPC ?? 'https://rpc.mainnet.near.org';
const AMOUNT = NEAR.toUnits('0.01');                  // wNEAR to place in the Verifier
const STORAGE = 1_250_000_000_000_000_000_000n;      // wrap.near storage_balance_bounds.min

const { buyer } = JSON.parse(await readFile('.market/intents-mainnet/accounts.json', 'utf8'));
const provider = new JsonRpcProvider({ url: RPC });
const account = new Account(buyer.accountId, provider, buyer.secretKey);
const view = (contractId, method, args) => provider.callFunction({ contractId, method, args });

const { balance } = await account.getState().catch(() => { throw new Error(`Buyer ${buyer.accountId} has no NEAR yet. Send ~0.1 NEAR to it first.`); });
const available = BigInt(balance.available);
console.log(`Buyer ${buyer.accountId} has ${NEAR.toDecimal(available, 4)} NEAR available.`);
if (available < AMOUNT + STORAGE + NEAR.toUnits('0.01')) throw new Error('Not enough NEAR: send at least 0.05 NEAR to the buyer.');

if (!(await view('wrap.near', 'storage_balance_of', { account_id: buyer.accountId }))) {
  await account.callFunction({ contractId: 'wrap.near', methodName: 'storage_deposit', args: { account_id: buyer.accountId, registration_only: true }, deposit: STORAGE, gas: 30_000_000_000_000n });
  console.log('Registered wNEAR storage (0.00125 NEAR).');
}
await account.callFunction({ contractId: 'wrap.near', methodName: 'near_deposit', args: {}, deposit: AMOUNT, gas: 30_000_000_000_000n });
console.log(`Wrapped ${NEAR.toDecimal(AMOUNT)} NEAR into wNEAR.`);
await account.callFunction({ contractId: 'wrap.near', methodName: 'ft_transfer_call', args: { receiver_id: 'intents.near', amount: String(AMOUNT), msg: '' }, deposit: 1n, gas: 100_000_000_000_000n });

const inVerifier = await view('intents.near', 'mt_balance_of', { account_id: buyer.accountId, token_id: 'nep141:wrap.near' });
console.log(`Deposited into intents.near. Buyer's Verifier balance: ${NEAR.toDecimal(BigInt(inVerifier))} wNEAR.`);
