#!/usr/bin/env node
// SwarmKit Exchange MCP server: lets any MCP client (Claude Code, Codex, Cursor...) read rounds and
// take part in them as a buyer or seller. Read-only by default. With NEAR_ACCOUNT_ID and
// NEAR_PRIVATE_KEY set (a function-call or testnet key you control), it also signs and sends.
//
//   claude mcp add swarmkit -- node mcp/server.mjs
//   env: SWARMKIT_EXCHANGE=<contract> NEAR_NETWORK=testnet [NEAR_ACCOUNT_ID=... NEAR_PRIVATE_KEY=ed25519:...]
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Account, JsonRpcProvider } from "near-api-js";

const network = process.env.NEAR_NETWORK ?? "testnet";
const rpc = process.env.NEAR_RPC ?? (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
const provider = new JsonRpcProvider({ url: rpc });
const defaultContract = process.env.SWARMKIT_EXCHANGE;
const signer = process.env.NEAR_ACCOUNT_ID && process.env.NEAR_PRIVATE_KEY
  ? new Account(process.env.NEAR_ACCOUNT_ID, provider, process.env.NEAR_PRIVATE_KEY) : null;
const token = network === "mainnet" ? "wrap.near" : "wrap.testnet";
const TGAS = 1_000_000_000_000n;

const str = { type: "string" };
const tools = [
  { name: "exchange_rounds", description: "List rounds on a SwarmKit Exchange contract: phase deadlines, orders, commitments, offers, allocation lines and status.", inputSchema: { type: "object", properties: { contract: str, from: { type: "number" } } } },
  { name: "exchange_round", description: "Read one round in full.", inputSchema: { type: "object", properties: { contract: str, round_id: { type: "number" } }, required: ["round_id"] } },
  { name: "exchange_balances", description: "Withdrawable wNEAR and NEAR of an account on the exchange.", inputSchema: { type: "object", properties: { contract: str, account_id: str }, required: ["account_id"] } },
  { name: "exchange_bid_commitment", description: "Make a sealed bid: returns the commitment hash and a fresh salt. Keep the salt private until you reveal.", inputSchema: { type: "object", properties: { round_id: { type: "number" }, seller: str, capacity: str, unit_price: str }, required: ["round_id", "seller", "capacity", "unit_price"] } },
  {
    name: "exchange_act",
    description: "Take an action in a round. Without a configured signer it returns the exact call to sign. Actions: join (buyer; amount = budget in yocto-wNEAR, quantity), commit (seller; hash, bond), reveal (seller; capacity, unit_price, salt), clear, confirm_delivery (buyer; seller, units, receipt), finalize, withdraw_token, withdraw_near.",
    inputSchema: { type: "object", properties: { contract: str, action: str, round_id: { type: "number" }, amount: str, quantity: str, hash: str, bond: str, capacity: str, unit_price: str, salt: str, seller: str, units: str, receipt: str }, required: ["action"] },
  },
];

async function view(contract, method, args) {
  return provider.callFunction({ contractId: contract, method, args });
}
function callFor(contract, a) {
  const round_id = String(a.round_id);
  switch (a.action) {
    case "join": return { contractId: token, methodName: "ft_transfer_call", args: { receiver_id: contract, amount: a.amount, msg: JSON.stringify({ round_id: a.round_id, quantity: a.quantity }) }, deposit: 1n, gas: 100n * TGAS };
    case "commit": return { contractId: contract, methodName: "commit", args: { round_id, hash: a.hash }, deposit: BigInt(a.bond), gas: 30n * TGAS };
    case "reveal": return { contractId: contract, methodName: "reveal", args: { round_id, capacity: a.capacity, unit_price: a.unit_price, salt: a.salt }, deposit: 0n, gas: 30n * TGAS };
    case "clear": case "finalize": return { contractId: contract, methodName: a.action, args: { round_id }, deposit: 0n, gas: 200n * TGAS };
    case "confirm_delivery": return { contractId: contract, methodName: "confirm_delivery", args: { round_id, seller: a.seller, units: a.units, receipt: a.receipt }, deposit: 0n, gas: 30n * TGAS };
    case "withdraw_token": case "withdraw_near": return { contractId: contract, methodName: a.action, args: {}, deposit: 0n, gas: 60n * TGAS };
    default: throw new Error(`Unknown action ${a.action}`);
  }
}

async function runTool(name, a) {
  const contract = a.contract ?? defaultContract;
  if (name !== "exchange_bid_commitment" && !contract) throw new Error("Pass contract or set SWARMKIT_EXCHANGE");
  if (name === "exchange_rounds") return view(contract, "get_rounds", { from: String(a.from ?? 0), limit: "20" });
  if (name === "exchange_round") return view(contract, "get_round", { round_id: String(a.round_id) });
  if (name === "exchange_balances") {
    const [wnear, near] = await view(contract, "get_balances", { account_id: a.account_id });
    return { wnear, near };
  }
  if (name === "exchange_bid_commitment") {
    const salt = randomBytes(32).toString("hex");
    const preimage = JSON.stringify(["swarmkit-bid-v1", String(a.round_id), a.seller, a.capacity, a.unit_price, salt]);
    return { hash: createHash("sha256").update(preimage).digest("hex"), salt, preimage };
  }
  if (name === "exchange_act") {
    const call = callFor(contract, a);
    if (!signer) return { signed: false, note: "No signer configured: sign this call with your own key.", signer_needed: "your account", call: { ...call, deposit: String(call.deposit), gas: String(call.gas) } };
    const outcome = await signer.callFunctionRaw({ ...call, waitUntil: "FINAL" });
    return { signed: true, signer: signer.accountId, transaction: outcome.transaction.hash, status: outcome.status };
  }
  throw new Error(`Unknown tool ${name}`);
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
  const { id, method, params } = request;
  if (id === undefined) continue; // notification
  try {
    if (method === "initialize") {
      send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "swarmkit-exchange", version: "0.2.0" } } });
    } else if (method === "tools/list") {
      send({ id, result: { tools } });
    } else if (method === "tools/call") {
      const result = await runTool(params.name, params.arguments ?? {});
      send({ id, result: { content: [{ type: "text", text: JSON.stringify(result, (_, v) => typeof v === "bigint" ? String(v) : v, 2) }] } });
    } else if (method === "ping") {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    if (method === "tools/call") send({ id, result: { isError: true, content: [{ type: "text", text: String(error.message ?? error) }] } });
    else send({ id, error: { code: -32603, message: String(error.message ?? error) } });
  }
}
