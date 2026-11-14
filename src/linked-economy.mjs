// A two-tier agent economy on near-swarmkit.
// GPU sellers sell hours to research labs and to inference providers. Providers turn the hours they win into
// inference batches and sell those to apps. Both markets clear every tick as sealed-bid SDK rounds with split
// fulfillment, so a change in one market reaches the other only through the agents' own decisions.
// Everything is deterministic from the seed: the same seed and the same actions give the same history.
import { simulateProcurement, cheapestCapacity } from 'near-swarmkit';

export const YIELD = 2;              // inference batches produced from one GPU hour
export const SHOCK_TICKS = 4;        // how long a supply shock lasts
export const SHOCK_FACTOR = 0.3;     // share of nameplate capacity left to the shocked sellers
const ASSET = 'simulation:credits';
const FEED_LIMIT = 900;

const roster = () => ({
  gpuSellers: [
    { id: 'atlas', label: 'Atlas', strategy: 'undercut', about: 'Undercuts the last clearing price when its hours go unsold.', nameplate: 40, cost: 2, floor: 3, ceiling: 14, ask: 5, shocked: true },
    { id: 'meridian', label: 'Meridian', strategy: 'utilization', about: 'Raises its ask when it sells out, lowers it when hours sit idle.', nameplate: 36, cost: 2, floor: 3, ceiling: 14, ask: 5, shocked: true },
    { id: 'harbor', label: 'Harbor', strategy: 'cost-plus', about: 'Always asks its cost plus a fixed margin of 2.', nameplate: 30, cost: 3, floor: 5, ceiling: 5, ask: 5, shocked: false },
    { id: 'summit', label: 'Summit', strategy: 'premium', about: 'Holds a premium price; cuts only after two unsold rounds, raises when the market sells out.', nameplate: 24, cost: 3, floor: 5, ceiling: 16, ask: 8, shocked: false },
  ],
  labs: [
    { id: 'lab-orbit', label: 'Orbit Lab', strategy: 'deadline', about: 'Must train on schedule: raises its cap by 1 for every round it goes short.', need: 14, cap: 6, capMax: 11, cash: 240, income: 80 },
    { id: 'lab-quartz', label: 'Quartz Lab', strategy: 'bargain', about: 'Buys only when the last GPU price is at or under 5; otherwise waits.', need: 12, cap: 5, capMax: 5, cash: 200, income: 60 },
    { id: 'lab-fjord', label: 'Fjord Lab', strategy: 'steady', about: 'Buys the same 10 hours every round, up to 7 an hour.', need: 10, cap: 7, capMax: 7, cash: 220, income: 70 },
    { id: 'lab-cobalt', label: 'Cobalt Lab', strategy: 'patient', about: 'Buys double when the price is under its 3-round average, skips when above.', need: 8, cap: 6, capMax: 6, cash: 200, income: 60 },
  ],
  providers: [
    { id: 'relay', label: 'Relay', strategy: 'cost-plus', about: 'Prices batches at its own GPU cost plus 1.', cash: 320, expected: 24, price: 4, batches: 0, cost: 0, sold: 0 },
    { id: 'tessel', label: 'Tessel', strategy: 'follower', about: 'Matches the last inference price, never below its own cost.', cash: 320, expected: 24, price: 4, batches: 0, cost: 0, sold: 0 },
    { id: 'ridge', label: 'Ridge', strategy: 'aggressive', about: 'Sells at cost to win volume; adds a margin only after selling out.', cash: 320, expected: 24, price: 4, batches: 0, cost: 0, sold: 0 },
  ],
  apps: [
    { id: 'app-chat', label: 'Chat app', strategy: 'sensitive', about: 'Pays at most 4 a batch; drops usage when priced out.', need: 10, cap: 4, capMax: 4, cash: 160, income: 45 },
    { id: 'app-search', label: 'Search app', strategy: 'steady', about: 'Pays up to 6 a batch for a steady load.', need: 9, cap: 6, capMax: 6, cash: 160, income: 50 },
    { id: 'app-voice', label: 'Voice app', strategy: 'deadline', about: 'Raises its cap by 1 for every round it goes short.', need: 8, cap: 5, capMax: 9, cash: 160, income: 50 },
    { id: 'app-code', label: 'Code assistant', strategy: 'patient', about: 'Buys when the price is under its 3-round average.', need: 9, cap: 6, capMax: 6, cash: 160, income: 45 },
    { id: 'app-vision', label: 'Vision app', strategy: 'sensitive', about: 'Pays at most 5 a batch; drops usage when priced out.', need: 8, cap: 5, capMax: 5, cash: 150, income: 40 },
    { id: 'app-translate', label: 'Translate app', strategy: 'steady', about: 'Pays up to 7 a batch for a steady load.', need: 7, cap: 7, capMax: 7, cash: 150, income: 45 },
    { id: 'app-agents', label: 'Agent platform', strategy: 'deadline', about: 'Raises its cap by 1 for every round it goes short.', need: 10, cap: 5, capMax: 10, cash: 170, income: 55 },
    { id: 'app-docs', label: 'Docs app', strategy: 'patient', about: 'Buys when the price is under its 3-round average.', need: 7, cap: 5, capMax: 5, cash: 140, income: 40 },
  ],
});

export function createEconomy(seed = 2026) {
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be an integer');
  const agents = roster();
  for (const list of [agents.labs, agents.apps]) for (const a of list) Object.assign(a, { short: 0, got: 0 });
  for (const s of agents.gpuSellers) Object.assign(s, { cash: 0, sold: 0, offered: 0, unsold: 0 });
  const cash = sumCash(agents);
  return {
    version: 1, seed, tick: 0, shock: 0,
    agents,
    last: { gpu: 5, inference: 4 },
    history: [], feed: [], rounds: null,
    ledger: { opening: cash, income: 0, production: 0, payments: 0, rounds: 0 },
  };
}

export function sumCash(agents) {
  return [...agents.gpuSellers, ...agents.labs, ...agents.providers, ...agents.apps].reduce((t, a) => t + a.cash, 0);
}

export function startShock(economy) {
  const next = structuredClone(economy);
  next.shock = SHOCK_TICKS;
  log(next, 'event', 'gpu', null, `Supply shock: Atlas and Meridian lose ${Math.round((1 - SHOCK_FACTOR) * 100)}% of their GPU capacity for ${SHOCK_TICKS} rounds.`);
  return next;
}

function log(economy, kind, market, agent, text) {
  economy.feed.push({ tick: economy.tick, kind, market, agent, text });
  if (economy.feed.length > FEED_LIMIT) economy.feed.splice(0, economy.feed.length - FEED_LIMIT);
}

const avg3 = (economy, key) => {
  const recent = economy.history.slice(-3).map(h => h[key].price).filter(p => p > 0);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : economy.last[key];
};

// Buyer decisions shared by labs (GPU) and apps (inference).
function buyerDemand(economy, buyer, key, unit) {
  const last = economy.last[key];
  let quantity = buyer.need, cap = buyer.cap, why;
  switch (buyer.strategy) {
    case 'deadline':
      cap = Math.min(buyer.capMax, buyer.cap + buyer.short);
      why = buyer.short ? `went short ${buyer.short} round${buyer.short > 1 ? 's' : ''}, so raises its cap to ${cap}` : `bids ${quantity} ${plural(unit)} at up to ${cap}`;
      break;
    case 'bargain':
      if (last > cap) { log(economy, 'skip', key, buyer.id, `${buyer.label} waits: last price ${fmt(last)} is above its limit of ${cap}.`); return null; }
      why = `last price ${fmt(last)} is within its limit of ${cap}`;
      break;
    case 'patient': {
      const average = avg3(economy, key);
      if (economy.history.length >= 2 && last > average + 0.25) { log(economy, 'skip', key, buyer.id, `${buyer.label} skips: ${fmt(last)} is above its 3-round average of ${fmt(average)}.`); return null; }
      if (economy.history.length >= 2 && last < average - 0.25) { quantity = buyer.need * 2; why = `${fmt(last)} is under its average of ${fmt(average)}, so it buys double`; }
      else why = `buys its usual ${quantity}: the price is near its average of ${fmt(average)}`;
      break;
    }
    case 'sensitive':
      if (last > cap + 1) { quantity = Math.max(2, Math.floor(buyer.need / 2)); why = `last price ${fmt(last)} is over its cap of ${cap}, so it halves its usage`; }
      else why = `bids ${quantity} ${plural(unit)} at up to ${cap}`;
      break;
    default:
      why = `bids its usual ${quantity} ${plural(unit)} at up to ${cap}`;
  }
  const affordable = Math.floor(buyer.cash / cap);
  if (affordable < quantity) { quantity = affordable; why += `, cut to ${quantity} by its cash`; }
  if (quantity <= 0) { log(economy, 'skip', key, buyer.id, `${buyer.label} has no cash left to bid.`); return null; }
  log(economy, 'demand', key, buyer.id, `${buyer.label} ${why}.`);
  return { quantity, cap };
}

function gpuAsk(economy, seller) {
  const capacity = economy.shock > 0 && seller.shocked ? Math.floor(seller.nameplate * SHOCK_FACTOR) : seller.nameplate;
  const utilization = seller.offered ? seller.sold / seller.offered : 0.6;
  let ask = seller.ask, why;
  switch (seller.strategy) {
    case 'undercut':
      if (economy.tick > 0 && utilization < 0.5) { ask = Math.max(seller.floor, Math.ceil(economy.last.gpu) - 1); why = `sold ${pct(utilization)} last round, so it undercuts to ${ask}`; }
      else if (utilization > 0.9) { ask = Math.min(seller.ceiling, seller.ask + 1); why = `sold out, so it tests ${ask}`; }
      else why = `holds ${ask}`;
      break;
    case 'utilization':
      if (utilization > 0.85) { ask = Math.min(seller.ceiling, seller.ask + 1); why = `raises to ${ask} at ${pct(utilization)} utilisation`; }
      else if (utilization < 0.4) { ask = Math.max(seller.floor, seller.ask - 1); why = `lowers to ${ask} at ${pct(utilization)} utilisation`; }
      else why = `holds ${ask} at ${pct(utilization)} utilisation`;
      break;
    case 'premium': {
      const soldOut = economy.history.at(-1)?.gpu.shortfall > 0;
      if (soldOut) { ask = Math.min(seller.ceiling, seller.ask + 1); why = `raises to ${ask} because the market went short`; }
      else if (seller.unsold >= 2) { ask = Math.max(seller.floor, seller.ask - 1); why = `cuts to ${ask} after ${seller.unsold} unsold rounds`; }
      else why = `holds its premium of ${ask}`;
      break;
    }
    default: ask = seller.cost + 2; why = `asks cost ${seller.cost} plus 2`;
  }
  seller.ask = ask;
  log(economy, 'offer', 'gpu', seller.id, `${seller.label} ${why}${capacity < seller.nameplate ? `, with only ${capacity} of ${seller.nameplate} hours after the shock` : ''}.`);
  return { capacity, ask };
}

function providerPlan(economy, provider) {
  const expectedPrice = Math.max(economy.last.inference, provider.price);
  const cap = Math.max(1, Math.floor(expectedPrice * YIELD * 0.9));
  const hours = Math.max(2, Math.ceil(provider.expected / YIELD));
  const affordable = Math.floor(provider.cash / cap);
  const quantity = Math.min(hours, affordable);
  if (quantity <= 0) { log(economy, 'skip', 'gpu', provider.id, `${provider.label} cannot afford GPU hours this round.`); return null; }
  log(economy, 'demand', 'gpu', provider.id, `${provider.label} expects to sell ${provider.expected} batches, so it bids for ${quantity} GPU hours at up to ${cap} (inference near ${fmt(expectedPrice)}).`);
  return { quantity, cap };
}

function providerAsk(economy, provider) {
  if (!provider.batches) { log(economy, 'skip', 'inference', provider.id, `${provider.label} won no GPU hours, so it sits out the inference round.`); return null; }
  const cost = Math.ceil(provider.cost);
  let ask, why;
  switch (provider.strategy) {
    case 'follower': ask = Math.max(cost, Math.round(economy.last.inference)); why = `matches the last price of ${fmt(economy.last.inference)} (its cost is ${fmt(provider.cost)})`; break;
    case 'aggressive': {
      const share = provider.lastBatches ? provider.sold / provider.lastBatches : 0;
      provider.margin = share >= 0.95 ? 1 : share < 0.6 ? 0 : provider.margin ?? 0;
      ask = Math.max(1, cost + provider.margin);
      why = provider.margin ? `sold ${pct(share)} of its batches last round, so it keeps a margin and asks ${ask}` : `sells at cost, ${ask}, to win volume`;
      break;
    }
    default: ask = cost + 1; why = `asks its GPU cost ${fmt(provider.cost)} plus 1: ${ask}`;
  }
  provider.price = ask;
  log(economy, 'offer', 'inference', provider.id, `${provider.label} has ${provider.batches} batches and ${why}.`);
  return { capacity: provider.batches, ask };
}

// One market: sealed-bid SDK rounds with split fulfillment. If the pool cannot be filled within every cap,
// the buyer with the lowest cap is released and the round runs again with the same sealed offers.
async function clearMarket(economy, key, unit, buyers, sellers) {
  let admitted = buyers.filter(b => b.order);
  const offers = sellers.filter(s => s.offer);
  const released = [];
  let attempt = 0;
  while (admitted.length && offers.length) {
    attempt += 1;
    const result = await simulateProcurement({
      seed: economy.seed + economy.tick * 97 + (key === 'gpu' ? 1 : 2),
      mechanism: cheapestCapacity,
      spec: {
        id: `${key}-${economy.tick}-${attempt}`, mechanismId: cheapestCapacity.id, asset: ASSET,
        resource: { label: key === 'gpu' ? 'GPU hours' : 'Inference batches', unit, deliveryWindow: `Round ${economy.tick}` },
        demandCloses: 10, commitCloses: 20, revealCloses: 30,
      },
      buyers: admitted.map(b => ({ id: b.agent.id, demand: () => ({ quantity: String(b.order.quantity), budget: String(b.order.quantity * b.order.cap) }) })),
      sellers: offers.map(s => ({ id: s.agent.id, offer: () => ({ capacity: String(s.offer.capacity), unitPrice: String(s.offer.ask) }) })),
    });
    economy.ledger.rounds += 1;
    const closed = result.stages.at(-1);
    if (closed.splitAllocation) return { result, closed, admitted, released, attempts: attempt };
    const weakest = [...admitted].sort((a, b) => a.order.cap - b.order.cap || b.order.quantity - a.order.quantity || (a.agent.id < b.agent.id ? -1 : 1))[0];
    released.push(weakest);
    log(economy, 'release', key, weakest.agent.id, `Coordinator releases ${weakest.agent.label} (cap ${weakest.order.cap}): the remaining ${plural(unit)} cost more than it will pay. Round ${key === 'gpu' ? 'GPU' : 'inference'} re-runs with ${admitted.length - 1} buyers.`);
    admitted = admitted.filter(b => b !== weakest);
  }
  return { result: null, closed: null, admitted, released, attempts: attempt };
}

function summarise(key, cleared, buyers, sellers) {
  const lines = cleared.closed?.splitAllocation?.lines ?? [];
  const volume = lines.reduce((t, l) => t + Number(l.quantity), 0);
  const total = lines.reduce((t, l) => t + Number(l.amount), 0);
  const requested = buyers.filter(b => b.order).reduce((t, b) => t + b.order.quantity, 0);
  const offered = sellers.filter(s => s.offer).reduce((t, s) => t + s.offer.capacity, 0);
  const bids = (cleared.closed?.bids ?? []).map(b => ({ sellerId: b.sellerId, commitment: b.commitment, price: Number(b.reveal?.unitPrice ?? 0), capacity: Number(b.reveal?.capacity ?? 0), rejection: b.rejection }));
  return {
    price: volume ? total / volume : 0, volume, total, requested, offered,
    shortfall: Math.max(0, requested - volume), released: cleared.released.map(b => b.agent.id), attempts: cleared.attempts,
    lines: lines.map(l => ({ buyerId: l.buyerId, sellerId: l.sellerId, quantity: Number(l.quantity), price: Number(l.unitPrice), amount: Number(l.amount) })),
    bids, payments: cleared.result?.plan.payments.length ?? 0, roundId: cleared.closed?.spec.id ?? null,
    transcript: cleared.result?.transcript ?? null,
  };
}

export async function stepEconomy(input) {
  const economy = structuredClone(input);
  economy.tick += 1;
  const { gpuSellers, labs, providers, apps } = economy.agents;
  log(economy, 'tick', null, null, `Round ${economy.tick} opens${economy.shock > 0 ? ` during the supply shock (${economy.shock} round${economy.shock > 1 ? 's' : ''} left)` : ''}.`);

  // Income arrives before anyone bids.
  for (const a of [...labs, ...apps]) { a.cash += a.income; economy.ledger.income += a.income; }

  // GPU market: labs and inference providers buy from GPU sellers.
  const gpuBuyers = [...labs.map(agent => ({ agent, order: buyerDemand(economy, agent, 'gpu', 'hour') })),
    ...providers.map(agent => ({ agent, order: providerPlan(economy, agent) }))];
  const gpuOffers = gpuSellers.map(agent => {
    const { capacity, ask } = gpuAsk(economy, agent);
    return { agent, offer: capacity > 0 ? { capacity, ask } : null };
  });
  const gpuCleared = await clearMarket(economy, 'gpu', 'hour', gpuBuyers, gpuOffers);
  const gpu = summarise('gpu', gpuCleared, gpuBuyers, gpuOffers);

  const won = new Map(), spent = new Map(), sold = new Map();
  for (const l of gpu.lines) {
    won.set(l.buyerId, (won.get(l.buyerId) ?? 0) + l.quantity);
    spent.set(l.buyerId, (spent.get(l.buyerId) ?? 0) + l.amount);
    sold.set(l.sellerId, (sold.get(l.sellerId) ?? 0) + l.quantity);
  }
  for (const s of gpuSellers) {
    const offer = gpuOffers.find(o => o.agent === s).offer;
    const hours = sold.get(s.id) ?? 0, revenue = gpu.lines.filter(l => l.sellerId === s.id).reduce((t, l) => t + l.amount, 0);
    s.offered = offer?.capacity ?? 0; s.sold = hours; s.unsold = hours ? 0 : s.unsold + 1;
    s.cash += revenue - hours * s.cost; economy.ledger.production += hours * s.cost;
  }
  for (const b of gpuBuyers) {
    const got = won.get(b.agent.id) ?? 0;
    b.agent.cash -= spent.get(b.agent.id) ?? 0;
    if (b.agent.need !== undefined) { b.agent.got = got; b.agent.short = b.order && got < b.order.quantity ? b.agent.short + 1 : 0; }
  }
  for (const p of providers) {
    const hours = won.get(p.id) ?? 0;
    p.lastBatches = p.batches;
    p.batches = hours * YIELD;
    p.cost = p.batches ? (spent.get(p.id) ?? 0) / p.batches : 0;
  }
  if (gpu.volume) economy.last.gpu = gpu.price;
  log(economy, 'clear', 'gpu', null, gpu.volume
    ? `GPU round clears ${gpu.volume} of ${gpu.requested} hours at an average ${fmt(gpu.price)}${gpu.attempts > 1 ? ` after ${gpu.attempts} attempts` : ''}; ${gpu.payments} payments planned.`
    : `GPU round clears nothing: ${gpu.requested ? 'no allocation fits the caps' : 'no demand'}.`);

  // Inference market: apps buy batches that providers made from the GPU hours they won.
  const infBuyers = apps.map(agent => ({ agent, order: buyerDemand(economy, agent, 'inference', 'batch') }));
  const infOffers = providers.map(agent => {
    const plan = providerAsk(economy, agent);
    return { agent, offer: plan ? { capacity: plan.capacity, ask: plan.ask } : null };
  });
  const infCleared = await clearMarket(economy, 'inference', 'batch', infBuyers, infOffers);
  const inference = summarise('inference', infCleared, infBuyers, infOffers);

  const got = new Map(), paid = new Map(), revenue = new Map();
  for (const l of inference.lines) {
    got.set(l.buyerId, (got.get(l.buyerId) ?? 0) + l.quantity);
    paid.set(l.buyerId, (paid.get(l.buyerId) ?? 0) + l.amount);
    revenue.set(l.sellerId, (revenue.get(l.sellerId) ?? 0) + l.amount);
  }
  for (const b of infBuyers) {
    const units = got.get(b.agent.id) ?? 0;
    b.agent.cash -= paid.get(b.agent.id) ?? 0;
    b.agent.got = units;
    const short = b.order && units < b.order.quantity;
    b.agent.short = short ? b.agent.short + 1 : 0;
    // Apps grow when they are served at a price they accept, and shrink when they are priced out.
    if (b.order && !short && b.order.quantity >= b.agent.need && b.agent.cash >= (b.agent.need + 1) * b.order.cap) b.agent.need = Math.min(b.agent.need + 1, 20);
    else if (short && b.agent.need > 3) b.agent.need -= 1;
  }
  for (const p of providers) {
    const units = inference.lines.filter(l => l.sellerId === p.id).reduce((t, l) => t + l.quantity, 0);
    p.cash += revenue.get(p.id) ?? 0;
    p.sold = units;
    p.expected = Math.max(8, units + (units && units >= p.batches ? 4 : 0));
  }
  if (inference.volume) economy.last.inference = inference.price;
  log(economy, 'clear', 'inference', null, inference.volume
    ? `Inference round clears ${inference.volume} of ${inference.requested} batches at an average ${fmt(inference.price)}${inference.attempts > 1 ? ` after ${inference.attempts} attempts` : ''}; ${inference.payments} payments planned.`
    : `Inference round clears nothing: ${inference.requested ? 'no allocation fits the caps' : 'no demand'}.`);

  const costs = providers.filter(p => p.batches).map(p => p.cost);
  economy.ledger.payments += gpu.payments + inference.payments;
  economy.history.push({
    tick: economy.tick, shock: economy.shock > 0,
    gpu: strip(gpu), inference: strip(inference),
    providerCost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
  });
  economy.rounds = { gpu, inference };
  if (economy.shock > 0) {
    economy.shock -= 1;
    if (!economy.shock) log(economy, 'event', 'gpu', null, 'Supply shock ends: Atlas and Meridian are back to full capacity next round.');
  }
  return economy;
}

const strip = ({ transcript, bids, lines, ...rest }) => rest;
const fmt = n => (Math.round(n * 100) / 100).toString();
const plural = u => (u === 'batch' ? 'batches' : `${u}s`);
const pct = n => `${Math.round(n * 100)}%`;
