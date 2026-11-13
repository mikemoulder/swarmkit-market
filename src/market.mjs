import {
  auditSettlement, cheapestCapacity, executeWithSpendingPolicies, prepareNearIntentsTransfers,
  settlementPlanFromTranscript, simulateProcurement, spendingPolicyMessage, summarizeSettlement,
} from "near-swarmkit";

const asset = "simulation:inference-credits";
const scope = "swarmkit-market:simulation";

export const startingBalances = Object.freeze([
  { id: "research", label: "Research", role: "Buyer", requested: 5, limit: 4, balance: 100, stock: 0 },
  { id: "indexer", label: "Indexer", role: "Buyer", requested: 4, limit: 5, balance: 95, stock: 0 },
  { id: "studio", label: "Studio", role: "Buyer", requested: 3, limit: 6, balance: 80, stock: 0 },
  { id: "ops", label: "Ops", role: "Buyer", requested: 2, limit: 6, balance: 70, stock: 0 },
  { id: "fastlane", label: "Fastlane", role: "Seller", price: 2, balance: 0, stock: 6 },
  { id: "northstar", label: "Northstar", role: "Seller", price: 4, balance: 0, stock: 15 },
  { id: "relay", label: "Relay", role: "Seller", price: 5, balance: 0, stock: 15 },
  { id: "reserve", label: "Reserve", role: "Seller", price: 7, balance: 0, stock: 18 },
].map(Object.freeze));

export function applyReceipts(agents, snapshot, plan, receipts) {
  const observed = new Map(receipts.map((receipt) => [receipt.paymentId, receipt.status]));
  const lines = new Map((snapshot.splitAllocation?.lines ?? []).map((line) =>
    [JSON.stringify([line.buyerId, line.sellerId]), Number(line.quantity)]));
  const ledger = new Map(agents.map((agent) => [agent.id, { ...agent }]));
  for (const payment of plan.payments) {
    if (observed.get(payment.id) !== "confirmed") continue;
    const buyer = ledger.get(payment.buyerId);
    const seller = ledger.get(payment.sellerId);
    const quantity = lines.get(JSON.stringify([buyer.id, seller.id]));
    buyer.balance -= Number(payment.amount);
    seller.balance += Number(payment.amount);
    buyer.stock += quantity;
    seller.stock -= quantity;
  }
  return [...ledger.values()];
}

export async function openMarketRound({ number, agents, tightSupply = false }) {
  const buyers = agents.filter((agent) => agent.role === "Buyer");
  const sellers = agents.filter((agent) => agent.role === "Seller");
  const result = await simulateProcurement({
    seed: 2026 + number,
    spec: {
      id: `inference-${number}`, mechanismId: cheapestCapacity.id, asset,
      resource: { label: "Inference credits", unit: "credit", deliveryWindow: "This round" },
      demandCloses: 10, commitCloses: 20, revealCloses: 30,
    },
    buyers: buyers.map((buyer) => ({
      id: buyer.id,
      demand() {
        const quantity = Math.min(buyer.requested, Math.floor(buyer.balance / buyer.limit));
        return quantity > 0 ? { quantity: String(quantity), budget: String(quantity * buyer.limit) } : null;
      },
    })),
    sellers: sellers.map((seller) => ({
      id: seller.id,
      offer() {
        const capacity = tightSupply ? Math.min(1, seller.stock) : seller.stock;
        return capacity ? { capacity: String(capacity), unitPrice: String(seller.price) } : null;
      },
    })),
  });
  const plan = await settlementPlanFromTranscript(result.transcript);
  return { ...result, plan };
}

export async function createSimulatedSettlement(round, { holdFirst = true, lowerFirstCap = false } = {}) {
  const entries = new Map();
  const plans = new Map();
  const sent = new Map();
  const keys = new Map();
  const payments = new Map(round.plan.payments.map((payment) => [payment.id, payment]));
  const approvals = [];
  const first = round.plan.payments[0];
  let paused = holdFirst;
  let prepared = 0;
  let sends = 0;
  const clock = () => 35;
  const journal = {
    async read(key) { return entries.get(key); },
    async reserve(key, entry) {
      if (!entries.has(key)) entries.set(key, entry);
      return entries.get(key);
    },
    async bindPlan(key, fingerprint) {
      if (!plans.has(key)) plans.set(key, fingerprint);
      return plans.get(key) === fingerprint;
    },
  };
  const transport = {
    scope,
    asset,
    async prepare(payment) {
      prepared++;
      const bytes = JSON.stringify(payment);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      return { hash: `sim:${hash}`, bytes };
    },
    async broadcast(signed) {
      sends++;
      const payment = JSON.parse(signed.bytes);
      sent.set(signed.hash, payment);
      if (paused && payment.id === first?.id) throw new Error("Simulated missing broadcast acknowledgement");
    },
    async inspect(payment, hash) {
      const observed = sent.get(hash);
      if (!observed || (paused && payment.id === first?.id)) return "pending";
      if (JSON.stringify(observed) !== JSON.stringify(payments.get(payment.id))) throw new Error("Receipt differs from payment");
      return "confirmed";
    },
  };

  for (const buyer of round.stages[3].buyers) {
    const shares = round.plan.payments.filter((payment) => payment.buyerId === buyer.buyerId);
    if (!shares.length) continue;
    const key = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    keys.set(buyer.buyerId, key);
    const policy = {
      roundId: round.plan.roundId, buyerId: buyer.buyerId, asset, transportScope: scope,
      sellers: [...new Set(shares.map(({ sellerId }) => sellerId))],
      maxAmount: buyer.budget, expiresAt: 60,
    };
    const signature = await crypto.subtle.sign("Ed25519", key.privateKey, spendingPolicyMessage(policy));
    approvals.push({ policy, signature: new Uint8Array(signature) });
  }
  let limitedApprovals = approvals;
  if (lowerFirstCap && first) {
    const policy = { ...approvals.find(({ policy }) => policy.buyerId === first.buyerId).policy, maxAmount: "1" };
    const key = keys.get(first.buyerId);
    const signature = await crypto.subtle.sign("Ed25519", key.privateKey, spendingPolicyMessage(policy));
    limitedApprovals = approvals.map((approval) =>
      approval.policy.buyerId === first.buyerId ? { policy, signature: new Uint8Array(signature) } : approval);
  }

  return {
    async run({ resume = false } = {}) {
      if (resume) paused = false;
      const result = await executeWithSpendingPolicies(round.plan, {
        transport, journal, clock,
        approvals: resume ? approvals : limitedApprovals,
        resolveBuyerKey: async (id) => keys.get(id)?.publicKey,
      });
      const audit = await auditSettlement(round.transcript, result.receipts, { verifier: transport });
      return { ...result, audit, prepared, sends };
    },
  };
}

export function makeIntentsPreview(plan) {
  const baseUnits = 10n ** 20n;
  return prepareNearIntentsTransfers({
    ...plan,
    asset: "nep141:wrap.near",
    payments: plan.payments.map((payment) => {
      const buyerId = payment.buyerId + ".swarmkit.near";
      const sellerId = payment.sellerId + ".swarmkit.near";
      return {
        id: JSON.stringify([plan.roundId, buyerId, sellerId]),
        buyerId, sellerId, amount: String(BigInt(payment.amount) * baseUnits),
      };
    }),
  }, { salt: "00000000", deadline: new Date(Date.now() + 5 * 60_000) })
    .map(({ recipient, message }) => ({ recipient, message: JSON.parse(message) }));
}

export function pendingSummary(plan) {
  return summarizeSettlement(plan, []);
}
