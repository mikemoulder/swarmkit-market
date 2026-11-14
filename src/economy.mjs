import {
  startSimulation, advanceSimulation, replayRound, cheapestCapacity, explainAllocation,
  settlementPlanFromTranscript, executeWithSpendingPolicies, spendingPolicyMessage, auditSettlement,
} from 'near-swarmkit';

export const presets = {
  gpu: { label: 'GPU cooperative', resource: 'GPU compute', unit: 'hour', buyers: 20, sellers: 5 },
  inference: { label: 'Inference exchange', resource: 'Inference capacity', unit: 'credit', buyers: 8, sellers: 4 },
};
const scope = 'swarmkit-market:durable-simulation';
const asset = 'simulation:credits';

function participants(preset) {
  const config = presets[preset];
  return [
    ...Array.from({ length: config.buyers }, (_, i) => ({ id: `buyer-${i + 1}`, role: 'buyer',
      label: `${['Research', 'Indexing', 'Rendering', 'Analysis'][i % 4]} ${Math.floor(i / 4) + 1}`,
      balance: 120, stock: 0, requested: 2 + i % 3, limit: 6 + i % 2, fulfilled: 0,
      policy: 'Buy work capacity within a per-unit cap. Reduce demand when cash is low; earn 8 credits per consumed unit.' })),
    ...Array.from({ length: config.sellers }, (_, i) => ({ id: `seller-${i + 1}`, role: 'seller',
      label: ['Atlas', 'Meridian', 'Harbor', 'Vector', 'Summit'][i],
      balance: 60, stock: 18 + i * 5, capacity: 18 + i * 5, price: 3 + i, floor: 2, sold: 0,
      policy: 'Discount pools of 20+ units by 1 credit. Adjust price after utilization; replenish at 1 credit per unit.' })),
  ];
}

function log(state, actor, action, detail) {
  state.events.push({ sequence: state.events.length + 1, round: state.number, actor, action, detail });
}

function strategies(state) {
  return {
    buyers: state.agents.filter(a => a.role === 'buyer').map(buyer => ({ id: buyer.id, async demand() {
      const quantity = Math.min(buyer.requested, Math.floor(buyer.balance / buyer.limit));
      return quantity ? { quantity: String(quantity), budget: String(quantity * buyer.limit) } : null;
    } })),
    sellers: state.agents.filter(a => a.role === 'seller').map(seller => ({ id: seller.id,
      reveal: !(state.settings.scenario === 'missing' && seller.id === 'seller-1'),
      async offer({ pooledQuantity }) {
        const capacity = state.settings.supply === 'tight' ? Math.min(1, seller.stock) : seller.stock;
        const price = Math.max(seller.floor, seller.price - (BigInt(pooledQuantity) >= 20n ? 1 : 0));
        return capacity ? { capacity: String(capacity), unitPrice: String(price) } : null;
      },
    })),
  };
}

function openRound(state) {
  const config = presets[state.preset];
  const at = state.number * 100;
  state.session = startSimulation({ seed: state.seed + state.number,
    spec: { id: `${state.id}:round-${state.number}`, mechanismId: cheapestCapacity.id, asset,
      resource: { label: config.resource, unit: config.unit, deliveryWindow: `Round ${state.number}` },
      demandCloses: at + 10, commitCloses: at + 20, revealCloses: at + 30 }, ...strategies(state) });
  state.receipts = [];
  state.applied = [];
  state.approvals = null;
  state.interrupted = false;
  state.recovered = false;
  state.settlementStarted = false;
  state.baseline = null;
  state.roundOpening = structuredClone(state.agents);
  log(state, 'coordinator', 'round-opened', `Opened ${config.resource} procurement; decisions have not run yet.`);
}

export function createEconomy({ preset = 'gpu', seed = 2026, id = crypto.randomUUID(), supply = 'normal', scenario = 'interrupted' } = {}) {
  if (!presets[preset] || !Number.isSafeInteger(seed) || !['normal', 'tight'].includes(supply)
    || !['normal', 'interrupted', 'approval', 'missing'].includes(scenario)) throw new Error('Invalid market configuration');
  const state = { version: 1, id, preset, seed, number: 1, settings: { supply, scenario }, agents: participants(preset),
    events: [], history: [], journal: {}, bindings: {}, sent: {}, prepared: 0, broadcasts: 0,
    income: 0, productionCosts: 0, consumed: 0, produced: 0 };
  state.initialMoney = state.agents.reduce((sum, a) => sum + a.balance, 0);
  state.initialStock = state.agents.reduce((sum, a) => sum + a.stock, 0);
  openRound(state);
  return state;
}

export function configureAgent(input, { agentId, requested, limit, price } = {}) {
  const state = structuredClone(input);
  if (state.session.stage !== 'ready') throw new Error('Policies are frozen after demand collection. Open the next round first.');
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Unknown agent');
  const changes = agent.role === 'buyer' ? { requested, limit } : { price };
  for (const [field, value] of Object.entries(changes)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new Error('Policy values must be whole numbers from 1 to 50');
    if (field === 'price' && value < agent.floor) throw new Error(`Seller price must be at least ${agent.floor}`);
    agent[field] = value;
  }
  state.roundOpening = structuredClone(state.agents);
  log(state, agent.id, 'policy-configured', Object.entries(changes).map(([k,v]) => `${k}: ${v}`).join('; '));
  return state;
}

// A capacity-constrained sequential solo-purchase counterfactual using opening inventory.
// Same buyer order, budgets and seller quote policy; no claim of global optimality.
function soloBaseline(state, snapshot) {
  const inventory = state.roundOpening.filter(a => a.role === 'seller').map(a => ({ ...a,
    stock: state.settings.supply === 'tight' ? Math.min(1, a.stock) : a.stock }));
  let total = 0;
  for (const buyer of snapshot.buyers) {
    let left = Number(buyer.quantity), spent = 0;
    const offers = inventory.filter(a => !(state.settings.scenario === 'missing' && a.id === 'seller-1'))
      .map(a => ({ seller: a, price: Math.max(a.floor, a.price - (Number(buyer.quantity) >= 20 ? 1 : 0)) }))
      .sort((a, b) => a.price - b.price || a.seller.id.localeCompare(b.seller.id));
    for (const { seller, price } of offers) {
      const available = seller.stock;
      const units = Math.min(left, available);
      spent += units * price; left -= units; seller.stock -= units;
      if (!left) break;
    }
    if (left || spent > Number(buyer.budget)) return null;
    total += spent;
  }
  return total;
}

async function approvalsFor(state, snapshot, plan) {
  const approvals = [], limited = [], publicKeys = {};
  for (const buyer of snapshot.buyers) {
    const payments = plan.payments.filter(p => p.buyerId === buyer.buyerId);
    if (!payments.length) continue;
    const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    publicKeys[buyer.buyerId] = [...new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))];
    const policy = { roundId: plan.roundId, buyerId: buyer.buyerId, asset, transportScope: scope,
      sellers: [...new Set(payments.map(p => p.sellerId))], maxAmount: buyer.budget, expiresAt: state.number * 100 + 99 };
    const sign = async p => ({ policy: p, signature: [...new Uint8Array(await crypto.subtle.sign('Ed25519', key.privateKey, spendingPolicyMessage(p)))] });
    approvals.push(await sign(policy));
    limited.push(await sign({ ...policy, maxAmount: buyer.buyerId === plan.payments[0]?.buyerId ? '1' : buyer.budget }));
  }
  // Only synthetic approvals and public keys persist. Private signing keys are discarded.
  return { full: approvals, limited, publicKeys };
}

async function settle(state, save) {
  const snapshot = await replayRound(state.session.transcript);
  const plan = await settlementPlanFromTranscript(state.session.transcript);
  if (!state.approvals) state.approvals = await approvalsFor(state, snapshot, plan);
  const first = plan.payments[0]?.id;
  const hold = state.settings.scenario === 'interrupted' && !state.recovered;
  const journal = {
    async read(key) { return state.journal[key]; },
    async reserve(key, entry) { if (!state.journal[key]) { state.journal[key] = entry; state.prepared++; await save(state); } return state.journal[key]; },
    async bindPlan(key, fingerprint) { if (!state.bindings[key]) { state.bindings[key] = fingerprint; await save(state); } return state.bindings[key] === fingerprint; },
  };
  const transport = {
    asset, scope,
    async prepare(payment) {
      const bytes = JSON.stringify(payment);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
      return { bytes, hash: 'sim:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') };
    },
    async broadcast(signed) {
      if (!state.sent[signed.hash]) {
        state.sent[signed.hash] = JSON.parse(signed.bytes); state.broadcasts++;
        log(state, 'transport', 'broadcast', `Recorded simulated transaction ${signed.hash.slice(0, 16)}.`);
        await save(state);
      }
      if (hold && JSON.parse(signed.bytes).id === first) throw new Error('Simulated acknowledgement loss');
    },
    async inspect(payment, hash) {
      if (!state.sent[hash] || (hold && payment.id === first)) return 'pending';
      if (JSON.stringify(state.sent[hash]) !== JSON.stringify(payment)) throw new Error('Receipt mismatch');
      return 'confirmed';
    },
  };
  const records = state.settings.scenario === 'approval' && !state.recovered ? state.approvals.limited : state.approvals.full;
  const result = await executeWithSpendingPolicies(plan, { journal, transport,
    approvals: records.map(a => ({ ...a, signature: Uint8Array.from(a.signature) })),
    resolveBuyerKey: async id => state.approvals.publicKeys[id]
      ? crypto.subtle.importKey('raw', Uint8Array.from(state.approvals.publicKeys[id]), 'Ed25519', false, ['verify']) : undefined,
    clock: () => state.number * 100 + 35,
  });
  state.receipts = result.receipts;
  const lines = snapshot.splitAllocation?.lines ?? [];
  for (const receipt of result.receipts) {
    if (receipt.status !== 'confirmed' || state.applied.includes(receipt.paymentId)) continue;
    const payment = plan.payments.find(p => p.id === receipt.paymentId);
    const line = lines.find(l => l.buyerId === payment.buyerId && l.sellerId === payment.sellerId);
    const buyer = state.agents.find(a => a.id === payment.buyerId), seller = state.agents.find(a => a.id === payment.sellerId);
    buyer.balance -= Number(payment.amount); seller.balance += Number(payment.amount);
    buyer.stock += Number(line.quantity); seller.stock -= Number(line.quantity);
    buyer.fulfilled += Number(line.quantity); seller.sold += Number(line.quantity);
    state.applied.push(payment.id);
    log(state, buyer.id, 'payment-confirmed', `Purchased ${line.quantity} units from ${seller.label} for ${payment.amount} credits.`);
  }
  state.settlementStarted = true;
  state.interrupted = plan.payments.length > 0 && !result.summary.paid;
  await save(state);
}

function renew(state, snapshot) {
  for (const agent of state.agents) {
    if (agent.role === 'buyer') {
      const used = agent.stock;
      agent.stock = 0; agent.balance += used * 8; state.income += used * 8; state.consumed += used;
      log(state, agent.id, 'work-completed', `Consumed ${used} units; earned ${used * 8} simulated external work credits.`);
    } else {
      const offered = snapshot.bids.find(b => b.sellerId === agent.id)?.reveal;
      const sold = (snapshot.splitAllocation?.lines ?? []).filter(l => l.sellerId === agent.id).reduce((n, l) => n + Number(l.quantity), 0);
      const utilization = offered ? sold / Number(offered.capacity) : 0;
      const before = agent.price;
      agent.price = Math.max(agent.floor, Math.min(7, agent.price + (utilization > .85 ? 1 : utilization < .4 ? -1 : 0)));
      const added = Math.min(agent.capacity - agent.stock, Math.floor(agent.capacity * .7), agent.balance);
      agent.stock += added; agent.balance -= added; state.productionCosts += added; state.produced += added;
      log(state, agent.id, 'policy-updated', `${Math.round(utilization * 100)}% utilization: base quote ${before} → ${agent.price}; replenished ${added} units at cost ${added}.`);
    }
  }
}

export async function advanceEconomy(input, save = async () => {}, { resume = false } = {}) {
  const state = structuredClone(input);
  if (state.version !== 1) throw new Error('Unsupported economy checkpoint');
  if (state.session.stage !== 'closed') {
    const previous = state.session.stage;
    state.session = await advanceSimulation(state.session, strategies(state));
    const snapshot = await replayRound(state.session.transcript);
    if (state.session.stage === 'demand') for (const b of snapshot.buyers) log(state, b.buyerId, 'demand', `${b.quantity} units; spend cap ${b.budget}.`);
    if (state.session.stage === 'commit') for (const b of snapshot.bids) log(state, b.sellerId, 'committed', `SHA-256 ${b.commitment.slice(0, 16)}…; offer remains sealed.`);
    if (state.session.stage === 'reveal') for (const b of snapshot.bids) log(state, b.sellerId, 'revealed', b.reveal ? `${b.reveal.capacity} units at ${b.reveal.unitPrice} credits.` : 'Seller did not reveal.');
    if (state.session.stage === 'closed') {
      state.baseline = soloBaseline(state, snapshot);
      log(state, 'coordinator', 'cleared', explainAllocation(snapshot).reason);
    }
    log(state, 'coordinator', 'stage', `${previous} → ${state.session.stage}`);
  } else if (!state.settlementStarted || state.interrupted) {
    if (state.interrupted && !resume) throw new Error('Explicit recovery is required before settlement can continue');
    if (resume) { state.recovered = true; log(state, 'operator', 'recovery', state.settings.scenario === 'approval' ? 'Applied the revised synthetic buyer approval.' : 'Reconciled the stored simulated transaction before sending again.'); }
    await settle(state, save);
  } else {
    const snapshot = await replayRound(state.session.transcript);
    const plan = await settlementPlanFromTranscript(state.session.transcript);
    const total = plan.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    state.history.push({ number: state.number, quantity: snapshot.splitAllocation ? Number(snapshot.quantity) : 0,
      total, baseline: state.baseline, prices: snapshot.bids.filter(b => b.reveal).map(b => ({ sellerId: b.sellerId, price: Number(b.reveal.unitPrice) })),
      transcript: state.session.transcript, receipts: state.receipts });
    renew(state, snapshot);
    state.number++; openRound(state);
  }
  await save(state);
  return state;
}

export async function economyView(state) {
  const snapshot = await replayRound(state.session.transcript);
  const closed = state.session.stage === 'closed';
  const plan = closed ? await settlementPlanFromTranscript(state.session.transcript) : null;
  return {
    mode: 'simulation', id: state.id, preset: state.preset, number: state.number, stage: state.session.stage,
    settings: state.settings, snapshot, plan, agents: state.agents, history: state.history,
    events: state.events, receipts: state.receipts, interrupted: state.interrupted, settled: state.settlementStarted && !state.interrupted,
    explanation: closed ? explainAllocation(snapshot) : null, baseline: state.baseline,
    prepared: state.prepared, broadcasts: state.broadcasts,
    accounting: { initialMoney: state.initialMoney, income: state.income, productionCosts: state.productionCosts,
      money: state.agents.reduce((n, a) => n + a.balance, 0), initialStock: state.initialStock,
      produced: state.produced, consumed: state.consumed, stock: state.agents.reduce((n, a) => n + a.stock, 0) },
    transcript: state.session.transcript,
    audit: closed ? await auditSettlement(state.session.transcript, state.receipts) : null,
  };
}
