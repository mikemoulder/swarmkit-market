import './live.css';
import { createEconomy, stepEconomy, startShock } from './linked-economy.mjs';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const COLORS = { price: '#1f2de6', cost: '#c2410c' };
const WINDOW = 30;
const STORE = 'swarmkit-live-v1';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let economy, timer = null, busy = false, feedFilter = 'all', roundMarket = 'gpu', agentGroup = 'all';
let session = { seed: 2026, ticks: 0, shocks: [] };

// ---------- persistence: the seed and the actions, replayed deterministically ----------
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(session)); } catch {} };
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && Number.isSafeInteger(s.seed) && Number.isInteger(s.ticks) && Array.isArray(s.shocks)) return s; } catch {}
  return null;
}
async function replay(target) {
  economy = createEconomy(target.seed);
  for (let t = 1; t <= Math.min(target.ticks, 400); t++) {
    if (target.shocks.includes(t)) economy = startShock(economy);
    economy = await stepEconomy(economy);
  }
}

// ---------- agents ----------
const groups = { gpuSellers: 'GPU seller', labs: 'Research lab', providers: 'Inference provider', apps: 'App' };
const agentIndex = () => new Map(Object.entries(economy.agents).flatMap(([g, list]) => list.map(a => [a.id, { ...a, group: g }])));
const label = id => agentIndex().get(id)?.label ?? id;

// ---------- run loop ----------
async function step() {
  if (busy) return; busy = true;
  try {
    if (pendingShock) { economy = startShock(economy); session.shocks.push(economy.tick + 1); pendingShock = false; }
    economy = await stepEconomy(economy);
    session.ticks = economy.tick; save();
    render();
  } catch (error) {
    stop(); $('status').textContent = `The round could not run: ${error.message}`;
  } finally { busy = false; }
}
let pendingShock = false;
function play() {
  if (timer) return;
  $('play').textContent = 'Pause'; $('play').setAttribute('aria-pressed', 'true');
  const tick = async () => { await step(); timer = setTimeout(tick, Number($('speed').value)); };
  timer = setTimeout(tick, 50);
}
function stop() {
  clearTimeout(timer); timer = null;
  $('play').textContent = 'Play rounds'; $('play').setAttribute('aria-pressed', 'false');
}

// ---------- rendering ----------
const fmt = (n, d = 2) => (Number.isFinite(n) && n > 0 ? n.toFixed(d) : '–');
function delta(el, now, before) {
  if (!(now > 0 && before > 0) || Math.abs(now - before) < 0.005) { el.textContent = ''; el.className = ''; return; }
  const up = now > before;
  el.textContent = `${up ? '▲' : '▼'} ${Math.abs(now - before).toFixed(2)}`;
  el.className = up ? 'up' : 'down';
}

function render() {
  const h = economy.history, last = h.at(-1), prev = h.at(-2);
  $('k-round').textContent = economy.tick;
  $('k-gpu').textContent = fmt(last?.gpu.price); delta($('k-gpu-d'), last?.gpu.price, prev?.gpu.price);
  $('k-inf').textContent = fmt(last?.inference.price); delta($('k-inf-d'), last?.inference.price, prev?.inference.price);
  $('k-cost').textContent = fmt(last?.providerCost); delta($('k-cost-d'), last?.providerCost, prev?.providerCost);
  $('k-rounds').textContent = economy.ledger.rounds;
  $('k-pay').textContent = economy.ledger.payments;
  const shockNote = economy.shock > 0 ? ` GPU supply is cut for ${economy.shock} more round${economy.shock > 1 ? 's' : ''}.` : '';
  $('status').textContent = economy.tick
    ? `Round ${economy.tick} cleared in both markets.${shockNote}`
    : 'Ready. Press Play rounds, or run one round at a time.';
  $('shock').disabled = economy.shock > 0 || pendingShock;
  renderFlow(); renderCharts(); renderFeed(); renderRound(); renderAgents();
}

// Supply chain: sellers → GPU market → labs and providers → inference market → apps
function renderFlow() {
  const el = $('flow'), { gpuSellers, labs, providers, apps } = economy.agents, r = economy.rounds;
  const W = 960, H = 500, svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const col = (list, x, top, bottom) => list.map((a, i) => ({ a, x, y: list.length === 1 ? (top + bottom) / 2 : top + (i * (bottom - top)) / (list.length - 1) }));
  const sellers = col(gpuSellers, 40, 80, 430), mid = [...col(labs, 430, 56, 216), ...col(providers, 430, 316, 456)], appNodes = col(apps, 920, 56, 470);
  const gpuMarket = { x: 245, y: 260 }, infMarket = { x: 700, y: 386 };
  const sum = (lines, key, id) => (lines ?? []).filter(l => l[key] === id).reduce((t, l) => t + l.quantity, 0);
  const width = q => (q ? 1.5 + Math.sqrt(q) * 1.15 : 0);
  const edges = [];
  for (const n of sellers) edges.push([n, gpuMarket, sum(r?.gpu.lines, 'sellerId', n.a.id)]);
  for (const n of mid) edges.push([gpuMarket, n, sum(r?.gpu.lines, 'buyerId', n.a.id)]);
  for (const n of mid.slice(labs.length)) edges.push([n, infMarket, sum(r?.inference.lines, 'sellerId', n.a.id)]);
  for (const n of appNodes) edges.push([infMarket, n, sum(r?.inference.lines, 'buyerId', n.a.id)]);
  const g = document.createElementNS(SVG, 'g');
  for (const [from, to, q] of edges) {
    const p = document.createElementNS(SVG, 'path'), dx = (to.x - from.x) / 2;
    p.setAttribute('d', `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`);
    p.setAttribute('class', q ? 'edge edge--on' : 'edge');
    p.setAttribute('stroke-width', q ? width(q) : 1);
    g.append(p);
  }
  svg.append(g);
  const text = (x, y, value, cls, anchor = 'middle') => { const t = document.createElementNS(SVG, 'text'); t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor); t.setAttribute('class', cls); t.textContent = value; svg.append(t); };
  const node = (n, sub, anchor, shocked) => {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', 6);
    c.setAttribute('class', shocked ? 'node node--shock' : 'node'); svg.append(c);
    const dx = anchor === 'end' ? -14 : 14;
    text(n.x + dx, n.y - 2, n.a.label, 'n-label', anchor);
    text(n.x + dx, n.y + 14, sub, shocked ? 'n-sub n-sub--shock' : 'n-sub', anchor);
  };
  for (const n of sellers) {
    const s = n.a, shocked = economy.history.at(-1)?.shock && s.shocked;
    node(n, `asks ${s.ask} · sold ${s.sold}${shocked ? ' · supply cut' : ''}`, 'start', shocked);
  }
  for (const n of mid) {
    const a = n.a, isProvider = a.batches !== undefined;
    node(n, isProvider ? `${sum(r?.gpu.lines, 'buyerId', a.id)} h → ${a.batches} batches` : `got ${a.got ?? 0} of ${a.need} h`, 'start');
  }
  for (const n of appNodes) node(n, `got ${n.a.got ?? 0} batches`, 'end');
  const market = (m, title, data, unit) => {
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', m.x - 62); rect.setAttribute('y', m.y - 40); rect.setAttribute('width', 124); rect.setAttribute('height', 80); rect.setAttribute('rx', 10);
    rect.setAttribute('class', 'market'); svg.append(rect);
    text(m.x, m.y - 16, title, 'm-title');
    text(m.x, m.y + 6, data?.volume ? `${fmt(data.price)} / ${unit}` : 'no clearing', 'm-price');
    text(m.x, m.y + 26, data ? `${data.volume} of ${data.requested} ${unit === 'h' ? 'hours' : 'batches'}` : 'waiting', 'm-sub');
  };
  market(gpuMarket, 'GPU market', r?.gpu, 'h');
  market(infMarket, 'Inference market', r?.inference, 'batch');
  text(40, 34, 'GPU sellers', 'col-head', 'start'); text(430, 26, 'Research labs', 'col-head', 'start'); text(430, 286, 'Inference providers', 'col-head', 'start'); text(920, 26, 'Apps', 'col-head', 'end');
  el.replaceChildren(svg);
}

// Two small charts, one unit each: GPU credits per hour; inference credits per batch with provider cost.
function renderCharts() {
  const h = economy.history.slice(-WINDOW);
  lineChart($('chart-gpu'), 'GPU price, credits per hour', h, [{ name: 'GPU price', color: COLORS.price, value: x => x.gpu.price }]);
  lineChart($('chart-inf'), 'Inference, credits per batch', h, [
    { name: 'Inference price', color: COLORS.price, value: x => x.inference.price },
    { name: 'Provider cost', color: COLORS.cost, value: x => x.providerCost },
  ]);
  const rows = economy.history.slice(-WINDOW).map(x => `<tr><th scope="row">${x.tick}${x.shock ? ' (shock)' : ''}</th><td>${fmt(x.gpu.price)}</td><td>${x.gpu.volume}/${x.gpu.requested}</td><td>${fmt(x.inference.price)}</td><td>${fmt(x.providerCost)}</td><td>${x.inference.volume}/${x.inference.requested}</td></tr>`).join('');
  $('price-table').innerHTML = `<table><thead><tr><th scope="col">Round</th><th scope="col">GPU price</th><th scope="col">GPU hours cleared</th><th scope="col">Inference price</th><th scope="col">Provider cost</th><th scope="col">Batches cleared</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function lineChart(el, title, data, series) {
  const W = Math.round(Math.max(300, Math.min(560, (el.clientWidth || 520) - 32))), H = W < 420 ? 190 : 170, L = 34, R = W < 420 ? 84 : 92, T = 26, B = 22;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${title}: ${series.map(s => `${s.name} ${fmt(s.value(data.at(-1) ?? { gpu: {}, inference: {} }))}`).join(', ')}`);
  const add = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
  add('text', { x: L, y: 14, class: 'c-title' }, title);
  const values = data.flatMap(x => series.map(s => s.value(x))).filter(v => v > 0);
  const lo = values.length ? Math.floor(Math.min(...values) - 0.5) : 0, hi = values.length ? Math.ceil(Math.max(...values) + 0.5) : 8;
  const n = Math.max(WINDOW, 1), X = i => L + (i * (W - L - R)) / (n - 1), Y = v => T + ((hi - v) * (H - T - B)) / (hi - lo || 1);
  data.forEach((x, i) => { if (x.shock) add('rect', { x: X(i) - (W - L - R) / (n - 1) / 2, y: T, width: (W - L - R) / (n - 1), height: H - T - B, class: 'c-shock' }); });
  for (let k = 0; k <= 2; k++) { const v = lo + ((hi - lo) * k) / 2; add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'c-grid' }); add('text', { x: L - 6, y: Y(v) + 4, class: 'c-axis', 'text-anchor': 'end' }, v.toFixed(v % 1 ? 1 : 0)); }
  if (data.length) { add('text', { x: X(0), y: H - 6, class: 'c-axis' }, `R${data[0].tick}`); add('text', { x: X(data.length - 1), y: H - 6, class: 'c-axis', 'text-anchor': 'end' }, `R${data.at(-1).tick}`); }
  const ends = [];
  for (const s of series) {
    const pts = data.map((x, i) => [X(i), s.value(x)]).filter(([, v]) => v > 0).map(([px, v]) => `${px},${Y(v)}`);
    if (pts.length > 1) add('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    const lastIndex = data.findLastIndex(x => s.value(x) > 0);
    if (lastIndex >= 0) { const v = s.value(data[lastIndex]); add('circle', { cx: X(lastIndex), cy: Y(v), r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 2 }); ends.push({ s, y: Y(v), x: X(lastIndex), v }); }
  }
  ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) add('text', { x: e.x + 9, y: e.y + 4, class: 'c-end' }, `${e.s.name} ${e.v.toFixed(2)}`);
  if (series.length > 1) {
    let lx = W < 420 ? L : L + 196; const ly = W < 420 ? H - 2 : 10;
    if (W < 420) svg.setAttribute('viewBox', `0 0 ${W} ${H + 14}`);
    for (const s of series) { add('line', { x1: lx, x2: lx + 14, y1: ly, y2: ly, stroke: s.color, 'stroke-width': 2 }); add('text', { x: lx + 18, y: ly + 4, class: 'c-legend' }, s.name); lx += 18 + s.name.length * 6.4 + 16; }
  }
  const cross = add('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'c-cross', visibility: 'hidden' });
  const hit = add('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: data.length ? 0 : -1, 'aria-label': `${title}, use arrow keys to read each round` });
  let focusIndex = data.length - 1;
  const show = (i, clientX, clientY) => {
    if (i < 0 || i >= data.length) return hide();
    const x = data[i]; cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    const tip = $('tip'); tip.replaceChildren();
    const head = document.createElement('div'); head.className = 'tip__head'; head.textContent = `Round ${x.tick}${x.shock ? ' · supply shock' : ''}`; tip.append(head);
    for (const s of series) {
      const row = document.createElement('div'); row.className = 'tip__row';
      const key = document.createElement('i'); key.style.background = s.color;
      const val = document.createElement('b'); val.textContent = fmt(s.value(x));
      const name = document.createElement('span'); name.textContent = s.name;
      row.append(key, val, name); tip.append(row);
    }
    tip.hidden = false;
    const box = svg.getBoundingClientRect(), px = clientX ?? box.left + (X(i) / W) * box.width, py = clientY ?? box.top + 30;
    tip.style.left = `${Math.min(innerWidth - 200, px + 14)}px`; tip.style.top = `${py + scrollY - 10}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); $('tip').hidden = true; };
  const indexAt = e => { const box = svg.getBoundingClientRect(), sx = ((e.clientX - box.left) / box.width) * W; return Math.round(((sx - L) * (n - 1)) / (W - L - R)); };
  hit.addEventListener('pointermove', e => show(indexAt(e), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(focusIndex));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') focusIndex = Math.max(0, focusIndex - 1); else if (e.key === 'ArrowRight') focusIndex = Math.min(data.length - 1, focusIndex + 1); else return; e.preventDefault(); show(focusIndex); });
  el.replaceChildren(svg);
}

function renderFeed() {
  const items = economy.feed.filter(f => feedFilter === 'all' || (feedFilter === 'coordinator' ? ['clear', 'release', 'event', 'tick'].includes(f.kind) : f.market === feedFilter)).slice(-120).reverse();
  const list = $('feed'); list.replaceChildren();
  for (const f of items) {
    const li = document.createElement('li'); li.className = `feed__item feed__item--${f.kind}`;
    const meta = document.createElement('span'); meta.className = 'feed__meta';
    meta.textContent = `R${f.tick}${f.market ? ` · ${f.market === 'gpu' ? 'GPU' : 'Inference'}` : ''}`;
    const text = document.createElement('p'); text.textContent = f.text;
    li.append(meta, text); list.append(li);
  }
  if (!items.length) { const li = document.createElement('li'); li.className = 'feed__empty'; li.textContent = 'Decisions appear here as each round runs.'; list.append(li); }
}

function renderRound() {
  const el = $('round'), r = economy.rounds?.[roundMarket];
  if (!r) { el.innerHTML = '<p class="empty">Run a round to see its sealed bids, the allocation and the settlement plan.</p>'; return; }
  const unit = roundMarket === 'gpu' ? 'hours' : 'batches';
  const allocated = new Map(); for (const l of r.lines) allocated.set(l.sellerId, (allocated.get(l.sellerId) ?? 0) + l.quantity);
  const bids = r.bids.map(b => `<tr><th scope="row">${esc(label(b.sellerId))}</th><td class="mono">${b.commitment.slice(0, 10)}…</td><td>${b.price || '–'}</td><td>${b.capacity || '–'}</td><td>${allocated.get(b.sellerId) ?? 0}</td></tr>`).join('');
  const buyers = new Map(); for (const l of r.lines) { const x = buyers.get(l.buyerId) ?? { q: 0, a: 0, sellers: [] }; x.q += l.quantity; x.a += l.amount; x.sellers.push(label(l.sellerId)); buyers.set(l.buyerId, x); }
  const lines = [...buyers].map(([id, x]) => `<tr><th scope="row">${esc(label(id))}</th><td>${x.q}</td><td>${x.a}</td><td>${esc([...new Set(x.sellers)].join(', '))}</td></tr>`).join('');
  el.innerHTML = `
    <div class="round__facts">
      <div><span>Round id</span><b class="mono">${esc(r.roundId ?? 'none')}</b></div>
      <div><span>Cleared</span><b>${r.volume} of ${r.requested} ${unit}</b></div>
      <div><span>Average price</span><b>${fmt(r.price)}</b></div>
      <div><span>Attempts</span><b>${r.attempts}${r.released.length ? `, released ${r.released.length}` : ''}</b></div>
    </div>
    <h3>Sealed bids: SHA-256 commitment, then reveal</h3>
    <div class="table-scroll"><table><thead><tr><th scope="col">Seller</th><th scope="col">Commitment</th><th scope="col">Price</th><th scope="col">Offered</th><th scope="col">Allocated</th></tr></thead><tbody>${bids || '<tr><td colspan="5">No bids</td></tr>'}</tbody></table></div>
    <h3>Allocation and settlement plan: ${r.payments} payments, ${r.total} credits</h3>
    <div class="table-scroll"><table><thead><tr><th scope="col">Buyer</th><th scope="col">${unit === 'hours' ? 'Hours' : 'Batches'}</th><th scope="col">Pays</th><th scope="col">From</th></tr></thead><tbody>${lines || '<tr><td colspan="4">No allocation</td></tr>'}</tbody></table></div>
    ${r.transcript ? '<button id="transcript" class="btn btn--quiet" type="button">Download this round’s SDK transcript</button>' : ''}`;
  $('transcript')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(r.transcript, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${r.roundId}.transcript.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

function renderAgents() {
  const rows = Object.entries(economy.agents).filter(([g]) => agentGroup === 'all' || g === agentGroup).flatMap(([g, list]) => list.map(a => {
    const now = g === 'gpuSellers' ? `asks ${a.ask}, sold ${a.sold} of ${a.offered || a.nameplate} h`
      : g === 'providers' ? `${a.batches} batches at ${a.price}, sold ${a.sold}`
      : `got ${a.got ?? 0} of ${a.need} ${g === 'labs' ? 'h' : 'batches'}${a.short ? `, short ${a.short} round${a.short > 1 ? 's' : ''}` : ''}`;
    return `<tr><th scope="row">${esc(a.label)}<span>${groups[g]}</span></th><td><b>${esc(a.strategy)}</b><span>${esc(a.about)}</span></td><td>${esc(now)}</td><td class="num">${Math.round(a.cash)}</td></tr>`;
  })).join('');
  $('agents').innerHTML = `<table class="agents"><thead><tr><th scope="col">Agent</th><th scope="col">Strategy</th><th scope="col">This round</th><th scope="col" class="num">Cash</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- controls ----------
function chips(attr, set) {
  for (const b of document.querySelectorAll(`[data-${attr}]`)) b.addEventListener('click', () => {
    for (const o of document.querySelectorAll(`[data-${attr}]`)) o.setAttribute('aria-pressed', String(o === b));
    set(b.dataset[attr]);
  });
}
chips('feed', v => { feedFilter = v; renderFeed(); });
chips('round', v => { roundMarket = v; renderRound(); });
chips('group', v => { agentGroup = v; renderAgents(); });
$('play').addEventListener('click', () => (timer ? stop() : play()));
$('step').addEventListener('click', () => { stop(); step(); });
$('shock').addEventListener('click', () => { pendingShock = true; $('shock').disabled = true; $('status').textContent = 'GPU supply will be cut from the next round.'; if (!timer) step(); });
$('reset').addEventListener('click', async () => {
  stop();
  const seed = Number($('seed').value);
  if (!Number.isSafeInteger(seed)) { $('status').textContent = 'Write a whole number for the seed.'; return; }
  session = { seed, ticks: 0, shocks: [] }; save();
  economy = createEconomy(seed); pendingShock = false; render();
});
let resizeTimer; addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => economy && renderCharts(), 150); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

// ---------- start ----------
(async () => {
  const saved = load();
  if (saved && saved.ticks > 0) { session = saved; $('seed').value = saved.seed; await replay(saved); render(); $('status').textContent = `Restored round ${economy.tick} from seed ${saved.seed}. Press Play rounds to continue.`; return; }
  economy = createEconomy(session.seed);
  for (let i = 0; i < 5; i++) economy = await stepEconomy(economy);
  session.ticks = economy.tick; save(); render();
  if (!reduced) play();
})().catch(error => { $('status').textContent = `The economy could not start: ${error.message}`; });
