// Creates two NEAR mainnet implicit accounts for one real NEAR Intents settlement:
//   buyer  - holds a little wNEAR in the Intents Verifier, signs the NEP-413 transfer intent, and relays it
//   seller - receives the payment inside the Verifier (its key is kept so the balance stays recoverable)
// An implicit account's ID is the hex of its ed25519 public key: it exists once it receives NEAR, costs
// nothing to create, and the Verifier recognises its own key without registration.
// Keys are written to .market/intents-mainnet/accounts.json (git-ignored, owner read only) and never printed.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { base58 } from '@scure/base';

const directory = join('.market', 'intents-mainnet');
const file = join(directory, 'accounts.json');
try { await access(file); throw new Error(`${file} already exists; refusing to overwrite keys that may hold funds.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const implicit = () => {
  const key = KeyPair.fromRandom('ed25519');
  const publicKey = key.getPublicKey().toString();
  const accountId = Buffer.from(base58.decode(publicKey.slice('ed25519:'.length))).toString('hex');
  return { accountId, publicKey, secretKey: key.toString() };
};
const buyer = implicit(), seller = implicit();
await mkdir(directory, { recursive: true });
await writeFile(file, JSON.stringify({ network: 'mainnet', buyer, seller, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ network: 'mainnet', fundThisBuyerAddress: buyer.accountId, sellerAddress: seller.accountId, keysSavedTo: file }, null, 2));
