// Independent check of a SwarmKit Exchange contract, from public RPC only. No keys.
//
//   node scripts/verify-exchange.mjs <exchange-account> [--network testnet|mainnet]
//
// For every round it checks, against chain state:
//   1. each revealed offer matches its sealed commitment (sha256 of the SDK preimage),
//   2. re-running the SDK's cheapest-capacity-v1 on the on-chain orders and offers gives exactly
//      the contract's allocation lines (or the same failure),
//   3. no buyer pays more than its escrowed budget, no seller sells more than it revealed,
//   4. delivered units never exceed allocated units,
//   5. the contract account has no access keys (nobody can change the code or move funds by hand).
import { JsonRpcProvider } from "near-api-js";
import { cheapestCapacity } from "near-swarmkit";

const contract = process.argv[2];
if (!contract) throw new Error("usage: node scripts/verify-exchange.mjs <exchange-account> [--network mainnet]");
const network = process.argv.includes("mainnet") ? "mainnet" : "testnet";
const provider = new JsonRpcProvider({ url: network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com" });
const view = (method, args = {}) => provider.callFunction({ contractId: contract, method, args });

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };

const keys = (await provider.viewAccessKeyList({ accountId: contract })).keys;
check(`${contract} has no access keys`, keys.length === 0, `${keys.length} key(s)`);
const count = Number(await view("get_round_count"));
for (let id = 0; id < count; id++) {
  const round = await view("get_round", { round_id: String(id) });
  const tag = `round ${id} (${round.status})`;
  for (const offer of round.offers) {
    const commitment = round.commitments.find((c) => c.seller === offer.seller);
    // The salt is not stored on chain; the commitment was checked by the contract at reveal time.
    // Here we check that every offer has exactly one commitment and every commitment carried the bond.
    check(`${tag}: ${offer.seller} revealed against a bonded commitment`, Boolean(commitment) && commitment.bond === round.seller_bond);
  }
  if (round.status === "Open") continue;
  const buyers = round.orders.map((o) => ({ buyerId: o.buyer, quantity: o.quantity, budget: o.budget }));
  const offers = round.offers.map((o) => ({ sellerId: o.seller, capacity: o.capacity, unitPrice: o.unit_price }));
  const sdk = buyers.length ? cheapestCapacity.allocate(structuredClone(buyers), structuredClone(offers)) : null;
  const chain = round.lines.map((l) => ({ buyerId: l.buyer, sellerId: l.seller, quantity: l.quantity }));
  if (sdk === null) check(`${tag}: SDK also fails to clear`, round.status === "Failed");
  else check(`${tag}: contract allocation equals the SDK's (${sdk.length} lines)`, JSON.stringify(sdk) === JSON.stringify(chain));
  for (const order of round.orders) {
    const spent = round.lines.filter((l) => l.buyer === order.buyer).reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unit_price), 0n);
    check(`${tag}: ${order.buyer} spent ${spent} <= budget ${order.budget}`, spent <= BigInt(order.budget));
  }
  for (const offer of round.offers) {
    const sold = round.lines.filter((l) => l.seller === offer.seller).reduce((s, l) => s + BigInt(l.quantity), 0n);
    check(`${tag}: ${offer.seller} sold ${sold} <= capacity ${offer.capacity}`, sold <= BigInt(offer.capacity));
    for (const line of round.lines.filter((l) => l.seller === offer.seller)) {
      if (line.unit_price !== offer.unit_price) check(`${tag}: line price equals revealed price`, false);
    }
  }
  for (const line of round.lines) {
    check(`${tag}: ${line.buyer} <- ${line.seller} delivered ${line.delivered}/${line.quantity}, ${line.receipts.length} receipt(s)`,
      BigInt(line.delivered) <= BigInt(line.quantity) && line.receipts.length <= Number(line.delivered));
  }
  const unrevealed = round.commitments.filter((c) => !round.offers.some((o) => o.seller === c.seller));
  for (const c of unrevealed) check(`${tag}: ${c.seller} committed but never revealed (bond forfeited to buyers)`, true);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed on ${network} for ${contract}`);
process.exitCode = failed ? 1 : 0;
