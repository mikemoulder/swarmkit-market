// A GPU co-op run by agents, on near-swarmkit.
// Twenty small AI teams each send an agent with a weekly need and a top price. The agents pool their demand,
// five GPU providers' agents bid sealed, and the SDK clears the pool with split fulfillment: every team pays
// only for its own hours, at the price of the provider that served it. Amounts are integer US cents.
// Deterministic from the seed and the team's own requests.
import { simulateProcurement, cheapestCapacity } from 'near-swarmkit';

export const YOU = 'your-team';
const ASSET = 'usd-cents:simulated';
const FEED_LIMIT = 600;

const providers = () => [
  { id: 'atlas-compute', label: 'Atlas Compute', strategy: 'undercut', about: 'Undercuts last week’s pool price when its GPUs sat idle.', capacity: 110, cost: 180, floor: 200, ceiling: 420, ask: 245, list: 329 },
  { id: 'meridian-cloud', label: 'Meridian Cloud', strategy: 'utilization', about: 'Raises its bid when it sells out, lowers it when GPUs sit idle.', capacity: 90, cost: 180, floor: 210, ceiling: 420, ask: 255, list: 339 },
  { id: 'harbor-gpu', label: 'Harbor GPU', strategy: 'cost-plus', about: 'Always bids its running cost plus 60¢ an hour.', capacity: 80, cost: 190, floor: 250, ceiling: 250, ask: 250, list: 319 },
  { id: 'summit-cloud', label: 'Summit Cloud', strategy: 'premium', about: 'Holds a premium; cuts only after two unsold weeks, raises when the pool goes short.', capacity: 60, cost: 200, floor: 260, ceiling: 460, ask: 320, list: 389 },
  { id: 'northbeam', label: 'Northbeam', strategy: 'volume', about: 'Bids 30¢ lower when the pool is at least 300 hours.', capacity: 50, cost: 190, floor: 230, ceiling: 400, ask: 275, list: 349 },
];

const teams = () => [
  { id: 'fernway-ai', label: 'Fernway AI', work: 'fine-tunes support models', strategy: 'deadline', hours: 24, cap: 320 },
  { id: 'kiln-robotics', label: 'Kiln Robotics', work: 'trains grasping policies', strategy: 'bargain', hours: 16, cap: 280 },
  { id: 'tidewater-labs', label: 'Tidewater Labs', work: 'runs weather forecasts', strategy: 'steady', hours: 20, cap: 340 },
  { id: 'pillar-health', label: 'Pillar Health', work: 'evaluates clinical models', strategy: 'patient', hours: 12, cap: 300 },
  { id: 'orchard-vision', label: 'Orchard Vision', work: 'labels crop imagery', strategy: 'steady', hours: 30, cap: 360 },
  { id: 'brightline-legal', label: 'Brightline Legal', work: 'indexes contracts', strategy: 'sensitive', hours: 10, cap: 260 },
  { id: 'saltmarsh-bio', label: 'Saltmarsh Bio', work: 'folds proteins', strategy: 'deadline', hours: 28, cap: 330 },
  { id: 'quill-ed', label: 'Quill Ed', work: 'grades essays', strategy: 'bargain', hours: 8, cap: 270 },
  { id: 'ironleaf-games', label: 'Ironleaf Games', work: 'trains game bots', strategy: 'steady', hours: 18, cap: 310 },
  { id: 'cinder-audio', label: 'Cinder Audio', work: 'separates music stems', strategy: 'patient', hours: 14, cap: 300 },
  { id: 'ember-translate', label: 'Ember Translate', work: 'serves translation', strategy: 'sensitive', hours: 12, cap: 280 },
  { id: 'granite-finance', label: 'Granite Finance', work: 'backtests risk models', strategy: 'steady', hours: 22, cap: 380 },
  { id: 'vale-search', label: 'Vale Search', work: 'rebuilds a search index', strategy: 'deadline', hours: 16, cap: 300 },
  { id: 'mosaic-design', label: 'Mosaic Design', work: 'renders product images', strategy: 'bargain', hours: 10, cap: 290 },
  { id: 'harrow-agri', label: 'Harrow Agri', work: 'maps soil moisture', strategy: 'steady', hours: 12, cap: 300 },
  { id: 'lattice-chem', label: 'Lattice Chem', work: 'screens molecules', strategy: 'patient', hours: 26, cap: 340 },
  { id: 'wren-voice', label: 'Wren Voice', work: 'clones narration voices', strategy: 'sensitive', hours: 9, cap: 270 },
  { id: 'basalt-security', label: 'Basalt Security', work: 'scans code for bugs', strategy: 'steady', hours: 15, cap: 350 },
  { id: 'driftwood-media', label: 'Driftwood Media', work: 'transcribes podcasts', strategy: 'deadline', hours: 18, cap: 310 },
];

const ABOUT = {
  deadline: 'Has a deadline: raises its budget by 20¢ an hour for every week it goes short.',
  bargain: 'Joins only when last week’s pool price was within its budget per hour.',
  steady: 'Buys the same hours every week within the same budget.',
  patient: 'Buys double when the price is under its 3-week average, skips when above.',
  sensitive: 'Halves its order when last week’s price was over its budget per hour.',
  you: 'Your request, exactly as you set it.',
};

export function createCoop(seed = 2026, request = { name: 'Your team', hours: 30, cap: 300 }) {
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be an integer');
  const roster = teams().map(t => ({ ...t, about: ABOUT[t.strategy], short: 0, got: 0 }));
  roster.unshift({ id: YOU, label: request.name, work: 'your workload', strategy: 'you', about: ABOUT.you, hours: request.hours, cap: request.cap, short: 0, got: 0 });
  return {
    version: 1, seed, week: 0, shock: 0,
    providers: providers().map(p => ({ ...p, sold: 0, offered: p.capacity, unsold: 0 })),
    teams: roster, last: 260, history: [], feed: [], report: null,
    totals: { rounds: 0, payments: 0, savedYou: 0, savedAll: 0 },
  };
}

export function setRequest(state, { name, hours, cap }) {
  const next = structuredClone(state);
  if (!Number.isInteger(hours) || hours < 1 || hours > 200) throw new Error('Hours must be a whole number from 1 to 200');
  if (!Number.isInteger(cap) || cap < 100 || cap > 2000) throw new Error('Top price must be from $1.00 to $20.00 an hour');
  const you = next.teams.find(t => t.id === YOU);
  Object.assign(you, { label: String(name || 'Your team').slice(0, 40), hours, cap });
  return next;
}

export function startShock(state, weeks = 3) {
  const next = structuredClone(state);
  next.shock = weeks;
  log(next, 'event', null, `Outage: Atlas Compute and Meridian Cloud lose 70% of their GPUs for ${weeks} weeks.`);
  return next;
}

export const usd = cents => `$${(cents / 100).toFixed(2)}`;
const log = (state, kind, agent, text) => {
  state.feed.push({ week: state.week, kind, agent, text });
  if (state.feed.length > FEED_LIMIT) state.feed.splice(0, state.feed.length - FEED_LIMIT);
};
const average3 = state => {
  const recent = state.history.slice(-3).map(h => h.price).filter(Boolean);
  return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : state.last;
};

function teamOrder(state, team) {
  let hours = team.hours, cap = team.cap, reason;
  switch (team.strategy) {
    case 'you': reason = `asks for ${hours} hours with a budget of ${usd(hours * cap)} (${usd(cap)} an hour on average)`; break;
    case 'deadline':
      cap = team.cap + 20 * team.short;
      reason = team.short ? `went short ${team.short} week${team.short > 1 ? 's' : ''}, so it now pays up to ${usd(cap)} an hour on average` : `needs ${hours} hours this week, up to ${usd(cap)} an hour on average`;
      break;
    case 'bargain':
      if (state.week > 1 && state.last > cap) return { skip: `waits: last week’s ${usd(state.last)} an hour is over its budget of ${usd(cap)} an hour` };
      reason = `joins at up to ${usd(cap)} an hour on average`;
      break;
    case 'patient': {
      const avg = average3(state);
      if (state.history.length >= 2 && state.last > avg + 5) return { skip: `skips: ${usd(state.last)} is above its 3-week average of ${usd(avg)}` };
      if (state.history.length >= 2 && state.last < avg - 5) { hours *= 2; reason = `buys double (${hours} hours): ${usd(state.last)} is under its average of ${usd(avg)}`; }
      else reason = `buys ${hours} hours at up to ${usd(cap)} an hour on average`;
      break;
    }
    case 'sensitive':
      if (state.week > 1 && state.last > cap) { hours = Math.max(2, Math.floor(hours / 2)); reason = `halves its order to ${hours} hours: last week’s price was over ${usd(cap)}`; }
      else reason = `asks for ${hours} hours at up to ${usd(cap)} an hour on average`;
      break;
    default: reason = `buys its usual ${hours} hours at up to ${usd(cap)} an hour on average`;
  }
  return { hours, cap, reason };
}

function providerBid(state, provider, pooled) {
  const capacity = state.shock > 0 && ['atlas-compute', 'meridian-cloud'].includes(provider.id) ? Math.floor(provider.capacity * 0.3) : provider.capacity;
  const use = provider.offered ? provider.sold / provider.offered : 0.7;
  let ask = provider.ask, reason;
  switch (provider.strategy) {
    case 'undercut':
      if (state.week > 1 && use < 0.6) { ask = Math.max(provider.floor, state.last - 10); reason = `sold ${pct(use)} last week, so it undercuts to ${usd(ask)}`; }
      else if (use > 0.95) { ask = Math.min(provider.ceiling, ask + 10); reason = `sold out, so it tries ${usd(ask)}`; }
      else reason = `holds ${usd(ask)}`;
      break;
    case 'utilization':
      if (use > 0.9) { ask = Math.min(provider.ceiling, ask + 15); reason = `raises to ${usd(ask)} after selling ${pct(use)}`; }
      else if (use < 0.5) { ask = Math.max(provider.floor, ask - 15); reason = `lowers to ${usd(ask)} after selling ${pct(use)}`; }
      else reason = `holds ${usd(ask)} after selling ${pct(use)}`;
      break;
    case 'premium':
      if (state.history.at(-1)?.short > 0) { ask = Math.min(provider.ceiling, ask + 20); reason = `raises to ${usd(ask)}: the pool went short last week`; }
      else if (provider.unsold >= 2) { ask = Math.max(provider.floor, ask - 20); reason = `cuts to ${usd(ask)} after ${provider.unsold} unsold weeks`; }
      else reason = `holds its premium of ${usd(ask)}`;
      break;
    case 'volume':
      ask = pooled >= 300 ? provider.ask - 30 : provider.ask;
      reason = pooled >= 300 ? `sees a ${pooled}-hour pool and bids 30¢ under its usual ${usd(provider.ask)}` : `bids its usual ${usd(ask)}`;
      break;
    default: ask = provider.cost + 60; reason = `bids cost ${usd(provider.cost)} plus 60¢`;
  }
  if (provider.strategy !== 'volume') provider.ask = ask;
  return { capacity, ask, reason: capacity < provider.capacity ? `${reason}, with only ${capacity} of ${provider.capacity} GPUs during the outage` : reason };
}

export async function runWeek(input) {
  const state = structuredClone(input);
  state.week += 1;
  log(state, 'week', null, `Week ${state.week}: the co-op opens a sealed round${state.shock > 0 ? ' during the outage' : ''}.`);

  const demand = state.teams.map(team => {
    const order = teamOrder(state, team);
    log(state, order.skip ? 'skip' : 'demand', team.id, `${team.label} ${order.skip ?? order.reason}.`);
    return { team, order: order.skip ? null : order };
  });
  const pooled = demand.filter(d => d.order).reduce((t, d) => t + d.order.hours, 0);
  const offers = state.providers.map(provider => {
    const bid = providerBid(state, provider, pooled);
    log(state, 'offer', provider.id, `${provider.label} ${bid.reason}.`);
    return { provider, bid };
  });

  let admitted = demand.filter(d => d.order);
  const released = [];
  let result = null, attempt = 0;
  while (admitted.length) {
    attempt += 1;
    const run = await simulateProcurement({
      seed: state.seed * 31 + state.week, mechanism: cheapestCapacity,
      spec: { id: `coop-week-${state.week}-${attempt}`, mechanismId: cheapestCapacity.id, asset: ASSET,
        resource: { label: 'H100 GPU hours', unit: 'hour', deliveryWindow: `Week ${state.week}` },
        demandCloses: 10, commitCloses: 20, revealCloses: 30 },
      buyers: admitted.map(d => ({ id: d.team.id, demand: () => ({ quantity: String(d.order.hours), budget: String(d.order.hours * d.order.cap) }) })),
      sellers: offers.map(o => ({ id: o.provider.id, offer: () => ({ capacity: String(o.bid.capacity), unitPrice: String(o.bid.ask) }) })),
    });
    state.totals.rounds += 1;
    if (run.stages.at(-1).splitAllocation) { result = run; break; }
    const weakest = [...admitted].sort((a, b) => a.order.cap - b.order.cap || b.order.hours - a.order.hours || (a.team.id < b.team.id ? -1 : 1))[0];
    released.push({ id: weakest.team.id, label: weakest.team.label, cap: weakest.order.cap, hours: weakest.order.hours });
    log(state, 'release', weakest.team.id, `The pool cannot be filled within every team’s budget, so the coordinator releases ${weakest.team.label} (lowest budget, ${usd(weakest.order.cap)} an hour) and runs the round again.`);
    admitted = admitted.filter(d => d !== weakest);
  }

  const closed = result?.stages.at(-1);
  const lines = (closed?.splitAllocation?.lines ?? []).map(l => ({ buyerId: l.buyerId, sellerId: l.sellerId, hours: Number(l.quantity), price: Number(l.unitPrice), amount: Number(l.amount) }));
  const volume = lines.reduce((t, l) => t + l.hours, 0), total = lines.reduce((t, l) => t + l.amount, 0);
  const price = volume ? Math.round(total / volume) : 0;

  const listCheapest = Math.min(...state.providers.map(p => p.list));
  const byTeam = new Map();
  for (const l of lines) { const x = byTeam.get(l.buyerId) ?? { hours: 0, amount: 0, from: [] }; x.hours += l.hours; x.amount += l.amount; x.from.push(l.sellerId); byTeam.set(l.buyerId, x); }
  let savedAll = 0;
  for (const d of demand) {
    const got = byTeam.get(d.team.id);
    d.team.got = got?.hours ?? 0;
    d.team.short = d.order && !got ? d.team.short + 1 : 0;
    if (got) savedAll += got.hours * listCheapest - got.amount;
  }
  for (const o of offers) {
    const sold = lines.filter(l => l.sellerId === o.provider.id).reduce((t, l) => t + l.hours, 0);
    Object.assign(o.provider, { offered: o.bid.capacity, sold, unsold: sold ? 0 : o.provider.unsold + 1 });
  }
  if (volume) state.last = price;

  const youDemand = demand.find(d => d.team.id === YOU), youGot = byTeam.get(YOU);
  const you = youGot
    ? { status: 'filled', hours: youGot.hours, amount: youGot.amount, price: Math.round(youGot.amount / youGot.hours), solo: youGot.hours * listCheapest, saved: youGot.hours * listCheapest - youGot.amount, from: [...new Set(youGot.from)] }
    : { status: released.some(r => r.id === YOU) ? 'released' : 'none', hours: 0, amount: 0, request: youDemand?.order };
  if (youGot) state.totals.savedYou += you.saved;
  state.totals.savedAll += savedAll;
  const payments = result?.plan.payments ?? [];
  state.totals.payments += payments.length;

  log(state, 'clear', null, volume
    ? `The round clears ${volume} of ${pooled} hours at an average ${usd(price)} an hour, against a cheapest list price of ${usd(listCheapest)}. ${payments.length} payments planned.`
    : 'The round clears nothing this week.');

  const short = pooled - volume;
  state.history.push({ week: state.week, price, volume, pooled, short, list: listCheapest, outage: state.shock > 0, youPrice: you.price ?? 0 });
  state.report = {
    week: state.week, pooled, volume, price, total, listCheapest, short, savedAll, attempts: attempt,
    demand: demand.map(d => ({ id: d.team.id, label: d.team.label, work: d.team.work, strategy: d.team.strategy, hours: d.order?.hours ?? 0, cap: d.order?.cap ?? 0, joined: Boolean(d.order) })),
    bids: (result?.stages[1].bids ?? []).map(b => {
      const revealed = closed.bids.find(x => x.sellerId === b.sellerId)?.reveal;
      const sold = lines.filter(l => l.sellerId === b.sellerId).reduce((t, l) => t + l.hours, 0);
      return { id: b.sellerId, label: state.providers.find(p => p.id === b.sellerId)?.label ?? b.sellerId, commitment: b.commitment, price: Number(revealed?.unitPrice ?? 0), capacity: Number(revealed?.capacity ?? 0), sold };
    }),
    released, lines, payments: payments.map(p => ({ ...p, amount: Number(p.amount) })), you,
    roundId: closed?.spec.id ?? null, transcript: result?.transcript ?? null,
  };
  if (state.shock > 0) { state.shock -= 1; if (!state.shock) log(state, 'event', null, 'The outage ends: Atlas Compute and Meridian Cloud are back to full capacity next week.'); }
  return state;
}

const pct = n => `${Math.round(n * 100)}%`;
