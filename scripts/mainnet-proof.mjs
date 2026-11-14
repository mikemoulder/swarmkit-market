// Mainnet Proof of Round + multi-party NEAR Intents settlement, for about 0.04 NEAR.
//
//   node scripts/mainnet-proof.mjs --review    print every mainnet transaction and amount; sends nothing
//   node scripts/mainnet-proof.mjs --execute   send them (resumable: finished steps are skipped)
//   node scripts/mainnet-proof.mjs --verify    re-check everything from public RPC; no keys
//
// What happens on mainnet:
//   1. The funder (the existing SwarmKit Intents buyer) creates an anchor account and two seller accounts.
//   2. The 478-byte SwarmKit anchor contract is deployed to the anchor account.
//   3. A sealed round runs: each seller anchors its bid commitment ON MAINNET, from its own account,
//      before the coordinator anchors "sealed". Bids are revealed only after that.
//   4. The funder moves wNEAR inside intents.near to three buyer accounts (one execute_intents).
//   5. SwarmKit's journaled settlement runner settles every allocation line buyer -> seller through
//      execute_intents on intents.near, each transfer signed by its own buyer.
//   6. The coordinator anchors the transcript hash and the settlement transactions; the anchor
//      account's only key is deleted, so the record cannot be changed.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, createTransaction } from "near-api-js";
import {
  cheapestCapacity, executeSettlement, nearIntentsTransport, settlementPlanFromTranscript,
  startSimulation, advanceSimulation, auditSettlement,
} from "near-swarmkit";

const mode = ["--review", "--execute", "--verify"].find((m) => process.argv.includes(m));
if (!mode) throw new Error("Choose --review, --execute or --verify");
const RPC = process.env.NEAR_MAINNET_RPC ?? "https://free.rpc.fastnear.com";
const ASSET = "nep141:wrap.near";
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const dir = join(".market", "mainnet-proof");
await mkdir(dir, { recursive: true });
const provider = new JsonRpcProvider({ url: RPC });
const sha = (text) => createHash("sha256").update(text).digest("hex");
const implicitId = (key) => Buffer.from(key.getPublicKey().data).toString("hex");

// Keys: the funder is the existing Intents buyer; everything else is generated once and kept in git-ignored .market.
const { buyer: funder } = JSON.parse(await readFile(join(".market", "intents-mainnet", "accounts.json"), "utf8"));
const keysFile = join(dir, "keys.json");
let keys;
try { keys = JSON.parse(await readFile(keysFile, "utf8")); } catch {
  const make = () => KeyPair.fromRandom("ed25519").toString();
  keys = { anchor: make(), sellers: [make(), make()], buyers: [make(), make(), make()], roundId: `swarmkit-mainnet-${Date.now()}` };
  await writeFile(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
}
const anchorKey = KeyPair.fromString(keys.anchor);
const sellerKeys = keys.sellers.map((k) => KeyPair.fromString(k));
const buyerKeys = keys.buyers.map((k) => KeyPair.fromString(k));
const ANCHOR = implicitId(anchorKey);
const SELLERS = sellerKeys.map(implicitId);
const BUYERS = buyerKeys.map(implicitId);
const ROUND = keys.roundId;
const FUNDING = { anchor: 2n * NEAR / 100n, seller: 4n * NEAR / 1000n }; // 0.02 NEAR, 0.004 NEAR each
const MILLI = 10n ** 21n;

// The round: three buyers, two sellers; prices in wNEAR. Deterministic, so --review shows exactly what --execute settles.
const salts = keys.salts ?? (keys.salts = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]);
await writeFile(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const options = {
  seed: 2026,
  spec: {
    id: ROUND, mechanismId: cheapestCapacity.id, asset: ASSET,
    resource: { label: "NEAR AI Cloud TEE completions", unit: "completion", deliveryWindow: "Same day" },
    demandCloses: 10, commitCloses: 20, revealCloses: 30,
  },
  mechanism: cheapestCapacity,
  buyers: [[2, 9n], [1, 8n], [3, 10n]].map(([quantity, max], i) => ({
    id: BUYERS[i], demand: () => ({ quantity: String(quantity), budget: String(BigInt(quantity) * max * MILLI / 10n) }),
  })),
  sellers: [[4, 5n], [10, 7n]].map(([capacity, price], i) => ({
    id: SELLERS[i], offer: () => ({ capacity: String(capacity), unitPrice: String(price * MILLI / 10n), salt: salts[i] }),
  })),
};
// Run the round up to the commit stage so commitments exist before anything is revealed.
let session = startSimulation(options);
const stages = [];
while (session.stage !== "closed") {
  session = await advanceSimulation(JSON.parse(JSON.stringify(session)), options);
  stages.push({ stage: session.stage, commitments: session.transcript.events.filter((e) => e.type === "commitment").length });
}
const transcript = session.transcript;
const commitments = transcript.events.filter((e) => e.type === "commitment");
const plan = await settlementPlanFromTranscript(transcript, cheapestCapacity);
const totals = new Map();
for (const p of plan.payments) totals.set(p.buyerId, (totals.get(p.buyerId) ?? 0n) + BigInt(p.amount));
const transcriptHash = sha(JSON.stringify(transcript));
const msg = (kind, value) => `swarmkit:v1:${ROUND}:${kind}${value ? ":" + value : ""}`;

const steps = [
  { id: "create-anchor", signer: funder.accountId, what: `transfer ${Number(FUNDING.anchor) / 1e24} NEAR to ${ANCHOR} (creates the anchor account)` },
  ...SELLERS.map((s, i) => ({ id: `create-seller-${i + 1}`, signer: funder.accountId, what: `transfer ${Number(FUNDING.seller) / 1e24} NEAR to ${s} (creates seller-${i + 1}, pays its gas)` })),
  { id: "deploy-anchor", signer: ANCHOR, what: `deploy contracts/anchor/anchor.wasm (478 bytes) to ${ANCHOR}` },
  ...commitments.map((c, i) => ({ id: `anchor-commit-${i + 1}`, signer: c.sellerId, what: `anchor "${msg("commit", c.hash)}"` })),
  { id: "anchor-sealed", signer: funder.accountId, what: `anchor "${msg("sealed")}" (after every commitment, before any reveal is published)` },
  { id: "fund-buyers", signer: funder.accountId, what: `execute_intents on intents.near: move ${[...totals].map(([b, a]) => `${Number(a) / 1e24} wNEAR to ${b.slice(0, 8)}...`).join(", ")}` },
  ...plan.payments.map((p, i) => ({ id: `settle-${i + 1}`, signer: funder.accountId, what: `execute_intents (relayed): ${p.buyerId.slice(0, 8)}... pays ${p.sellerId.slice(0, 8)}... ${Number(p.amount) / 1e24} wNEAR, signed by the buyer` })),
  { id: "anchor-result", signer: funder.accountId, what: `anchor "${msg("result", transcriptHash)}"` },
  { id: "lock-anchor", signer: ANCHOR, what: `delete the anchor account's only key (record becomes immutable)` },
];

if (mode === "--review") {
  console.log(JSON.stringify({
    network: "mainnet", funder: funder.accountId, round: ROUND,
    allocation: plan.payments.map((p) => ({ buyer: p.buyerId, seller: p.sellerId, wNEAR: Number(p.amount) / 1e24 })),
    totalWNear: Number(plan.payments.reduce((s, p) => s + BigInt(p.amount), 0n)) / 1e24,
    nearSpent: `${Number(FUNDING.anchor + 2n * FUNDING.seller) / 1e24} NEAR in account funding + gas (about 0.005 NEAR)`,
    transactions: steps.map((s, i) => `${String(i + 1).padStart(2)}. [${s.signer.slice(0, 12)}...] ${s.what}`),
  }, null, 2));
  process.exit(0);
}

const stateFile = join(dir, "state.json");
let state = {};
try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch {}
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2));
const account = (id, key) => new Account(id, provider, key.toString());
const funderAccount = account(funder.accountId, KeyPair.fromString(funder.secretKey));
const signerFor = (id) => id === funder.accountId ? funderAccount : id === ANCHOR ? account(ANCHOR, anchorKey) : account(id, sellerKeys[SELLERS.indexOf(id)]);
const hashOf = (outcome) => outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
async function step(id, run) {
  if (state[id]) return state[id];
  const outcome = await run();
  if (outcome?.status?.Failure) throw new Error(`${id} failed: ${JSON.stringify(outcome.status.Failure)}`);
  state[id] = hashOf(outcome) ?? "done";
  await save();
  console.error(`${id.padEnd(16)} ${state[id]}`);
  return state[id];
}
const anchor = (signerId, text) => signerFor(signerId).callFunctionRaw({ contractId: ANCHOR, methodName: "anchor", args: Buffer.from(text), gas: 10n * TGAS, waitUntil: "FINAL" });

if (mode === "--execute") {
  await step("create-anchor", () => funderAccount.transfer({ receiverId: ANCHOR, amount: FUNDING.anchor }));
  for (const [i, s] of SELLERS.entries()) await step(`create-seller-${i + 1}`, () => funderAccount.transfer({ receiverId: s, amount: FUNDING.seller }));
  // Top-up approved after the first attempt: an account must prepay worst-case gas for a 10 Tgas call.
  for (const [i, s] of SELLERS.entries()) await step(`topup-seller-${i + 1}`, () => funderAccount.transfer({ receiverId: s, amount: 8n * NEAR / 1000n }));
  await step("deploy-anchor", async () => account(ANCHOR, anchorKey).deployContract(await readFile("../../contracts/anchor/anchor.wasm")));
  for (const [i, c] of commitments.entries()) await step(`anchor-commit-${i + 1}`, () => anchor(c.sellerId, msg("commit", c.hash)));
  await step("anchor-sealed", () => anchor(funder.accountId, msg("sealed")));

  // NEP-413 signing for intents.near.
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const bstr = (s) => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };
  const signIntent = (key, { message, nonce, recipient }) => {
    const digest = createHash("sha256").update(Buffer.concat([u32(2 ** 31 + 413), bstr(message), Buffer.from(nonce, "base64"), bstr(recipient), Buffer.from([0])])).digest();
    return { publicKey: key.getPublicKey().toString(), signature: "ed25519:" + base58.encode(key.sign(digest).signature) };
  };
  const salt = await (async () => {
    const r = await provider.callFunction({ contractId: "intents.near", method: "current_salt", args: {} });
    return r;
  })();
  await step("fund-buyers", async () => {
    const nonce = Buffer.concat([Buffer.from(salt, "hex"), randomBytes(28)]).toString("base64");
    const message = JSON.stringify({
      signer_id: funder.accountId, deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      intents: [...totals].map(([b, amount]) => ({ intent: "transfer", receiver_id: b, tokens: { [ASSET]: String(amount) }, memo: msg("fund", b.slice(0, 8)) })),
    });
    const sig = signIntent(KeyPair.fromString(funder.secretKey), { message, nonce, recipient: "intents.near" });
    return funderAccount.callFunctionRaw({ contractId: "intents.near", methodName: "execute_intents", args: { signed: [{ standard: "nep413", payload: { recipient: "intents.near", message, nonce }, public_key: sig.publicKey, signature: sig.signature }] }, gas: 30n * TGAS, waitUntil: "FINAL" });
  });

  // Settlement through the SDK's crash-safe runner: one journaled execute_intents per allocation line.
  const journalDir = join(dir, "journal");
  await mkdir(journalDir, { recursive: true });
  const fileFor = (scope) => join(journalDir, sha(scope) + ".json");
  const read = async (scope) => { try { return JSON.parse(await readFile(fileFor(scope), "utf8")); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; } };
  const reserve = async (scope, entry) => {
    const target = fileFor(scope); const tmp = target + "." + randomBytes(8).toString("hex");
    const f = await open(tmp, "wx", 0o600);
    try { await f.writeFile(JSON.stringify(entry)); await f.sync(); } finally { await f.close(); }
    try { await link(tmp, target); } catch (e) { if (e.code !== "EEXIST") throw e; } finally { await unlink(tmp); }
    return read(scope);
  };
  let lastNonce = 0n;
  const transport = nearIntentsTransport({
    asset: ASSET, relayerId: funder.accountId, rpcUrl: RPC,
    async signIntent(request) { return signIntent(buyerKeys[BUYERS.indexOf(request.payment.buyerId)], request); },
    async signTransaction(call) {
      const signer = new KeyPairSigner(KeyPair.fromString(funder.secretKey));
      const publicKey = await signer.getPublicKey();
      const access = await provider.query({ request_type: "view_access_key", finality: "final", account_id: funder.accountId, public_key: publicKey.toString() });
      lastNonce = (BigInt(access.nonce) > lastNonce ? BigInt(access.nonce) : lastNonce) + 1n;
      const tx = createTransaction(funder.accountId, publicKey, call.receiverId, lastNonce,
        [actions.functionCall(call.methodName, call.args, 30n * TGAS, BigInt(call.attachedDepositYoctoNear))], base58.decode(access.block_hash));
      const { txHash, signedTransaction } = await signer.signTransaction(tx);
      return { hash: base58.encode(txHash), bytes: Buffer.from(signedTransaction.encode()).toString("base64") };
    },
  });
  let result;
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await executeSettlement(plan, { journal: { read, reserve, async bindPlan(scope, fp) { return (await reserve(scope, { fingerprint: fp })).fingerprint === fp; } }, transport, authorize: () => true });
    if (result.receipts.every((r) => r.status === "confirmed")) break;
    if (result.receipts.some((r) => r.status === "failed")) throw new Error("A settlement payment failed: " + JSON.stringify(result.receipts));
    await new Promise((r) => setTimeout(r, 4000));
  }
  state.settlement = result;
  await save();
  console.error("settlement", JSON.stringify(result).slice(0, 400));
  await step("anchor-result", () => anchor(funder.accountId, msg("result", transcriptHash)));
  await step("lock-anchor", async () => {
    const [k] = (await provider.viewAccessKeyList({ accountId: ANCHOR })).keys;
    return account(ANCHOR, anchorKey).deleteKey(k.public_key);
  });
  await writeFile("public/mainnet-proof.json", JSON.stringify({ network: "mainnet", anchor: ANCHOR, round: ROUND, transcriptHash, transcript, plan, transactions: state, stages }, null, 2));
  console.log(`done: anchor ${ANCHOR}, evidence in public/mainnet-proof.json`);
}

if (mode === "--verify") {
  const evidence = JSON.parse(await readFile("public/mainnet-proof.json", "utf8"));
  const view = await provider.query({ request_type: "view_state", finality: "final", account_id: evidence.anchor, prefix_base64: Buffer.from(`swarmkit:v1:${evidence.round}:`).toString("base64") });
  const anchors = view.values.map(({ key, value }) => {
    const raw = Buffer.from(key, "base64"); const sep = raw.indexOf(0);
    return { text: raw.subarray(0, sep).toString(), signer: raw.subarray(sep + 1).toString(), at: Buffer.from(value, "base64").readBigUInt64LE() };
  });
  const ok = (name, pass) => console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  ok(`anchor account ${evidence.anchor} has no keys`, (await provider.viewAccessKeyList({ accountId: evidence.anchor })).keys.length === 0);
  const sealed = anchors.find((a) => a.text.endsWith(":sealed"));
  for (const c of evidence.transcript.events.filter((e) => e.type === "commitment")) {
    const a = anchors.find((x) => x.text === `swarmkit:v1:${evidence.round}:commit:${c.hash}`);
    ok(`commitment of ${c.sellerId.slice(0, 8)}... anchored by that seller before "sealed"`, Boolean(a && sealed) && a.signer === c.sellerId && a.at < sealed.at);
  }
  const extra = anchors.filter((a) => a.text.includes(":commit:") && !evidence.transcript.events.some((e) => e.type === "commitment" && a.text.endsWith(e.hash)));
  ok("no anchored commitment is missing from the transcript (operator omitted nobody)", extra.length === 0);
  ok("transcript hash anchored after sealing", anchors.some((a) => a.text.endsWith(`:result:${sha(JSON.stringify(evidence.transcript))}`) && a.at > sealed.at));
  const claims = evidence.transactions.settlement.receipts.map(({ paymentId, status, transactionHash }) => ({ paymentId, status, transactionHash }));
  const transport = nearIntentsTransport({ asset: ASSET, relayerId: funder.accountId, rpcUrl: RPC, signIntent: async () => { throw new Error("read-only"); }, signTransaction: async () => { throw new Error("read-only"); } });
  const audit = await auditSettlement(evidence.transcript, claims, { mechanism: cheapestCapacity, verifier: transport });
  for (const c of audit.checks) ok(`payment ${c.paymentId} ${c.claimed} on mainnet (observed ${c.observed})`, c.matches === true);
}
