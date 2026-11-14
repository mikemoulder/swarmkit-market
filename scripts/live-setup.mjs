// One-time setup of the always-on SwarmKit Exchange on NEAR testnet.
//   node scripts/live-setup.mjs --faucet-testnet --wasm <exchange.wasm>
// Creates (all from one faucet account):
//   <parent>                 the keeper: opens, clears and finalizes rounds; holds no market funds
//   exchange.<parent>        the exchange contract, initialised for wrap.testnet, then its key is deleted
//   p-<model>.<parent> x3    provider agents, each backed by one NEAR AI Cloud TEE model
//   house-1/2.<parent>       house buyer agents, so every round has a pool even with one visitor
// Keys are written to .market/live/keys.json (git-ignored) for `wrangler secret put LIVE_KEYS`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

if (!process.argv.includes("--faucet-testnet")) throw new Error("Pass --faucet-testnet");
const wasmPath = process.argv[process.argv.indexOf("--wasm") + 1];
const wasm = await readFile(wasmPath);
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const NEAR = 10n ** 24n, TGAS = 10n ** 12n;
const parentId = `swarmkit-live-${randomBytes(3).toString("hex")}.testnet`;
const parentKey = KeyPair.fromRandom("ed25519");
const res = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: parentId, newAccountPublicKey: parentKey.getPublicKey().toString() }) });
assert.ok(res.ok, `faucet ${res.status}`);
await new Promise((r) => setTimeout(r, 3000));
const parent = new Account(parentId, provider, parentKey.toString());
const keys = { keeper: { id: parentId, key: parentKey.toString() } };
await mkdir(".market/live", { recursive: true });
const save = () => writeFile(".market/live/keys.json", JSON.stringify(keys, null, 2), { mode: 0o600 });
await save();
async function sub(label, near) {
  const key = KeyPair.fromRandom("ed25519");
  const id = `${label}.${parentId}`;
  await parent.createSubAccount({ accountOrPrefix: id, publicKey: key.getPublicKey().toString(), nearToTransfer: near });
  console.error("created", id);
  return { id, key: key.toString(), account: new Account(id, provider, key.toString()) };
}
const call = (a, contractId, methodName, args, deposit = 0n, gas = 50n * TGAS) => a.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: "FINAL" });

const exchange = await sub("exchange", 38n * NEAR / 10n);
await exchange.account.deployContract(wasm);
await call(exchange.account, exchange.id, "new", { token: "wrap.testnet" });
await call(exchange.account, "wrap.testnet", "storage_deposit", { account_id: exchange.id, registration_only: true }, 1_250_000_000_000_000_000_000n);
keys.exchange = exchange.id;
const providers = [
  ["p-qwen", "Qwen/Qwen3.6-35B-A3B-FP8", { chat_template_kwargs: { enable_thinking: false } }, 4, 30],
  ["p-deepseek", "deepseek-ai/DeepSeek-V4.1-Flash-1017", { chat_template_kwargs: { thinking: false } }, 6, 15],
  ["p-qwen-27b", "Qwen/Qwen3.8-27B", { chat_template_kwargs: { enable_thinking: false } }, 5, 20],
]; // [label, model, request extras, cost in milli-wNEAR per answer, markup %]
keys.providers = [];
for (const [label, model, extra, cost, markup] of providers) {
  const p = await sub(label, 9n * NEAR / 10n);
  await call(p.account, "wrap.testnet", "storage_deposit", { account_id: p.id, registration_only: true }, 1_250_000_000_000_000_000_000n);
  keys.providers.push({ id: p.id, key: p.key, model, extra, cost, markup });
  await save();
}
keys.house = [];
for (const label of ["house-1", "house-2"]) {
  const b = await sub(label, 9n * NEAR / 10n);
  await call(b.account, "wrap.testnet", "storage_deposit", { account_id: b.id, registration_only: true }, 1_250_000_000_000_000_000_000n);
  await call(b.account, "wrap.testnet", "near_deposit", {}, 6n * NEAR / 10n);
  keys.house.push({ id: b.id, key: b.key });
  await save();
}
// Lock the exchange: nobody, including us, can change its code or move funds by hand.
const [k] = (await provider.viewAccessKeyList({ accountId: exchange.id })).keys;
await exchange.account.deleteKey(k.public_key);
assert.equal((await provider.viewAccessKeyList({ accountId: exchange.id })).keys.length, 0);
await save();
console.log(JSON.stringify({ keeper: parentId, exchange: exchange.id, providers: keys.providers.map((p) => [p.id, p.model]), house: keys.house.map((h) => h.id) }, null, 2));
