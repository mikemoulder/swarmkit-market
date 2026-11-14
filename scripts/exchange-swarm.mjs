// Runs one full SwarmKit Exchange round on NEAR testnet with real accounts, real wNEAR escrow,
// bonded sealed bids, on-chain clearing, metered delivery, slashing and withdrawals.
//
//   node scripts/exchange-swarm.mjs --faucet-testnet --wasm ../../contracts/exchange/target/near/swarmkit_exchange.wasm
//
// Delivery: with NEARAI_API_KEY set, every allocated unit is one real NEAR AI Cloud completion and the
// receipt is sha256 of the response plus its TEE signature. Without it, delivery is simulated and the
// evidence file says so.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (!process.argv.includes("--faucet-testnet")) throw new Error("Pass --faucet-testnet to create disposable testnet accounts.");
const wasm = await readFile(arg("--wasm") ?? "../../contracts/exchange/target/near/swarmkit_exchange.wasm");
const NEARAI = process.env.NEARAI_API_KEY;
const MODELS = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.6-35B-A3B-FP8", "deepseek-ai/DeepSeek-V4.1-Flash-1017"]; // NEAR AI Cloud private (TEE) models
const TOKEN = "wrap.testnet";
const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n; // 0.001 wNEAR: the price unit
const BOND = 50n * MILLI;
const PHASE_MS = { demand: 75_000, commit: 45_000, reveal: 45_000, delivery: 300_000 };
const sha = (text) => createHash("sha256").update(text).digest("hex");
const sleepUntil = async (ns) => { const ms = Number(BigInt(ns) / 1_000_000n) - Date.now() + 2500; if (ms > 0) await new Promise((r) => setTimeout(r, ms)); };

const provider = new JsonRpcProvider({ url: process.env.NEAR_TESTNET_RPC ?? "https://test.rpc.fastnear.com" });
const evidence = { network: "testnet", token: TOKEN, delivery: NEARAI ? `NEAR AI Cloud TEE models: ${MODELS.join(", ")}` : "simulated", steps: [] };
const record = (step, who, tx, extra = {}) => {
  const hash = tx?.transaction?.hash ?? tx?.transaction_outcome?.id;
  evidence.steps.push({ step, who, tx: hash, ...extra });
  console.error(`${step.padEnd(18)} ${who.padEnd(44)} ${hash ?? ""}`);
};

// 1. Accounts: one parent from the faucet, the exchange and every agent as its sub-accounts.
const parentId = `swarmx-${randomBytes(5).toString("hex")}.testnet`;
const parentKey = KeyPair.fromRandom("ed25519");
const faucet = await fetch("https://helper.testnet.near.org/account", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: parentId, newAccountPublicKey: parentKey.getPublicKey().toString() }),
  signal: AbortSignal.timeout(20_000),
});
assert.ok(faucet.ok, `faucet HTTP ${faucet.status}`);
await new Promise((r) => setTimeout(r, 3000));
const parent = new Account(parentId, provider, parentKey.toString());
// Testnet-only keys, kept in git-ignored .market so an interrupted run can be finished by hand.
const keyFile = `.market/exchange/${parentId}.json`;
const savedKeys = { [parentId]: parentKey.toString() };
await mkdir('.market/exchange', { recursive: true });
const saveKeys = () => writeFile(keyFile, JSON.stringify(savedKeys, null, 2), { mode: 0o600 });
await saveKeys();
async function sub(label, near) {
  const key = KeyPair.fromRandom("ed25519");
  const id = `${label}.${parentId}`;
  savedKeys[id] = key.toString();
  await saveKeys();
  record("create-account", id, await parent.createSubAccount({ accountOrPrefix: id, publicKey: key.getPublicKey().toString(), nearToTransfer: near }));
  return new Account(id, provider, key.toString());
}
const exchange = await sub("exchange", 4n * NEAR);
const buyerPlans = [
  ["buyer-1", 4, 9], ["buyer-2", 3, 7], ["buyer-3", 2, 10], ["buyer-4", 5, 8], ["buyer-5", 1, 12],
  ["buyer-6", 3, 9], ["buyer-7", 2, 6], ["buyer-8", 4, 11], ["buyer-9", 2, 8], ["buyer-10", 3, 10],
]; // [label, units wanted, max price per unit in milli-wNEAR]
const sellerPlans = [
  // [label, capacity, cost, markup %, behaviour]
  ["seller-1", 9, 4, 25, "honest", MODELS[0]],     // cheapest, too small for the whole pool
  ["seller-2", 20, 5, 20, "short", MODELS[1]],     // delivers only half of what it sold
  ["seller-3", 30, 7, 10, "honest", MODELS[2]],
  ["seller-4", 30, 3, 10, "no-reveal", MODELS[0]], // cheapest bid, then disappears: loses its bond
  ["seller-5", 30, 9, 15, "honest", MODELS[1]],
];
const buyers = [];
for (const [label] of buyerPlans) buyers.push(await sub(label, 15n * NEAR / 100n));
const sellers = [];
for (const [label] of sellerPlans) sellers.push(await sub(label, 15n * NEAR / 100n));

// 2. Deploy, init, register storage on wNEAR, and fund buyers with wNEAR.
record("deploy", exchange.accountId, await exchange.deployContract(wasm), { wasmSha256: sha(wasm) });
evidence.contract = exchange.accountId;
evidence.wasmSha256 = sha(wasm);
const call = (account, contractId, methodName, args, deposit = 0n, gas = 50n * TGAS) =>
  account.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: "FINAL" });
const view = (methodName, args) => provider.callFunction({ contractId: exchange.accountId, method: methodName, args });
record("init", exchange.accountId, await call(exchange, exchange.accountId, "new", { token: TOKEN }));
for (const account of [exchange, ...buyers, ...sellers]) {
  await call(account, TOKEN, "storage_deposit", { account_id: account.accountId, registration_only: true }, 1_250_000_000_000_000_000_000n);
}
for (const [i, buyer] of buyers.entries()) {
  const [, units, max] = buyerPlans[i];
  await call(buyer, TOKEN, "near_deposit", {}, BigInt(units * max) * MILLI);
}

// 3. Open a round. The parent account is the coordinator: it has no power over money.
const opened = await call(parent, exchange.accountId, "open_round", {
  resource: NEARAI ? "NEAR AI Cloud TEE completions" : "inference completions (simulated delivery)",
  demand_ms: String(PHASE_MS.demand), commit_ms: String(PHASE_MS.commit), reveal_ms: String(PHASE_MS.reveal),
  delivery_ms: String(PHASE_MS.delivery), seller_bond: String(BOND),
});
const roundId = Number(JSON.parse(Buffer.from(opened.status.SuccessValue, "base64")));
record("open-round", parent.accountId, opened, { roundId });
let round = await view("get_round", { round_id: String(roundId) });

// 4. Demand: each buyer escrows its budget with ft_transfer_call. The budget is its hard cap.
for (const [i, buyer] of buyers.entries()) {
  const [, units, max] = buyerPlans[i];
  record("join", buyer.accountId, await call(buyer, TOKEN, "ft_transfer_call", {
    receiver_id: exchange.accountId, amount: String(BigInt(units * max) * MILLI),
    msg: JSON.stringify({ round_id: roundId, quantity: String(units) }),
  }, 1n, 100n * TGAS), { units, budget: String(BigInt(units * max) * MILLI) });
}

// 5. Commit: sellers see only the pooled quantity, price at cost + markup, seal it with a salt and a bond.
await sleepUntil(round.demand_end);
const pooled = buyerPlans.reduce((sum, [, units]) => sum + units, 0);
const offers = sellerPlans.map(([label, capacity, cost, markup], i) => {
  const unitPrice = BigInt(Math.ceil(cost * (100 + markup))) * MILLI / 100n;
  return { seller: sellers[i], capacity: String(Math.min(capacity, pooled)), unitPrice: String(unitPrice), salt: randomBytes(32).toString("hex") };
});
for (const offer of offers) {
  const hash = sha(JSON.stringify(["swarmkit-bid-v1", String(roundId), offer.seller.accountId, offer.capacity, offer.unitPrice, offer.salt]));
  record("commit", offer.seller.accountId, await call(offer.seller, exchange.accountId, "commit", { round_id: String(roundId), hash }, BOND), { hash });
}

// 6. Reveal, except the seller that walks away.
await sleepUntil(round.commit_end);
for (const [i, offer] of offers.entries()) {
  if (sellerPlans[i][4] === "no-reveal") { evidence.steps.push({ step: "no-reveal", who: offer.seller.accountId }); continue; }
  record("reveal", offer.seller.accountId, await call(offer.seller, exchange.accountId, "reveal", {
    round_id: String(roundId), capacity: offer.capacity, unit_price: offer.unitPrice, salt: offer.salt,
  }), { capacity: offer.capacity, unitPrice: offer.unitPrice });
}

// 7. Clear on chain: anyone may call it. The contract runs cheapest-capacity-v1.
await sleepUntil(round.reveal_end);
record("clear", parent.accountId, await call(parent, exchange.accountId, "clear", { round_id: String(roundId) }, 0n, 200n * TGAS));
round = await view("get_round", { round_id: String(roundId) });
evidence.cleared = { status: round.status, total: round.total, lines: round.lines.map(({ buyer, seller, quantity, unit_price }) => ({ buyer, seller, quantity, unit_price })) };
console.error(`round ${round.status}: ${round.lines.length} lines, total ${round.total} yocto-wNEAR`);

// 8. Delivery: each seller serves its lines; each buyer confirms what it received with a receipt hash.
async function serve(buyerId, prompt, MODEL) {
  if (!NEARAI) return { receipt: sha(JSON.stringify(["simulated", buyerId, prompt])), simulated: true };
  const response = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${NEARAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `NEAR AI Cloud HTTP ${response.status}`);
  const completion = await response.json();
  let signature = null;
  try {
    const signed = await fetch(`https://cloud-api.near.ai/v1/signature/${completion.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa`,
      { headers: { Authorization: `Bearer ${NEARAI}` }, signal: AbortSignal.timeout(30_000) });
    if (signed.ok) signature = await signed.json();
  } catch {}
  return { receipt: sha(JSON.stringify([completion, signature])), model: MODEL, completionId: completion.id, signature, answer: completion.choices?.[0]?.message?.content?.slice(0, 120) };
}
const deliveries = [];
for (const line of round.lines) {
  const plan = sellerPlans[sellers.findIndex((s) => s.accountId === line.seller)];
  const units = plan[4] === "short" ? Math.floor(Number(line.quantity) / 2) : Number(line.quantity);
  const buyer = buyers.find((b) => b.accountId === line.buyer);
  if (!units) { evidence.steps.push({ step: "no-delivery", who: line.seller, buyer: line.buyer }); continue; }
  const served = await Promise.all(Array.from({ length: units }, (_, unit) =>
    serve(line.buyer, `In one sentence, why do AI agents pool demand? (${line.buyer} unit ${unit + 1})`, plan[5])));
  // One confirmation per line: the receipt commits to every unit's receipt, in order.
  const receipt = sha(JSON.stringify(served.map((s) => s.receipt)));
  record("confirm-delivery", line.buyer, await call(buyer, exchange.accountId, "confirm_delivery", {
    round_id: String(roundId), seller: line.seller, units: String(units), receipt,
  }), { seller: line.seller, units, of: line.quantity, receipt, unitReceipts: served.map((s) => s.receipt) });
  for (const s of served) deliveries.push({ ...s, buyer: line.buyer, seller: line.seller });
}

// 9. Finalize after the delivery deadline: refunds for undelivered units, bonds back or slashed.
await sleepUntil(round.delivery_end);
record("finalize", parent.accountId, await call(parent, exchange.accountId, "finalize", { round_id: String(roundId) }, 0n, 200n * TGAS));
evidence.balances = {};
for (const account of [...buyers, ...sellers]) {
  const [token, near] = await view("get_balances", { account_id: account.accountId });
  evidence.balances[account.accountId] = { token, near };
  if (BigInt(token) > 0n) record("withdraw-token", account.accountId, await call(account, exchange.accountId, "withdraw_token", {}, 0n, 60n * TGAS), { amount: token });
  if (BigInt(near) > 0n) record("withdraw-near", account.accountId, await call(account, exchange.accountId, "withdraw_near", {}), { amount: near });
}

// 10. Lock the exchange: delete its only key so nobody can change the code or move money by hand.
const [exchangeKey] = (await provider.viewAccessKeyList({ accountId: exchange.accountId })).keys;
record("lock-contract", exchange.accountId, await exchange.deleteKey(exchangeKey.public_key));
evidence.round = await view("get_round", { round_id: String(roundId) });
evidence.deliveries = deliveries.map(({ buyer, seller, model, receipt, completionId, signature, answer, simulated }) => ({ buyer, seller, model, receipt, completionId, signature, answer, simulated }));
await mkdir("public", { recursive: true });
await writeFile("public/exchange-testnet.json", JSON.stringify(evidence, null, 2));
console.log(`exchange ${exchange.accountId}: round ${roundId} ${evidence.round.status}; evidence in public/exchange-testnet.json`);
