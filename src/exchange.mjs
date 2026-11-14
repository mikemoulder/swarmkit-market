import './live.css';
import './exchange.css';
import { NearConnector } from '@hot-labs/near-connect';
import { cheapestCapacity } from 'near-swarmkit';

const KEEPER = import.meta.env.VITE_KEEPER_URL || 'https://swarmkit-exchange-keeper.mike-moulder-dev.workers.dev';
const EXCHANGE = 'exchange.swarmkit-live-150278.testnet';
const EARLIER = ['exchange.swarmx-6653d3dd2c.testnet', 'exchange.swarmx-56401c0681.testnet'];
const RPC = { testnet: 'https://test.rpc.fastnear.com', mainnet: 'https://free.rpc.fastnear.com', archival: 'https://archival-rpc.mainnet.fastnear.com' };
const TOKEN = 'wrap.testnet';
const MILLI = 10n ** 21n;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (id) => esc(String(id).length > 40 ? id.slice(0, 8) + '…' : id.split('.')[0]);
const wnear = (y) => { const v = Number(BigInt(y)) / 1e24; return v.toFixed(v < 0.01 ? 4 : 3); };
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (t) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

async function rpc(net, method, params) {
  const r = await fetch(RPC[net], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await r.json();
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error).slice(0, 200));
  return body.result;
}
async function view(contract, method, args = {}, net = 'testnet') {
  const r = await rpc(net, 'query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}
const keyCount = async (id, net = 'testnet') => (await rpc(net, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys.length;

// ---------- live round ----------
let round = null, config = null, account = null, wallet = null;
const PHASES = [['demand', 'Buyers join', 'demand_end'], ['commit', 'Sealed bids', 'commit_end'], ['reveal', 'Reveal', 'reveal_end'], ['clear', 'Clear', null], ['delivery', 'Delivery', 'delivery_end'], ['done', 'Finalized', null]];
function phaseOf(r) {
  if (!r) return null;
  const now = BigInt(Date.now()) * 1_000_000n;
  if (r.status === 'Finalized' || r.status === 'Failed') return 'done';
  if (r.status === 'Cleared') return 'delivery';
  if (now < BigInt(r.demand_end)) return 'demand';
  if (now < BigInt(r.commit_end)) return 'commit';
  if (now < BigInt(r.reveal_end)) return 'reveal';
  return 'clear';
}
const left = (ns) => { const s = Math.max(0, Math.round((Number(BigInt(ns) / 1_000_000n) - Date.now()) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

function renderRound() {
  const p = phaseOf(round);
  if (!round) { $('round-meta').textContent = 'No round yet. Opening one…'; return; }
  const deadline = PHASES.find(([k]) => k === p)?.[2];
  $('round-meta').textContent = `Round ${round.id} · ${round.status === 'Failed' ? 'failed: no fill, everyone refunded' : p}${deadline && round[deadline] ? ' · ' + left(round[deadline]) + ' left' : ''}`;
  const at = PHASES.findIndex(([k]) => k === p);
  $('phases').innerHTML = PHASES.map(([k, label], i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-now' : ''}">${label}</li>`).join('');
  $('orders').innerHTML = round.orders.length ? `<table><thead><tr><th>Buyer</th><th>Answers</th><th>Escrow</th></tr></thead><tbody>${round.orders.map((o) => `<tr class="${o.buyer === account ? 'is-you' : ''}"><td>${o.buyer === account ? 'You' : short(o.buyer)}</td><td>${o.quantity}</td><td>${wnear(o.budget)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">Waiting for buyers.</p>';
  const model = (id) => config?.providers.find((x) => x.id === id)?.model.split('/')[1] ?? '';
  $('bids').innerHTML = round.commitments.length ? `<table><thead><tr><th>Provider</th><th>Model (TEE)</th><th>Bid</th></tr></thead><tbody>${round.commitments.map((c) => {
    const o = round.offers.find((x) => x.seller === c.seller);
    const bid = o ? `${o.capacity} @ ${wnear(o.unit_price)}` : (p === 'demand' || p === 'commit' || p === 'reveal') ? `<span class="sealed" title="${esc(c.hash)}">sealed ${esc(c.hash.slice(0, 8))}</span>` : '<span class="bad">never revealed: bond forfeited</span>';
    return `<tr><td>${short(c.seller)}</td><td class="mono">${esc(model(c.seller))}</td><td>${bid}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="empty">Bids open after the buyers join.</p>';
  $('lines').innerHTML = round.lines.length ? `<table><thead><tr><th>Buyer</th><th>Provider</th><th>Answers</th><th>Price each</th><th>Delivered</th></tr></thead><tbody>${round.lines.map((l) => `<tr class="${l.buyer === account ? 'is-you' : ''}"><td>${l.buyer === account ? 'You' : short(l.buyer)}</td><td>${short(l.seller)}</td><td>${l.quantity}</td><td>${wnear(l.unit_price)}</td><td>${l.delivered}/${l.quantity}${l.delivered === l.quantity ? ' ✓ paid' : ''}</td></tr>`).join('')}</tbody></table>` : `<p class="empty">${round.status === 'Failed' ? 'The pool could not be filled within every budget, so every buyer was refunded.' : 'Clears after the reveal.'}</p>`;
  $('join').disabled = !(account && p === 'demand' && !round.orders.some((o) => o.buyer === account));
  $('join').textContent = p === 'demand' ? `Join round ${round.id} (${left(round.demand_end)} left)` : 'Next round opens soon';
}

async function refresh() {
  try {
    const count = Number(await view(EXCHANGE, 'get_round_count'));
    round = count ? await view(EXCHANGE, 'get_round', { round_id: String(count - 1) }) : null;
    renderRound();
    await renderMine();
  } catch (e) { $('round-meta').textContent = 'Could not reach NEAR testnet RPC: retrying.'; }
}
async function wake() {
  try { const r = await fetch(KEEPER + '/wake', { method: 'POST' }); const { did } = await r.json(); if (did) $('keeper-log').textContent = `Keeper: ${did}`; } catch {}
}

// ---------- wallet ----------
const connector = new NearConnector({ network: 'testnet' });
connector.on('wallet:signIn', async (t) => { account = t.accounts[0].accountId; wallet = await connector.wallet(); signedIn(); });
connector.on('wallet:signOut', () => { account = null; wallet = null; signedIn(); });
connector.wallet().then(async (w) => { const accounts = await w.getAccounts(); if (accounts?.length) { wallet = w; account = accounts[0].accountId; signedIn(); } }).catch(() => {});
function signedIn() {
  $('you-acct').textContent = account ?? 'Not connected';
  $('connect').textContent = account ? 'Disconnect' : 'Connect NEAR testnet wallet';
  $('connect').classList.toggle('btn--primary', !account);
  $('ask').hidden = !account;
  $('more').hidden = !account;
  if (account) $('status').textContent = 'Write a question, choose how many answers, and join while buyers are joining.';
  renderRound(); renderMine();
}
$('connect').onclick = () => (account ? connector.disconnect() : connector.connect());
const fc = (methodName, args, deposit, gas) => ({ type: 'FunctionCall', params: { methodName, args, gas: String(gas), deposit: String(deposit) } });
const TGAS = 10n ** 12n;
async function send(receiverId, actions) {
  const out = await wallet.signAndSendTransaction({ receiverId, actions });
  return out?.transaction?.hash ?? out?.transaction_outcome?.id;
}
const escrow = () => BigInt($('n').value) * BigInt($('max').value) * MILLI;
for (const id of ['n', 'max']) $(id).onchange = () => { $('escrow').textContent = wnear(escrow()); };
$('ask').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = $('q').value.trim();
  if (!prompt) { $('status').textContent = 'Write a question first.'; return; }
  const roundId = Number(round.id);
  $('join').disabled = true;
  $('status').textContent = 'Approve the transaction in your wallet: register, wrap and escrow in one go.';
  try {
    const hash = await send(TOKEN, [
      fc('storage_deposit', { account_id: account, registration_only: true }, 1_250_000_000_000_000_000_000n, 15n * TGAS),
      fc('near_deposit', {}, escrow(), 10n * TGAS),
      fc('ft_transfer_call', { receiver_id: EXCHANGE, amount: String(escrow()), msg: JSON.stringify({ round_id: roundId, quantity: $('n').value, prompt_sha: await sha(prompt) }) }, 1n, 100n * TGAS),
    ]);
    const r = await fetch(KEEPER + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ round_id: roundId, buyer: account, prompt, tx_hash: hash }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    store.set('swarmkit-mine', { round: roundId, account });
    $('status').innerHTML = `You're in round ${roundId}. <a href="https://testnet.nearblocks.io/txns/${esc(hash)}" rel="noopener">Your escrow</a>. Providers bid next; answers arrive after clearing.`;
    refresh();
  } catch (error) { $('status').textContent = `Not joined: ${error.message ?? error}`; $('join').disabled = false; }
};

async function renderMine() {
  if (!account) { $('mine').innerHTML = ''; return; }
  const saved = store.get('swarmkit-mine');
  const roundId = saved?.account === account ? saved.round : round && round.orders.some((o) => o.buyer === account) ? Number(round.id) : null;
  if (roundId === null || roundId === undefined) { $('mine').innerHTML = ''; return; }
  const r = Number(round?.id) === roundId ? round : await view(EXCHANGE, 'get_round', { round_id: String(roundId) });
  const mine = r.lines.filter((l) => l.buyer === account);
  let html = `<h3>Round ${roundId}: ${r.status === 'Open' ? 'waiting for clearing' : r.status}</h3>`;
  if (r.status === 'Failed') html += '<p class="small">The pool could not be filled within every budget. Your escrow is refunded: withdraw it below.</p>';
  if (r.status !== 'Open' && !mine.length && r.status !== 'Failed') html += '<p class="small">No answers were allocated to you this round; your escrow is refundable.</p>';
  if (mine.length) {
    const served = await (await fetch(`${KEEPER}/answers?round=${roundId}&buyer=${encodeURIComponent(account)}`)).json();
    for (const line of mine) {
      const s = served.answers.find((a) => a.seller === line.seller);
      html += `<div class="answer"><p class="answer__who">${short(line.seller)} · ${line.quantity} × ${wnear(line.unit_price)} wNEAR</p>`;
      if (!s) { html += '<p class="small muted">Waiting for the provider to answer…</p></div>'; continue; }
      const ok = (await sha(JSON.stringify(s.units.map((u) => u.unitReceipt)))) === s.lineReceipt;
      for (const u of s.units) html += `<blockquote>${esc(u.answer || '(empty answer)')}</blockquote><p class="sig">TEE signature (${esc(u.signature?.signing_algo ?? 'none')}) over <code>${esc((u.signature?.text ?? '').slice(0, 60))}…</code> by <code>${esc((u.signature?.signing_address ?? '').slice(0, 12))}…</code></p>`;
      const can = r.status === 'Cleared' && line.delivered === '0' && BigInt(Date.now()) * 1_000_000n < BigInt(r.delivery_end);
      html += `<p class="sig">Receipt <code>${s.lineReceipt.slice(0, 16)}…</code> ${ok ? '✓ matches the answers above' : '✗ does not match'}</p>`;
      html += line.delivered !== '0' ? '<p class="ok">Confirmed on chain: the provider was paid.</p>' : can ? `<button class="btn btn--primary btn--wide" data-confirm="${esc(line.seller)}" data-units="${line.quantity}" data-receipt="${s.lineReceipt}">Confirm delivery and pay ${wnear(BigInt(line.quantity) * BigInt(line.unit_price))} wNEAR</button>` : '<p class="small muted">Not confirmed: refunded at finalize.</p>';
      html += '</div>';
    }
  }
  $('mine').innerHTML = html;
  for (const b of $('mine').querySelectorAll('[data-confirm]')) b.onclick = async () => {
    b.disabled = true;
    try {
      const hash = await send(EXCHANGE, [fc('confirm_delivery', { round_id: String(roundId), seller: b.dataset.confirm, units: b.dataset.units, receipt: b.dataset.receipt }, 0n, 30n * TGAS)]);
      $('status').innerHTML = `Paid on delivery. <a href="https://testnet.nearblocks.io/txns/${esc(hash)}" rel="noopener">Transaction</a>.`;
      refresh();
    } catch (error) { $('status').textContent = `Not confirmed: ${error.message ?? error}`; b.disabled = false; }
  };
}
$('withdraw').onclick = async () => {
  const [token] = await view(EXCHANGE, 'get_balances', { account_id: account });
  if (BigInt(token) === 0n) { $('status').textContent = 'Nothing to withdraw yet: refunds appear after clearing or finalize.'; return; }
  try { const h = await send(EXCHANGE, [fc('withdraw_token', {}, 0n, 60n * TGAS)]); $('status').innerHTML = `Withdrew ${wnear(token)} wNEAR. <a href="https://testnet.nearblocks.io/txns/${esc(h)}" rel="noopener">Transaction</a>.`; } catch (e) { $('status').textContent = String(e.message ?? e); }
};
$('unwrap').onclick = async () => {
  const bal = await view(TOKEN, 'ft_balance_of', { account_id: account });
  if (BigInt(bal) === 0n) { $('status').textContent = 'No wNEAR to unwrap.'; return; }
  try { await send(TOKEN, [fc('near_withdraw', { amount: bal }, 1n, 10n * TGAS)]); $('status').textContent = `Unwrapped ${wnear(bal)} NEAR.`; } catch (e) { $('status').textContent = String(e.message ?? e); }
};

// ---------- verify in the browser ----------
async function verifyExchange(contract) {
  const results = [];
  const add = (ok, text) => results.push({ ok, text });
  add((await keyCount(contract)) === 0, `${contract} has no access keys`);
  const count = Number(await view(contract, 'get_round_count'));
  for (let id = 0; id < count; id++) {
    const r = await view(contract, 'get_round', { round_id: String(id) });
    if (r.status === 'Open') continue;
    const buyers = r.orders.map((o) => ({ buyerId: o.buyer, quantity: o.quantity, budget: o.budget }));
    const offers = r.offers.map((o) => ({ sellerId: o.seller, capacity: o.capacity, unitPrice: o.unit_price }));
    const sdk = buyers.length ? cheapestCapacity.allocate(structuredClone(buyers), structuredClone(offers)) : null;
    const chain = r.lines.map((l) => ({ buyerId: l.buyer, sellerId: l.seller, quantity: l.quantity }));
    const same = sdk === null ? r.status === 'Failed' : JSON.stringify(sdk) === JSON.stringify(chain);
    const caps = r.orders.every((o) => r.lines.filter((l) => l.buyer === o.buyer).reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unit_price), 0n) <= BigInt(o.budget))
      && r.offers.every((o) => r.lines.filter((l) => l.seller === o.seller).reduce((s, l) => s + BigInt(l.quantity), 0n) <= BigInt(o.capacity));
    add(same && caps, `${contract.split('.')[1]} round ${id}: ${sdk === null ? 'no fill, refunded (SDK agrees)' : `${chain.length} lines equal the SDK's`}; budgets and capacities respected`);
  }
  return results;
}
async function verifyAll() {
  $('checks').innerHTML = '<li>Reading every round from NEAR testnet…</li>';
  const all = [];
  for (const c of [EXCHANGE, ...EARLIER]) { try { all.push(...await verifyExchange(c)); } catch (e) { all.push({ ok: false, text: `${c}: ${e.message}` }); } }
  $('checks').innerHTML = all.map((c) => `<li class="${c.ok ? 'pass' : 'fail'}">${c.ok ? 'PASS' : 'FAIL'} <span>${esc(c.text)}</span></li>`).join('');
  const passed = all.filter((c) => c.ok).length;
  $('k-verify').textContent = `${passed}/${all.length} pass`;
}
$('reverify').onclick = verifyAll;

// ---------- mainnet ----------
async function verifyMainnet() {
  const ev = await (await fetch('./mainnet-proof.json')).json();
  const prefix = `swarmkit:v1:${ev.round}:`;
  const state = await rpc('mainnet', 'query', { request_type: 'view_state', finality: 'final', account_id: ev.anchor, prefix_base64: btoa(prefix) });
  const anchors = state.values.map(({ key, value }) => {
    const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0)); const sep = raw.indexOf(0);
    const v = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return { text: new TextDecoder().decode(raw.slice(0, sep)), signer: new TextDecoder().decode(raw.slice(sep + 1)), at: new DataView(v.buffer).getBigUint64(0, true) };
  }).sort((a, b) => (a.at < b.at ? -1 : 1));
  const sealed = anchors.find((a) => a.text.endsWith(':sealed'));
  const commits = ev.transcript.events.filter((e) => e.type === 'commitment');
  const checks = [];
  checks.push({ ok: (await keyCount(ev.anchor, 'mainnet')) === 0, text: `anchor account ${ev.anchor.slice(0, 10)}… has no keys` });
  for (const c of commits) {
    const a = anchors.find((x) => x.text === prefix + 'commit:' + c.hash);
    checks.push({ ok: Boolean(a && sealed && a.signer === c.sellerId && a.at < sealed.at), text: `seller ${c.sellerId.slice(0, 8)}… anchored its sealed bid before "sealed"` });
  }
  checks.push({ ok: !anchors.some((a) => a.text.includes(':commit:') && !commits.some((c) => a.text.endsWith(c.hash))), text: 'no anchored bid is missing from the published transcript' });
  const transcriptHash = await sha(JSON.stringify(ev.transcript));
  checks.push({ ok: anchors.some((a) => a.text === prefix + 'result:' + transcriptHash && sealed && a.at > sealed.at), text: 'the transcript hash your browser computes was anchored after sealing' });
  for (const r of ev.transactions.settlement.receipts) {
    let ok = false;
    try { const t = await rpc('archival', 'tx', { tx_hash: r.transactionHash, sender_account_id: ev.plan.payments[0] ? '16edfaecf85b63f75ca38528133de563490ebd242f2404daf594017e4a07d0f3' : '', wait_until: 'NONE' }); ok = t.final_execution_status === 'FINAL' && t.transaction.receiver_id === 'intents.near' && 'SuccessValue' in t.status; } catch {}
    checks.push({ ok, text: `NEAR Intents payment <a href="https://nearblocks.io/txns/${r.transactionHash}" rel="noopener">${r.transactionHash.slice(0, 10)}…</a> final on intents.near`, html: true });
  }
  $('m-checks').innerHTML = checks.map((c) => `<li class="${c.ok ? 'pass' : 'fail'}">${c.ok ? 'PASS' : 'FAIL'} <span>${c.html ? c.text : esc(c.text)}</span></li>`).join('');
  $('k-mainnet').textContent = `${checks.filter((c) => c.ok).length}/${checks.length} pass`;
  $('anchors').innerHTML = `<table><thead><tr><th>Anchored on mainnet</th><th>By</th><th>When (UTC)</th></tr></thead><tbody>${anchors.map((a) => `<tr><td class="mono">${esc(a.text.slice(prefix.length, prefix.length + 30))}${a.text.length > prefix.length + 30 ? '…' : ''}</td><td class="mono">${esc(a.signer.slice(0, 10))}…</td><td>${new Date(Number(a.at / 1_000_000n)).toISOString().slice(11, 19)}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- start ----------
fetch(KEEPER + '/config').then((r) => r.json()).then((c) => { config = c; $('ex-name').textContent = c.exchange; renderRound(); }).catch(() => {});
$('ex-name').textContent = EXCHANGE;
wake(); refresh(); verifyAll(); verifyMainnet().catch((e) => { $('m-checks').innerHTML = `<li class="fail">FAIL <span>${esc(e.message)}</span></li>`; });
setInterval(refresh, 5000);
setInterval(() => { if (!document.hidden) wake(); }, 45_000);
setInterval(() => { if (round) renderRound(); }, 1000);
