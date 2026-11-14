// SwarmKit Exchange keeper (Cloudflare Worker, NEAR testnet).
// Every minute (and whenever a visitor asks) it moves the live round one step:
//   no round, or last one done -> open a round if someone visited in the last 20 minutes
//   demand    -> house buyer agents join with canned questions
//   commit    -> each provider agent seals a price (cost + markup) with a fresh salt and its bond
//   reveal    -> providers reveal; the contract checks each against its commitment
//   clear     -> the contract clears with cheapest-capacity-v1
//   delivery  -> every allocated answer is produced by that provider's NEAR AI Cloud TEE model;
//                house buyers confirm their own; visitors confirm theirs from their wallet
//   finalize  -> refunds, bonds back or slashed; agents withdraw
// The keeper holds no market funds: escrow, clearing and payout live in the locked contract.
import { Account, JsonRpcProvider } from "near-api-js";

const RPC = "https://test.rpc.fastnear.com";
const TOKEN = "wrap.testnet";
const TGAS = 10n ** 12n;
const MILLI = 10n ** 21n;
const BOND = 20n * MILLI; // 0.02 NEAR
const PHASES = { demand: 150_000, commit: 50_000, reveal: 50_000, delivery: 300_000 };
const HOUSE_PROMPTS = [
  "In one sentence: why would AI agents pool their demand before buying compute?",
  "In one sentence: what does a sealed-bid auction protect a buyer from?",
  "In one sentence: why should a seller post a bond before it bids?",
  "In one sentence: what does NEAR Intents let an agent do?",
];

const json = (body, status = 200, origin) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(origin) } });
function cors(origin) {
  const ok = /^https:\/\/([a-z0-9-]+\.)?swarmkit-coop\.pages\.dev$/.test(origin ?? "") || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin ?? "");
  return ok ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" } : {};
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const salt = () => hex(crypto.getRandomValues(new Uint8Array(32)));

function setup(env) {
  const keys = JSON.parse(env.LIVE_KEYS);
  const provider = new JsonRpcProvider({ url: RPC });
  const acct = ({ id, key }) => new Account(id, provider, key);
  const view = (method, args = {}) => provider.callFunction({ contractId: keys.exchange, method, args });
  const call = (who, contractId, methodName, args, deposit = 0n, gas = 50n * TGAS) =>
    acct(who).callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: "FINAL" });
  return { keys, provider, view, call };
}

async function latestRound(ctx) {
  const count = Number(await ctx.view("get_round_count"));
  return count ? ctx.view("get_round", { round_id: String(count - 1) }) : null;
}

async function serve(env, p, prompt) {
  const body = { model: p.model, max_tokens: 160, messages: [{ role: "user", content: prompt }], ...p.extra };
  const r = await fetch("https://cloud-api.near.ai/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${env.NEARAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`NEAR AI ${r.status}`);
  const completion = await r.json();
  let signature = null;
  const s = await fetch(`https://cloud-api.near.ai/v1/signature/${completion.id}?model=${encodeURIComponent(p.model)}&signing_algo=ecdsa`, { headers: { Authorization: `Bearer ${env.NEARAI_API_KEY}` } });
  if (s.ok) signature = await s.json();
  return { model: p.model, answer: completion.choices?.[0]?.message?.content ?? "", completionId: completion.id, signature, unitReceipt: await sha(JSON.stringify([completion, signature])) };
}

/** Moves the live round at most one step. Returns a short description of what it did. */
async function tick(env) {
  const ctx = setup(env);
  const { keys, view, call } = ctx;
  const kv = env.LIVE_KV;
  const now = BigInt(Date.now()) * 1_000_000n;
  const round = await latestRound(ctx);

  if (!round || round.status === "Finalized" || round.status === "Failed") {
    if (round) {
      // Agents collect what the contract owes them before the next round.
      for (const who of [...keys.providers, ...keys.house]) {
        const [token, near] = await view("get_balances", { account_id: who.id });
        if (BigInt(token) > 0n) { await call(who, keys.exchange, "withdraw_token", {}, 0n, 60n * TGAS); return `withdraw wNEAR for ${who.id}`; }
        if (BigInt(near) > 0n) { await call(who, keys.exchange, "withdraw_near", {}); return `withdraw bond for ${who.id}`; }
      }
    }
    const wanted = Number(await kv.get("wanted") ?? 0);
    if (Date.now() - wanted > 20 * 60_000) return "idle: nobody has visited in 20 minutes";
    await call(keys.keeper, keys.exchange, "open_round", {
      resource: "AI answers from NEAR AI Cloud TEE models", demand_ms: String(PHASES.demand), commit_ms: String(PHASES.commit),
      reveal_ms: String(PHASES.reveal), delivery_ms: String(PHASES.delivery), seller_bond: String(BOND),
    });
    return "opened a round";
  }
  const id = String(round.id);
  if (round.status === "Open") {
    if (now < BigInt(round.demand_end)) {
      const joined = [];
      for (const [i, h] of keys.house.entries()) {
        if (round.orders.some((o) => o.buyer === h.id)) continue;
        const quantity = 1 + ((Number(id) + i) % 2);
        const prompt = HOUSE_PROMPTS[(Number(id) * 2 + i) % HOUSE_PROMPTS.length];
        await kv.put(`prompt:${id}:${h.id}`, prompt, { expirationTtl: 7 * 86400 });
        await call(h, TOKEN, "ft_transfer_call", { receiver_id: keys.exchange, amount: String(BigInt(quantity) * 9n * MILLI), msg: JSON.stringify({ round_id: Number(id), quantity: String(quantity), prompt_sha: await sha(prompt) }) }, 1n, 100n * TGAS);
        joined.push(h.id.split(".")[0]);
      }
      return joined.length ? `${joined.join(", ")} joined` : "demand phase: waiting for buyers";
    }
    if (now < BigInt(round.commit_end)) {
      const pooled = round.orders.reduce((s, o) => s + BigInt(o.quantity), 0n);
      if (!pooled) return "commit phase: empty pool";
      const committed = await Promise.all(keys.providers.filter((p) => !round.commitments.some((c) => c.seller === p.id)).map(async (p) => {
        const jitter = BigInt(Math.floor(Math.random() * 11)) - 5n;
        const unitPrice = BigInt(p.cost) * (100n + BigInt(p.markup) + jitter) * MILLI / 100n;
        const capacity = String(1n + BigInt(Math.floor(Math.random() * 4)));
        const s = salt();
        await kv.put(`offer:${id}:${p.id}`, JSON.stringify({ capacity, unitPrice: String(unitPrice), salt: s }), { expirationTtl: 7 * 86400 });
        const hash = await sha(JSON.stringify(["swarmkit-bid-v1", id, p.id, capacity, String(unitPrice), s]));
        await call(p, keys.exchange, "commit", { round_id: id, hash }, BOND);
        return p.id.split(".")[0];
      }));
      return committed.length ? `${committed.join(", ")} committed sealed bids` : "commit phase: all providers committed";
    }
    if (now < BigInt(round.reveal_end)) {
      const revealed = await Promise.all(keys.providers.filter((p) => !round.offers.some((o) => o.seller === p.id) && round.commitments.some((c) => c.seller === p.id)).map(async (p) => {
        const offer = JSON.parse(await kv.get(`offer:${id}:${p.id}`));
        await call(p, keys.exchange, "reveal", { round_id: id, capacity: offer.capacity, unit_price: offer.unitPrice, salt: offer.salt });
        return p.id.split(".")[0];
      }));
      return revealed.length ? `${revealed.join(", ")} revealed` : "reveal phase: all revealed";
    }
    await call(keys.keeper, keys.exchange, "clear", { round_id: id }, 0n, 200n * TGAS);
    return "cleared";
  }
  if (round.status === "Cleared") {
    if (now >= BigInt(round.delivery_end)) {
      await call(keys.keeper, keys.exchange, "finalize", { round_id: id }, 0n, 200n * TGAS);
      return "finalized";
    }
    const did = [];
    await Promise.all(round.lines.map(async (line) => {
      const key = `answers:${id}:${line.buyer}:${line.seller}`;
      let served = await kv.get(key, "json");
      if (!served) {
        const prompt = await kv.get(`prompt:${id}:${line.buyer}`);
        if (!prompt) return; // a visitor who never sent the question: nothing to answer, refunded at finalize
        const p = keys.providers.find((x) => x.id === line.seller);
        const units = await Promise.all(Array.from({ length: Number(line.quantity) }, () => serve(env, p, prompt)));
        served = { prompt, units, lineReceipt: await sha(JSON.stringify(units.map((u) => u.unitReceipt))) };
        await kv.put(key, JSON.stringify(served), { expirationTtl: 7 * 86400 });
        did.push(`${line.seller.split(".")[0]} answered ${line.buyer.split(".")[0]}`);
      }
      const house = keys.house.find((h) => h.id === line.buyer);
      if (house && line.delivered === "0") {
        await call(house, keys.exchange, "confirm_delivery", { round_id: id, seller: line.seller, units: line.quantity, receipt: served.lineReceipt });
        did.push(`${house.id.split(".")[0]} confirmed ${line.seller.split(".")[0]}`);
      }
    }));
    if (did.length) return did.join("; ");
    return "delivery phase: waiting for visitors to confirm";
  }
  return "nothing to do";
}

/** A visitor's question is accepted only if their own join transaction committed to its sha256. */
async function acceptPrompt(env, body) {
  const { round_id, buyer, prompt, tx_hash } = body;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 400) return "Ask a question of 1 to 400 characters.";
  if (!/^[a-z0-9._-]{2,64}$/.test(buyer ?? "") || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(tx_hash ?? "")) return "Bad account or transaction.";
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash, sender_account_id: buyer, wait_until: "FINAL" } }) });
  const tx = (await r.json()).result?.transaction;
  if (!tx || tx.signer_id !== buyer || tx.receiver_id !== TOKEN) return "That transaction is not your join.";
  const digest = await sha(prompt);
  const joined = tx.actions.some((a) => {
    const f = a.FunctionCall;
    if (f?.method_name !== "ft_transfer_call") return false;
    const args = JSON.parse(atob(f.args));
    const msg = JSON.parse(args.msg ?? "{}");
    return args.receiver_id === JSON.parse(env.LIVE_KEYS).exchange && String(msg.round_id) === String(round_id) && msg.prompt_sha === digest;
  });
  if (!joined) return "Your join transaction does not commit to this question.";
  await env.LIVE_KV.put(`prompt:${round_id}:${buyer}`, prompt, { expirationTtl: 7 * 86400 });
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/config") {
        const keys = JSON.parse(env.LIVE_KEYS);
        return json({ exchange: keys.exchange, keeper: keys.keeper.id, providers: keys.providers.map(({ id, model }) => ({ id, model })), house: keys.house.map((h) => h.id), phases: PHASES, bond: String(BOND) }, 200, origin);
      }
      if (url.pathname === "/wake" && request.method === "POST") {
        await env.LIVE_KV.put("wanted", String(Date.now()));
        return json({ did: await tick(env) }, 200, origin);
      }
      if (url.pathname === "/prompt" && request.method === "POST") {
        const error = await acceptPrompt(env, await request.json());
        return error ? json({ error }, 400, origin) : json({ ok: true }, 200, origin);
      }
      if (url.pathname === "/answers") {
        const round = url.searchParams.get("round"), buyer = url.searchParams.get("buyer");
        const keys = JSON.parse(env.LIVE_KEYS);
        const out = [];
        for (const p of keys.providers) {
          const served = await env.LIVE_KV.get(`answers:${round}:${buyer}:${p.id}`, "json");
          if (served) out.push({ seller: p.id, ...served });
        }
        return json({ round, buyer, prompt: await env.LIVE_KV.get(`prompt:${round}:${buyer}`), answers: out }, 200, origin);
      }
      return json({ error: "not found" }, 404, origin);
    } catch (error) {
      return json({ error: String(error.message ?? error).slice(0, 300) }, 500, origin);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      // A few steps per minute so a round moves along without a visitor's page open.
      for (let i = 0; i < 4; i++) {
        const did = await tick(env).catch((e) => `error: ${e.message}`);
        if (/^(idle|demand phase: waiting|delivery phase: waiting|commit phase: all|reveal phase: all|error)/.test(did)) break;
      }
    })());
  },
};
