import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, createTransaction } from "near-api-js";
import { base58 } from "@scure/base";
import {
  auditSettlement, cheapestCapacity, executeSettlement, nearTestnetTransport, NATIVE_TESTNET_NEAR,
  planNearSubaccounts, settlementPlanFromTranscript, startSimulation, advanceSimulation,
} from "near-swarmkit";

if (!process.argv.includes("--faucet-testnet")) {
  throw new Error("Pass --faucet-testnet to create disposable accounts and send test tokens.");
}
const gpu = process.argv.includes("--gpu");
const split = process.argv.includes("--split");
if (gpu && split) throw new Error("Choose either --gpu or --split");
const parentId = `swarmkit-${randomBytes(6).toString("hex")}.testnet`;
const parentKey = KeyPair.fromRandom("ed25519");
const buyerCount = gpu ? 20 : split ? 1 : 2;
const sellerCount = gpu ? 5 : split ? 2 : 1;
const labels = [
  ...Array.from({ length: buyerCount }, (_, index) => `buyer-${index + 1}`),
  ...Array.from({ length: sellerCount }, (_, index) => `seller-${index + 1}`),
];
const keys = labels.map(() => KeyPair.fromRandom("ed25519"));
const accounts = planNearSubaccounts(parentId, labels.map((label, index) => ({
  label, publicKey: keys[index].getPublicKey().toString(), fundingYoctoNear: "20000000000000000000000",
})));
const faucet = await fetch("https://helper.testnet.near.org/account", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: parentId, newAccountPublicKey: parentKey.getPublicKey().toString() }),
  signal: AbortSignal.timeout(15_000),
});
assert.ok(faucet.ok, `Testnet faucet returned HTTP ${faucet.status}`);
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const parent = new Account(parentId, provider, parentKey.toString());
for (const account of accounts) {
  await parent.createSubAccount({
    accountOrPrefix: account.receiverId,
    nearToTransfer: BigInt(account.actions[1].deposit),
    publicKey: account.actions[2].publicKey,
  });
}
console.error(`Provisioned ${accounts.length} agent accounts under ${parentId}`);
const priceUnit = 10n ** 20n;
const options = {
  seed: 2026,
  spec: {
    id: parentId, mechanismId: split ? cheapestCapacity.id : undefined, resource: gpu || split
      ? { label: "NVIDIA H100", unit: "GPU hour", deliveryWindow: "Next available 24-hour block" }
      : { label: "Dataset seats", unit: "seat", deliveryWindow: "Today" },
    asset: NATIVE_TESTNET_NEAR, demandCloses: 10, commitCloses: 20, revealCloses: 30,
  },
  buyers: accounts.slice(0, buyerCount).map(({ receiverId }, index) => ({
    id: receiverId,
    demand: ({ random }) => {
      const quantity = gpu ? 1 + Math.floor(random() * 2 ** 32) % 8 : split ? 5 : index + 1;
      return { quantity: String(quantity), budget: String((split ? 14n : BigInt(quantity) * 7n) * priceUnit) };
    },
  })),
  sellers: accounts.slice(buyerCount).map(({ receiverId }, index) => ({
    id: receiverId,
    offer: ({ pooledQuantity }) => ({
      capacity: split ? String(3 - index) : String(BigInt(pooledQuantity) - (gpu && index === 0 ? 1n : 0n)),
      unitPrice: String(BigInt(2 * index + 2) * priceUnit),
    }),
  })),
};
let session = startSimulation(options);
while (session.stage !== "closed") session = await advanceSimulation(JSON.parse(JSON.stringify(session)), options);
const { transcript } = session;
const plan = await settlementPlanFromTranscript(transcript);
assert.equal(plan.payments.length, split ? 2 : buyerCount);
const sellerIds = split ? accounts.slice(buyerCount).map(({ receiverId }) => receiverId)
  : [accounts[buyerCount + (gpu ? 1 : 0)].receiverId];
if (split) assert.deepEqual(plan.payments.map(({ sellerId, amount }) => [sellerId, amount]), [
  [sellerIds[0], String(6n * priceUnit)], [sellerIds[1], String(8n * priceUnit)],
]);

const directory = join(".market", "testnet", parentId);
await mkdir(directory, { recursive: true });
function journal() {
  const pathFor = (scope) => join(directory, createHash("sha256").update(scope).digest("hex") + ".json");
  async function read(scope) {
    try {
      return JSON.parse(await readFile(pathFor(scope), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    }
  }
  async function reserve(scope, entry) {
    const target = pathFor(scope);
    const temporary = target + "." + randomBytes(8).toString("hex");
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(entry));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      return await read(scope);
    } finally {
      await unlink(temporary);
    }
  }
  return {
    read,
    reserve,
    async bindPlan(scope, fingerprint) {
      return (await reserve(scope, { fingerprint })).fingerprint === fingerprint;
    },
  };
}

let signatures = 0;
const transport = nearTestnetTransport(async (payment) => {
  signatures++;
  const index = accounts.findIndex(({ receiverId }) => receiverId === payment.buyerId);
  assert.ok(index >= 0 && index < buyerCount);
  const signer = new KeyPairSigner(keys[index]);
  const publicKey = await signer.getPublicKey();
  const access = await provider.query({
    request_type: "view_access_key", finality: "final",
    account_id: payment.buyerId, public_key: publicKey.toString(),
  });
  const transaction = createTransaction(
    payment.buyerId, publicKey, payment.sellerId, BigInt(access.nonce) + 1n,
    [actions.transfer(BigInt(payment.amount))], base58.decode(access.block_hash),
  );
  const { txHash, signedTransaction } = await signer.signTransaction(transaction);
  return { hash: base58.encode(txHash), bytes: Buffer.from(signedTransaction.encode()).toString("base64") };
}, "https://test.rpc.fastnear.com");
const authorize = (payment) => sellerIds.includes(payment.sellerId)
  && plan.payments.some((approved) => approved.id === payment.id && approved.amount === payment.amount);

await assert.rejects(executeSettlement(plan, {
  journal: journal(),
  authorize,
  transport: { ...transport, inspect: async () => { throw new Error("Simulated interruption after journal write"); } },
}), /Simulated interruption/);
assert.equal(signatures, 1);
let result = await executeSettlement(plan, { transport, journal: journal(), authorize });
for (let attempt = 0; !result.summary.paid && attempt < 12; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  result = await executeSettlement(plan, { transport, journal: journal(), authorize: split ? authorize : () => false });
}
assert.equal(result.summary.paid, true, JSON.stringify(result));
assert.equal(signatures, plan.payments.length);
const audit = await auditSettlement(transcript, result.receipts, { verifier: transport });
assert.ok(audit.checks.every(({ matches }) => matches));
assert.equal(audit.verifiedSummary.paid, true);
const evidence = {
  network: "testnet", validatedAt: new Date().toISOString(), execution: "native-testnet", audit,
  ...(split ? { sellerIds } : { sellerId: sellerIds[0] }), transcript, plan, ...result,
};
await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ network: "testnet", parentId, payments: plan.payments.length, paid: result.summary.paid, evidence: join(directory, "evidence.json") }, null, 2));

