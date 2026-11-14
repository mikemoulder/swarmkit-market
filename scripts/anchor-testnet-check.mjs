// Deploys contracts/anchor/anchor.wasm to a fresh testnet account and exercises it on a real NEAR VM:
// a valid anchor, a duplicate (must fail), a bad prefix (must fail), then lists the round with view_state.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const id = `swarmkit-anchor-${randomBytes(4).toString("hex")}.testnet`;
const key = KeyPair.fromRandom("ed25519");
const res = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }) });
assert.ok(res.ok, `faucet ${res.status}`);
await new Promise((r) => setTimeout(r, 3000));
const account = new Account(id, provider, key.toString());
await account.deployContract(await readFile("../../contracts/anchor/anchor.wasm"));
const anchor = (text) => account.callFunctionRaw({ contractId: id, methodName: "anchor", args: Buffer.from(text), gas: 10n ** 13n, waitUntil: "FINAL" });
const ok = await anchor("swarmkit:v1:check:commit:" + "ab".repeat(32));
console.log("anchor:", ok.transaction.hash, JSON.stringify(ok.status), ok.receipts_outcome?.[0]?.outcome?.logs);
for (const bad of ["swarmkit:v1:check:commit:" + "ab".repeat(32), "notswarmkit-data"]) {
  try { const r = await anchor(bad); console.log("UNEXPECTED success", JSON.stringify(r.status)); }
  catch (e) { console.log("rejected as expected:", String(e.message).slice(0, 90)); }
}
const view = await provider.query({ request_type: "view_state", finality: "final", account_id: id, prefix_base64: Buffer.from("swarmkit:v1:check:").toString("base64") });
for (const { key: k, value } of view.values) {
  const raw = Buffer.from(k, "base64"); const sep = raw.indexOf(0);
  console.log("state:", raw.subarray(0, sep).toString().slice(0, 40) + "...", "signer", raw.subarray(sep + 1).toString(), "at", Buffer.from(value, "base64").readBigUInt64LE());
}
console.log("contract", id);
