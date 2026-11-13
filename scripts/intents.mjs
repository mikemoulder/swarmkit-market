import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { actions, createTransaction, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { executeSettlement, nearIntentsTransport, settlementPlanFromTranscript } from "near-swarmkit";

const [transcriptPath, configPath, action = "--review"] = process.argv.slice(2);
if (!transcriptPath || !configPath || !["--review", "--execute", "--reconcile"].includes(action)) {
  throw new Error("Usage: npm run intents -- <transcript.json> <accounts.json> [--review|--execute|--reconcile]");
}
const evidence = JSON.parse(await readFile(transcriptPath, "utf8"));
const plan = await settlementPlanFromTranscript(evidence.transcript ?? evidence);
if (!plan.asset.startsWith("nep141:") || !plan.payments.length) {
  throw new Error("Provide a closed, nonempty transcript already denominated in a Verifier NEP-141 token.");
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const { relayerId, buyerKeyEnv, relayerKeyEnv, maxBuyerAmounts } = config;
const rpcUrl = config.rpcUrl ?? "https://rpc.mainnet.near.org";
if (!relayerId || !buyerKeyEnv || !relayerKeyEnv || !maxBuyerAmounts) throw new Error("Missing account configuration");
const totals = new Map();
for (const payment of plan.payments) {
  totals.set(payment.buyerId, (totals.get(payment.buyerId) ?? 0n) + BigInt(payment.amount));
}
for (const [buyer, amount] of totals) {
  const cap = maxBuyerAmounts[buyer];
  if (typeof cap !== "string" || !/^[1-9][0-9]*$/.test(cap) || amount > BigInt(cap)) {
    throw new Error(`Approval cap missing or exceeded for ${buyer}`);
  }
}
console.log(JSON.stringify({ network: "mainnet", relayerId, plan }, null, 2));
if (action === "--review") process.exit(0);

const directory = ".market/intents";
await mkdir(directory, { recursive: true });
const fileFor = (scope) => join(directory, createHash("sha256").update(scope).digest("hex") + ".json");
async function read(scope) {
  try { return JSON.parse(await readFile(fileFor(scope), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
async function reserve(scope, entry) {
  const target = fileFor(scope);
  const temporary = target + "." + randomBytes(8).toString("hex");
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(entry));
      await file.sync();
    } finally {
      await file.close();
    }
    try { await link(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return await read(scope);
  } finally {
    await unlink(temporary);
  }
}

function loadKey(envName) {
  const encoded = process.env[envName];
  if (!encoded) throw new Error(`Missing key environment variable: ${envName}`);
  return KeyPair.fromString(encoded);
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
function borshString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

const provider = new JsonRpcProvider({ url: rpcUrl });
let lastRelayerNonce = 0n;
const transport = nearIntentsTransport({
  asset: plan.asset, relayerId, rpcUrl,
  async signIntent({ payment, message, nonce, recipient }) {
    const key = loadKey(buyerKeyEnv[payment.buyerId]);
    const payload = Buffer.concat([
      u32(2 ** 31 + 413), borshString(message), Buffer.from(nonce, "base64"),
      borshString(recipient), Buffer.from([0]),
    ]);
    const signature = key.sign(createHash("sha256").update(payload).digest());
    return { publicKey: key.getPublicKey().toString(), signature: "ed25519:" + base58.encode(signature.signature) };
  },
  async signTransaction(call) {
    const signer = new KeyPairSigner(loadKey(relayerKeyEnv));
    const publicKey = await signer.getPublicKey();
    const access = await provider.query({
      request_type: "view_access_key", finality: "final", account_id: relayerId, public_key: publicKey.toString(),
    });
    const chainNonce = BigInt(access.nonce);
    lastRelayerNonce = (chainNonce > lastRelayerNonce ? chainNonce : lastRelayerNonce) + 1n;
    const transaction = createTransaction(
      relayerId, publicKey, call.receiverId, lastRelayerNonce,
      [actions.functionCall(call.methodName, call.args, 100n * 10n ** 12n, BigInt(call.attachedDepositYoctoNear))],
      base58.decode(access.block_hash),
    );
    const { txHash, signedTransaction } = await signer.signTransaction(transaction);
    return { hash: base58.encode(txHash), bytes: Buffer.from(signedTransaction.encode()).toString("base64") };
  },
});

const journal = {
  read, reserve,
  async bindPlan(scope, fingerprint) { return (await reserve(scope, { fingerprint })).fingerprint === fingerprint; },
};
const observed = new Map();
const indexes = new Map(plan.payments.map((payment, index) => [payment.id, index]));
const result = await executeSettlement(plan, {
  journal,
  transport: {
    ...transport,
    async inspect(payment, hash) {
      const status = await transport.inspect(payment, hash);
      observed.set(payment.id, status);
      return status;
    },
  },
  authorize(payment) {
    if (action !== "--execute") return false;
    const previous = plan.payments[indexes.get(payment.id) - 1];
    return !previous || observed.get(previous.id) === "confirmed";
  },
});
console.log(JSON.stringify(result, null, 2));
