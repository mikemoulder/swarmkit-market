import './live.css';
import './coop.css';
import { createCoop, setRequest, runWeek, startShock, usd, YOU } from './coop-economy.mjs';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const STORE = 'swarmkit-coop-v1';
const SETTLE_URL = import.meta.env.VITE_SETTLE_URL || '';
const PARENT = import.meta.env.VITE_PARENT_ACCOUNT || '';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = ms => new Promise(r => setTimeout(r, reduced ? 0 : ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state, busy = false, feedFilter = 'all';
let session = { seed: 2026, request: { name: 'Your team', hours: 30, cap: 300 }, steps: [] };

// ---------- persistence: seed, your request and the actions taken, replayed on load ----------
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(session)); } catch {} };
function load() {
  try { const s = JSON.parse(localStorage.getItem(STORE)); if (s && Number.isSafeInteger(s.seed) && Array.isArray(s.steps) && s.request) return s; } catch {}
  return null;
}
async function replay(saved) {
  state = createCoop(saved.seed, saved.initial ?? saved.request);
  for (const step of saved.steps.slice(0, 300)) {
    if (step.type === 'request') state = setRequest(state, step.request);
    else if (step.type === 'outage') state = startShock(state);
    else if (step.type === 'week') state = await runWeek(state);
  }
}

// ---------- the request form ----------
function readForm() {
  const name = $('f-name').value.trim() || 'Your team';
  const hours = Number($('f-hours').value), capDollars = Number($('f-cap').value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 200) return { error: 'Write the GPU hours as a whole number from 1 to 200.' };
  if (!Number.isFinite(capDollars) || capDollars < 1 || capDollars > 20) return { error: 'Write a budget per hour from $1.00 to $20.00.' };
  return { name, hours, cap: Math.round(capDollars * 100) };
}
function updateBudget() {
  const r = readForm();
  $('budget').textContent = r.error ? '–' : usd(r.hours * r.cap);
}
['f-hours', 'f-cap'].forEach(id => $(id).addEventListener('input', updateBudget));

async function sendAgent(staged = true) {
  const request = readForm();
  const error = $('form-error');
  if (request.error) { error.textContent = request.error; error.hidden = false; return false; }
  error.hidden = true;
  const you = state.teams.find(t => t.id === YOU);
  if (you.label !== request.name || you.hours !== request.hours || you.cap !== request.cap) {
    state = setRequest(state, request); session.steps.push({ type: 'request', request });
  }
  state = await runWeek(state);
  session.steps.push({ type: 'week' }); session.request = request; save();
  if (staged) await reveal(state.report); else renderAll();
  return true;
}

async function guard(fn) {
  if (busy) return; busy = true; setBusy(true);
  try { await fn(); } catch (e) { $('status').textContent = `Something went wrong: ${e.message}`; }
  finally { busy = false; setBusy(false); }
}
function setBusy(on) {
  for (const id of ['run', 'run4', 'outage']) $(id).disabled = on || (id === 'outage' && state?.shock > 0);
}

$('request').addEventListener('submit', e => { e.preventDefault(); guard(() => sendAgent(true)); });
$('run4').addEventListener('click', () => guard(async () => {
  for (let i = 0; i < 4; i++) { if (!(await sendAgent(false))) return; await pause(250); }
  await reveal(state.report, true);
}));
$('outage').addEventListener('click', () => guard(async () => {
  state = startShock(state); session.steps.push({ type: 'outage' }); save();
  $('status').textContent = 'An outage hits two providers from next week. Send your agent to see what happens.';
  renderFeed();
}));

// ---------- staged reveal of one week ----------
async function reveal(r, quick = false) {
  const wait = ms => pause(quick ? 0 : ms);
  setWeekLabels();
  $('status').textContent = `Week ${r.week}: agents are joining the pool.`;
  renderPool(r, 'joining'); renderBids(r, 'empty'); renderClear(null); renderPay(null); renderResult(null);
  await wait(700);
  renderPool(r, 'joined');
  $('status').textContent = `Week ${r.week}: providers are committing sealed bids.`;
  await wait(600);
  renderBids(r, 'sealed');
  await wait(900);
  $('status').textContent = `Week ${r.week}: bids are revealed and checked against their hashes.`;
  renderBids(r, 'revealed');
  await wait(800);
  renderPool(r, 'cleared'); renderClear(r);
  await wait(700);
  renderPay(r); renderResult(r);
  renderChart(); renderFeed(); setWeekLabels();
  $('status').textContent = r.you.status === 'filled'
    ? `Week ${r.week} cleared. Your agent got ${r.you.hours} hours and saved ${usd(r.you.saved)} against buying alone.`
    : r.you.status === 'released' ? `Week ${r.week} cleared without you: your budget was below what the remaining hours cost.` : `Week ${r.week} cleared.`;
}

function setWeekLabels() {
  const next = state.week + 1;
  $('week-label').textContent = state.week ? `Week ${state.week} done` : 'Week 1';
  $('run').textContent = `Send my agent to week ${next}`;
  $('list').textContent = usd(Math.min(...state.providers.map(p => p.list)));
  $('outage').disabled = state.shock > 0;
  $('outage').textContent = state.shock > 0 ? `Outage: ${state.shock} week${state.shock > 1 ? 's' : ''} left` : 'Cause a GPU outage';
}

// ---------- step 1: the pool ----------
function renderPool(r, phase) {
  const released = new Set((r?.released ?? []).map(x => x.id));
  const got = new Map(); for (const l of r?.lines ?? []) got.set(l.buyerId, (got.get(l.buyerId) ?? 0) + l.hours);
  const rows = (r?.demand ?? state.teams.map(t => ({ id: t.id, label: t.label, work: t.work, hours: t.hours, cap: t.cap, joined: true, idle: true }))).map(d => {
    let tag = 'Waiting', cls = '';
    if (!d.idle && phase !== 'joining') {
      if (!d.joined) { tag = 'Sat out'; cls = 'is-out'; }
      else if (phase === 'cleared') { tag = released.has(d.id) ? 'Released' : got.has(d.id) ? 'Filled' : 'Joined'; cls = released.has(d.id) ? 'is-released' : 'is-filled'; }
      else { tag = 'Joined'; cls = 'is-in'; }
    }
    return `<li class="team ${cls}${d.id === YOU ? ' is-you' : ''}"><b>${esc(d.label)}</b><span>${d.joined ? `${d.hours} h · ${usd(d.cap)}/h` : esc(d.work)}</span><em>${tag}</em></li>`;
  }).join('');
  $('pool').innerHTML = `<ul class="teams">${rows}</ul>`;
  $('pool-total').textContent = r && phase !== 'joining' ? `${r.pooled} hours pooled from ${r.demand.filter(d => d.joined).length} teams` : r ? 'Agents are joining' : '20 teams’ agents are ready';
}

// ---------- step 2: sealed bids ----------
function renderBids(r, phase) {
  if (!r || phase === 'empty') { $('bids').innerHTML = '<p class="empty pad">No bids yet.</p>'; $('bids-state').textContent = 'Bids are hidden until the reveal'; return; }
  const sealed = phase === 'sealed';
  const rows = r.bids.map(b => `<tr><th scope="row">${esc(b.label)}</th><td class="mono">${b.commitment.slice(0, 16)}…</td><td>${sealed ? '<span class="sealed">sealed</span>' : usd(b.price)}</td><td>${sealed ? '<span class="sealed">sealed</span>' : `${b.capacity} h`}</td></tr>`).join('');
  $('bids').innerHTML = `<table><thead><tr><th scope="col">Provider</th><th scope="col">SHA-256 commitment</th><th scope="col">Price per hour</th><th scope="col">GPUs offered</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('bids-state').textContent = sealed ? `${r.bids.length} commitments in · prices hidden` : 'Revealed · every reveal matched its hash';
}

// ---------- step 3: clearing ----------
function renderClear(r) {
  if (!r) { $('clear').innerHTML = '<p class="empty">The allocation appears after the reveal.</p>'; $('clear-state').textContent = 'After the reveal'; return; }
  const bars = r.bids.map(b => `<li><span class="clear__name">${esc(b.label)}</span><span class="clear__track"><i style="width:${b.capacity ? Math.round((b.sold / b.capacity) * 100) : 0}%"></i></span><span class="clear__val">${b.sold} of ${b.capacity} h at ${usd(b.price)}</span></li>`).join('');
  const released = r.released.length
    ? `<div class="released"><h3>Released by the coordinator</h3><p>The pool could not be filled within every budget, so the lowest budgets were released and the round was run again with the same sealed bids.</p><ul>${r.released.map(x => `<li><b>${esc(x.label)}</b> ${x.hours} h at ${usd(x.cap)}/h</li>`).join('')}</ul></div>`
    : '';
  $('clear').innerHTML = `
    <div class="clear__facts">
      <div><span>Pool price</span><b>${usd(r.price)}<small>/h</small></b></div>
      <div><span>Cheapest list price</span><b>${usd(r.listCheapest)}<small>/h</small></b></div>
      <div><span>Hours cleared</span><b>${r.volume}<small> of ${r.pooled}</small></b></div>
      <div><span>All teams saved</span><b>${usd(r.savedAll)}</b></div>
    </div>
    <ul class="clear__bars">${bars}</ul>${released}`;
  $('clear-state').textContent = r.attempts > 1 ? `Cleared on attempt ${r.attempts}` : 'Cleared on the first attempt';
}

// ---------- step 4: payments ----------
function renderPay(r) {
  if (!r) { $('pay').innerHTML = '<p class="empty">The settlement plan appears once the round clears.</p>'; $('pay-state').textContent = 'Settlement plan'; return; }
  const label = id => state.teams.find(t => t.id === id)?.label ?? state.providers.find(p => p.id === id)?.label ?? id;
  const sorted = [...r.payments].sort((a, b) => (b.buyerId === YOU) - (a.buyerId === YOU));
  const rows = sorted.map(p => `<tr class="${p.buyerId === YOU ? 'is-you' : ''}"><th scope="row">${esc(label(p.buyerId))}</th><td>${esc(label(p.sellerId))}</td><td class="num">${usd(p.amount)}</td><td class="mono">${p.buyerId === YOU && PARENT ? `<a class="link" href="https://testnet.nearblocks.io/address/your-team.${esc(PARENT)}">your-team.${esc(PARENT)}</a>` : `${esc(p.buyerId)} <span class="sim">simulated</span>`}</td></tr>`).join('');
  const settle = SETTLE_URL
    ? '<button class="btn btn--primary" type="button" id="settle">Settle my share on NEAR testnet</button><p class="pay__note" id="settle-note">Pays your share from your team’s agent account to each provider’s on NEAR testnet. $1.00 here settles as 0.0001 testnet NEAR.</p>'
    : `<p class="pay__note">On this page the plan is settled in simulated dollars. The same SDK settlement flow paid all 20 shares of a 20-buyer GPU round on NEAR testnet, each one checked against RPC. <a class="link" href="./testnet.html">See those receipts</a></p>`;
  $('pay').innerHTML = `<p class="pay__lead"><b>${r.payments.length} payments</b>, one per team and provider pair, ${usd(r.total)} in total. Nobody pays for anyone else’s hours.</p>
    <div class="table-scroll pay__table"><table><thead><tr><th scope="col">Team</th><th scope="col">Pays provider</th><th scope="col" class="num">Amount</th><th scope="col">Payer agent account</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="pay__actions">${settle}${r.transcript ? '<button class="btn btn--quiet" type="button" id="transcript">Download this week’s SDK transcript</button>' : ''}</div>`;
  $('pay-state').textContent = `Round ${r.roundId ?? '–'}`;
  $('transcript')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r.transcript, null, 2)], { type: 'application/json' }));
    a.download = `${r.roundId}.transcript.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('settle')?.addEventListener('click', () => settleShare(r));
}

function clientId() {
  try {
    let id = localStorage.getItem('swarmkit-coop-client');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('swarmkit-coop-client', id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

async function settleShare(r) {
  const mine = r.payments.filter(p => p.buyerId === YOU), note = $('settle-note'), button = $('settle');
  if (!mine.length) { note.textContent = 'Your team has no payment in this round.'; return; }
  button.disabled = true;
  const lines = [];
  for (const payment of mine) {
    const provider = state.providers.find(p => p.id === payment.sellerId)?.label ?? payment.sellerId;
    note.textContent = `Signing and sending your ${usd(payment.amount)} share to ${provider} on NEAR testnet…`;
    try {
      let body;
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch(SETTLE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: clientId(), roundId: r.roundId, payment: { buyerId: payment.buyerId, sellerId: payment.sellerId, amount: payment.amount } }) });
        body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (body.status === 'confirmed') break;
        note.textContent = `Sent to ${provider}; waiting for NEAR testnet to finalise it…`;
        await new Promise(res => setTimeout(res, 2500));
      }
      const link = body.transactionHash ? ` <a class="link" href="https://testnet.nearblocks.io/txns/${encodeURIComponent(body.transactionHash)}">View transaction</a>` : '';
      lines.push(`${body.status === 'confirmed' ? 'Final' : 'Sent, not yet final'}: ${esc(body.amountNear)} testnet NEAR to ${esc(body.to)}.${link}`);
    } catch (e) {
      lines.push(`Your share to ${esc(provider)} was not settled: ${esc(e.message)} Press again to retry; a payment already signed is never signed twice.`);
      button.disabled = false;
    }
  }
  note.innerHTML = lines.join('<br>');
}

// ---------- your result ----------
function renderResult(r) {
  const el = $('result');
  if (!r) { el.innerHTML = `<p class="empty">${busy ? 'Your agent is in this week’s round.' : 'Your agent has not bid yet.'}</p>`; return; }
  const you = r.you, label = id => state.providers.find(p => p.id === id)?.label ?? id;
  if (you.status === 'filled') {
    el.innerHTML = `<p class="result__big">Saved <b>${usd(you.saved)}</b></p>
      <dl class="result__rows">
        <div><dt>You got</dt><dd>${you.hours} GPU hours</dd></div>
        <div><dt>You paid</dt><dd>${usd(you.amount)} · ${usd(you.price)}/h</dd></div>
        <div><dt>Alone, at list price</dt><dd>${usd(you.solo)}</dd></div>
        <div><dt>From</dt><dd>${esc(you.from.map(label).join(' and '))}</dd></div>
      </dl>
      <p class="result__total">Saved over ${state.week} week${state.week > 1 ? 's' : ''}: <b>${usd(state.totals.savedYou)}</b></p>`;
  } else if (you.status === 'released') {
    el.innerHTML = `<p class="result__big result__big--out">Not filled this week</p><p>The hours left after cheaper budgets were served cost more than ${usd(you.request?.cap ?? 0)} an hour, so the coordinator released your agent rather than overspend your budget. Raise your budget per hour or try next week.</p>`;
  } else el.innerHTML = '<p class="empty">Your agent sat out this week.</p>';
}

// ---------- week by week ----------
function renderChart() {
  const data = state.history.slice(-24), el = $('chart');
  const series = [
    { name: 'Co-op price', color: '#1f2de6', value: h => h.price },
    { name: 'Your price', color: '#c2410c', value: h => h.youPrice },
    { name: 'List price', color: '#7a828f', value: h => h.list, dashed: true },
  ];
  const W = Math.round(Math.max(300, Math.min(760, (el.clientWidth || 600) - 32))), H = 220, L = 46, R = W < 480 ? 16 : 120, T = 30, B = W < 480 ? 46 : 24;
  const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price per GPU hour by week: co-op price, your price and the cheapest list price${data.length ? `, latest week ${data.at(-1).week}` : ''}`);
  const add = (tag, attrs, text) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
  add('text', { x: L, y: 16, class: 'c-title' }, 'Price per GPU hour');
  if (!data.length) { add('text', { x: L, y: H / 2, class: 'c-axis' }, 'Send your agent to see the weeks build up.'); el.replaceChildren(svg); $('weeks-table').innerHTML = ''; return; }
  const vals = data.flatMap(h => series.map(s => s.value(h))).filter(v => v > 0);
  const lo = Math.floor(Math.min(...vals) / 25) * 25 - 25, hi = Math.ceil(Math.max(...vals) / 25) * 25 + 25;
  const n = Math.max(data.length, 2), X = i => L + (i * (W - L - R)) / (n - 1), Y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const band = (W - L - R) / (n - 1);
  data.forEach((h, i) => { if (h.outage) add('rect', { x: X(i) - band / 2, y: T, width: band, height: H - T - B, class: 'c-shock' }); });
  for (let k = 0; k <= 3; k++) { const v = lo + ((hi - lo) * k) / 3; add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'c-grid' }); add('text', { x: L - 6, y: Y(v) + 4, class: 'c-axis', 'text-anchor': 'end' }, usd(v)); }
  add('text', { x: X(0), y: H - (W < 480 ? 30 : 6), class: 'c-axis' }, `Week ${data[0].week}`);
  add('text', { x: X(data.length - 1), y: H - (W < 480 ? 30 : 6), class: 'c-axis', 'text-anchor': 'end' }, `Week ${data.at(-1).week}`);
  const ends = [];
  for (const s of series) {
    const pts = data.map((h, i) => [X(i), s.value(h)]).filter(([, v]) => v > 0);
    if (pts.length > 1) add('polyline', { points: pts.map(([x, v]) => `${x},${Y(v)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dashed ? '5 4' : 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    if (pts.length) { const [x, v] = pts.at(-1); add('circle', { cx: x, cy: Y(v), r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 2 }); ends.push({ s, x, y: Y(v), v }); }
  }
  if (W >= 480) {
    ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    for (const e of ends) add('text', { x: e.x + 9, y: e.y + 4, class: 'c-end' }, `${e.s.name} ${usd(e.v)}`);
  } else {
    let lx = L; for (const s of series) { add('line', { x1: lx, x2: lx + 14, y1: H - 10, y2: H - 10, stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dashed ? '4 3' : 'none' }); add('text', { x: lx + 18, y: H - 6, class: 'c-legend' }, s.name); lx += 18 + s.name.length * 6.2 + 12; }
  }
  // hover and keyboard readout
  const cross = add('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'c-cross', visibility: 'hidden' });
  const hit = add('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: 0, 'aria-label': 'Weekly prices, use the arrow keys to read each week' });
  let fi = data.length - 1;
  const show = (i, cx, cy) => {
    if (i < 0 || i >= data.length) return hide();
    const h = data[i]; cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    const tip = $('tip'); tip.replaceChildren();
    const head = document.createElement('div'); head.className = 'tip__head'; head.textContent = `Week ${h.week}${h.outage ? ' · outage' : ''} · ${h.volume} of ${h.pooled} h`; tip.append(head);
    for (const s of series) { const row = document.createElement('div'); row.className = 'tip__row'; const k = document.createElement('i'); k.style.background = s.color; const b = document.createElement('b'); b.textContent = s.value(h) ? usd(s.value(h)) : '–'; const t = document.createElement('span'); t.textContent = s.name; row.append(k, b, t); tip.append(row); }
    tip.hidden = false; const box = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - 210, (cx ?? box.left + (X(i) / W) * box.width) + 14)}px`; tip.style.top = `${(cy ?? box.top + 40) + scrollY - 10}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); $('tip').hidden = true; };
  const at = e => { const box = svg.getBoundingClientRect(); return Math.round(((((e.clientX - box.left) / box.width) * W - L) * (n - 1)) / (W - L - R)); };
  hit.addEventListener('pointermove', e => show(at(e), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', hide); hit.addEventListener('blur', hide); hit.addEventListener('focus', () => show(fi));
  hit.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') fi = Math.max(0, fi - 1); else if (e.key === 'ArrowRight') fi = Math.min(data.length - 1, fi + 1); else return; e.preventDefault(); show(fi); });
  el.replaceChildren(svg);
  $('weeks-table').innerHTML = `<table><thead><tr><th scope="col">Week</th><th scope="col">Co-op price</th><th scope="col">Your price</th><th scope="col">List price</th><th scope="col">Hours cleared</th></tr></thead><tbody>${data.map(h => `<tr><th scope="row">${h.week}${h.outage ? ' (outage)' : ''}</th><td>${usd(h.price)}</td><td>${h.youPrice ? usd(h.youPrice) : 'not filled'}</td><td>${usd(h.list)}</td><td>${h.volume} of ${h.pooled}</td></tr>`).join('')}</tbody></table>`;
}

function renderFeed() {
  const teamIds = new Set(state.teams.map(t => t.id)), providerIds = new Set(state.providers.map(p => p.id));
  const keep = f => feedFilter === 'all' || (feedFilter === 'team' ? teamIds.has(f.agent) && f.kind !== 'release'
    : feedFilter === 'provider' ? providerIds.has(f.agent) : ['week', 'release', 'clear', 'event'].includes(f.kind));
  const items = state.feed.filter(keep).slice(-160).reverse(), list = $('feed');
  list.replaceChildren();
  for (const f of items) {
    const li = document.createElement('li'); li.className = `feed__item feed__item--${f.kind}${f.agent === YOU ? ' feed__item--you' : ''}`;
    const meta = document.createElement('span'); meta.className = 'feed__meta'; meta.textContent = `Week ${f.week}`;
    const p = document.createElement('p'); p.textContent = f.text; li.append(meta, p); list.append(li);
  }
  if (!items.length) { const li = document.createElement('li'); li.className = 'feed__empty'; li.textContent = 'Every agent’s decision appears here, with its reason.'; list.append(li); }
}
for (const b of document.querySelectorAll('[data-feed]')) b.addEventListener('click', () => {
  for (const o of document.querySelectorAll('[data-feed]')) o.setAttribute('aria-pressed', String(o === b));
  feedFilter = b.dataset.feed; renderFeed();
});

function renderAll() {
  const r = state.report;
  setWeekLabels();
  renderPool(r, r ? 'cleared' : 'idle'); renderBids(r, r ? 'revealed' : 'empty'); renderClear(r); renderPay(r); renderResult(r); renderChart(); renderFeed();
}
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state && renderChart(), 150); });

// ---------- start ----------
(async () => {
  const saved = load();
  if (saved && saved.steps.length) {
    session = saved; await replay(saved);
    $('f-name').value = saved.request.name; $('f-hours').value = saved.request.hours; $('f-cap').value = (saved.request.cap / 100).toFixed(2);
    updateBudget(); renderAll();
    $('status').textContent = `Restored ${state.week} week${state.week === 1 ? '' : 's'}. Send your agent to week ${state.week + 1}.`;
  } else {
    state = createCoop(session.seed, session.request); session.initial = session.request; renderAll();
  }
})().catch(e => { $('status').textContent = `The co-op could not start: ${e.message}`; });
