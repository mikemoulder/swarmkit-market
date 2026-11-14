import { browserStore } from './browser-store.mjs';
import { marketController } from './controller.mjs';
import './style.css';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const number = value => new Intl.NumberFormat('en').format(Number(value));
const stages = ['ready', 'demand', 'commit', 'reveal', 'closed'];
const stageLabels = ['Ready', 'Demand', 'Sealed bids', 'Reveals', 'Allocation', 'Settlement'];
let controller, view, tab = 'overview', selected, busy = false, running = false, message = '', chain = null;
const name = id => view.agents.find(a => a.id === id)?.label ?? id;
const table = (caption, headers, rows) => `<div class="table-scroll"><table><caption>${escape(caption)}</caption><thead><tr>${headers.map(h=>`<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const row = cells => `<tr>${cells.map((c,i)=>i ? `<td>${c}</td>` : `<th scope="row">${c}</th>`).join('')}</tr>`;
const empty = (title, detail) => `<div class="empty"><h3>${escape(title)}</h3><p>${escape(detail)}</p></div>`;
const agentLink = id => `<button class="text-button" data-agent="${escape(id)}">${escape(name(id))}<span aria-hidden="true"> ↗</span></button>`;
const lines = () => view.snapshot.splitAllocation?.lines ?? [];
const total = () => view.plan?.payments.reduce((n,p)=>n+Number(p.amount),0) ?? 0;
const displayedHistory = () => view.settled ? [...view.history, {number:view.number,total:total(),baseline:view.baseline}] : view.history;

function actionLabel() {
  if (view.interrupted) return view.settings.scenario === 'approval' ? 'Apply revised demo approval' : 'Reconcile saved payments';
  if (view.settled) return 'Open next round';
  return ['Collect demand', 'Commit seller bids', 'Reveal seller bids', 'Clear allocation', 'Settle payments'][stages.indexOf(view.stage)];
}
function activity(events) {
  return `<ol class="event-list">${events.map(e=>`<li><span class="event-index">${String(e.sequence).padStart(3,'0')}</span><div><div class="event-head"><b>${escape(name(e.actor))}</b><span>Round ${e.round} · ${escape(e.action.replaceAll('-',' '))}</span></div><p>${escape(e.detail)}</p></div></li>`).join('')}</ol>`;
}
function chart() {
  const history = displayedHistory().slice(-20);
  if (!history.length) return empty('Your first round sets the baseline', 'Complete a round and open the next to compare prices and procurement costs over time.');
  const max = Math.max(1,...history.map(h=>Math.max(h.total,h.baseline??0)));
  return `<div class="chart" aria-label="Pooled and solo cost by round">${history.map(h=>`<div class="chart-column"><div class="bars"><span class="bar solo" style="height:${100*(h.baseline??0)/max}%" title="Solo ${h.baseline??'unfilled'}"></span><span class="bar pooled" style="height:${100*h.total/max}%" title="Pooled ${h.total}"></span></div><span>${h.number}</span></div>`).join('')}</div><p class="legend"><i></i>Pooled cost <i class="solo"></i>Solo comparison · hover bars for credit amounts</p>`;
}
function overview() {
  const allocated = lines();
  const flow = view.agents.filter(a=>a.role==='seller').map(s=>{
    const sold = allocated.filter(l=>l.sellerId===s.id), units=sold.reduce((n,l)=>n+Number(l.quantity),0);
    const bid=view.snapshot.bids.find(b=>b.sellerId===s.id);
    return `<div class="flow-row"><div>${agentLink(s.id)}<span>${bid?.reveal ? `${bid.reveal.unitPrice} credits / unit` : bid ? 'Offer sealed' : 'Waiting for demand'}</span></div><div class="flow-track"><span style="width:${units?Math.max(3,units/Number(view.snapshot.quantity)*100):0}%"></span></div><div><b>${units || '—'}</b><span>${sold.length} buyers</span></div></div>`;
  }).join('');
  return `<div class="overview-grid"><section class="panel"><div class="panel-heading"><div><p class="micro">Resource allocation</p><h2>From sellers to the pool</h2></div><span class="tag">${escape(view.snapshot.spec.resource.unit)}s</span></div><div class="flows">${flow}</div><p class="panel-note">${escape(view.explanation?.reason ?? 'Offers and allocation appear only after their execution stages run.')}</p></section><section class="panel"><div class="panel-heading"><div><p class="micro">Coordination value</p><h2>Pool versus solo</h2></div></div><div class="comparison"><div><span>Pooled cost</span><strong>${view.plan?.payments.length ? number(total()) : '—'}</strong></div><div><span>Solo comparison</span><strong>${view.baseline===null?'—':number(view.baseline)}</strong></div></div><p class="panel-note">${view.baseline!==null && allocated.length ? `${number(view.baseline-total())} credits difference under the documented volume-discount policy.` : 'A capacity-constrained comparison appears after clearing. No savings are assumed.'}</p></section><section class="panel"><div class="panel-heading"><div><p class="micro">Completed rounds</p><h2>How the economy changes</h2></div></div>${chart()}</section><section class="panel"><div class="panel-heading"><div><p class="micro">Execution trace</p><h2>Recent decisions</h2></div><button class="text-button" data-tab="activity">View all →</button></div>${activity(view.events.slice(-4).reverse())}</section></div>`;
}
function orderbook() {
  const bids=view.snapshot.bids;
  return `<div class="overview-grid"><section class="panel"><div class="panel-heading"><h2>Buyer demand</h2><span class="tag">${view.snapshot.buyers.length} requests</span></div>${view.snapshot.buyers.length?table('Quantities and binding budget limits',['Buyer','Units','Cap','Allocated cost'],view.snapshot.buyers.map(b=>row([agentLink(b.buyerId),b.quantity,b.budget,view.explanation?.buyers.find(a=>a.buyerId===b.buyerId)?.spent??'—']))):empty('Demand has not been collected','Buyer callbacks execute when you collect demand.')}</section><section class="panel"><div class="panel-heading"><h2>Seller commitments</h2></div>${bids.length?table('Sealed commitments and revealed offers',['Seller','Price','Capacity','Decision'],bids.map(b=>row([`${agentLink(b.sellerId)}<small class="hash" title="${b.commitment}">${b.commitment.slice(0,12)}…</small>`,b.reveal?.unitPrice??'Sealed',b.reveal?.capacity??'Sealed',escape(view.explanation?.sellers.find(s=>s.sellerId===b.sellerId)?.reason.replaceAll('-',' ')??(b.reveal?'Verified reveal':'Committed'))]))):empty('No commitments yet','Sellers quote against collected demand. Their offers stay out of the public view until reveal.')}</section></div>${lines().length?`<section class="panel spaced"><div class="panel-heading"><h2>Allocation decisions</h2></div>${table('Buyer–seller fulfillment lines',['Buyer','Seller','Units','Price','Charge'],lines().map(l=>row([agentLink(l.buyerId),agentLink(l.sellerId),l.quantity,l.unitPrice,l.amount])))}</section>`:''}`;
}
function agents() {
  const agent=view.agents.find(a=>a.id===selected)??view.agents[0]; selected=agent.id;
  return `<div class="agents-grid"><section class="panel"><div class="panel-heading"><h2>Agent registry</h2><span class="tag">${view.agents.length} participants</span></div>${table('Choose an agent to inspect its policy',['Agent','Role','Balance','Stock'],view.agents.map(a=>row([agentLink(a.id),a.role,number(a.balance),number(a.stock)])))}</section><section class="panel inspector"><div class="panel-heading"><div><p class="micro">${escape(agent.id)}</p><h2>${escape(agent.label)}</h2></div><span class="tag">${agent.role}</span></div><div class="inspector-body"><h3>Decision policy</h3><p>${escape(agent.policy)}</p><dl><div><dt>Balance</dt><dd>${number(agent.balance)} credits</dd></div><div><dt>${agent.role==='buyer'?'Purchased':'Sold'} to date</dt><dd>${number(agent.fulfilled??agent.sold)} units</dd></div></dl><form id="agent-form"><h3>Policy inputs</h3>${agent.role==='buyer'?`<label>Units requested<input name="requested" type="number" min="1" max="50" value="${agent.requested}" required></label><label>Maximum credits per unit<input name="limit" type="number" min="1" max="50" value="${agent.limit}" required></label>`:`<label>Base unit price<input name="price" type="number" min="${agent.floor}" max="50" value="${agent.price}" required></label>`}<button type="submit" class="secondary" ${view.stage!=='ready'||busy?'disabled':''}>Save policy for this round</button><p class="muted">${view.stage==='ready'?'Changes persist before demand collection.':'Policies are frozen for this round. Open the next round to edit.'}</p></form></div>${activity(view.events.filter(e=>e.actor===agent.id).slice(-8).reverse())}</section></div>`;
}
function settlement() {
  const a=view.accounting, receipts=new Map(view.receipts.map(r=>[r.paymentId,r]));
  return `<section class="panel"><div class="panel-heading"><div><p class="micro">Simulated payment journal</p><h2>${view.interrupted?'Settlement needs recovery':view.settled?'Receipts reconciled':'Exact buyer payments'}</h2></div><span class="tag">${view.prepared} prepared / ${view.broadcasts} broadcast</span></div>${view.plan?.payments.length ? table('Stable payment identities and receipt state',['Buyer','Seller','Credits','Status','Transaction'],view.plan.payments.map(p=>{const r=receipts.get(p.id);return row([agentLink(p.buyerId),agentLink(p.sellerId),p.amount,escape(r?.status??'Awaiting approval'),r?.transactionHash?`<span class="hash" title="${escape(r.transactionHash)}">${escape(r.transactionHash.slice(0,18))}…</span>`:'—']);})):empty(view.plan?'No transfers required':'The payment plan is not available yet',view.plan?'This round made no allocation.':'A plan is derived only from a closed, replayed round.')}<p class="panel-note">${view.interrupted?'Your checkpoint is saved. You can reload or restart the coordinator, then recover the same payments.':'Journal entries persist before simulated broadcast. Each confirmed payment updates the ledger once.'} Synthetic approvals cannot authorize real funds.</p></section><section class="panel spaced"><div class="panel-heading"><h2>Accounting identity</h2></div><div class="accounting"><p><b>${number(a.initialMoney)}</b> initial credits + <b>${number(a.income)}</b> work income − <b>${number(a.productionCosts)}</b> production cost = <b>${number(a.money)}</b> current credits</p><p><b>${number(a.initialStock)}</b> initial units + <b>${number(a.produced)}</b> produced − <b>${number(a.consumed)}</b> consumed = <b>${number(a.stock)}</b> current units</p></div></section><section class="panel spaced"><div class="panel-heading"><div><p class="micro">Separate network evidence</p><h2>Recorded NEAR testnet transfers</h2></div><button class="secondary" id="load-evidence">Load recorded receipts</button></div><p class="panel-note">These validation runs use the packaged SDK and actual testnet subaccounts. Receipt audits check finalized sender, recipient and amount. They are separate from this credit simulation and are not NEAR Intents execution.</p><div id="chain-output">${chain??''}</div></section><section class="panel spaced"><div class="panel-heading"><h2>Take a real plan to NEAR Intents</h2></div><div class="accounting"><p>The operator CLI consumes a closed transcript denominated in a Verifier asset with real participant IDs. Review the plan before loading buyer and relayer keys. This simulated credit market cannot become a funded payment by changing its asset label.</p><pre>npm run intents -- round.json accounts.json --review
npm run intents -- round.json accounts.json --reconcile</pre><a href="https://github.com/mikemoulder/swarmkit-market#settle-through-near-intents">Operator setup and execution instructions ↗</a></div></section>`;
}
function render() {
  if (!view) return;
  $('round-number').textContent=`Round ${String(view.number).padStart(2,'0')} · ${view.preset==='gpu'?'GPU cooperative':'Inference exchange'}`;
  $('round-title').textContent=view.interrupted?'Recovery checkpoint':view.settled?'Round settled':stageLabels[stages.indexOf(view.stage)];
  $('advance').textContent=actionLabel(); $('advance').disabled=busy||running;
  $('run').textContent=running?'Pause after this stage':'Run one round'; $('run').disabled=(busy&&!running)||view.interrupted;
  $('new-market').disabled=busy||running; $('export').disabled=busy;
  $('status').textContent=message || (view.interrupted?'Saved an interrupted settlement. Recovery will inspect the original transaction identities.':'Every completed action is saved. Reloading keeps this experiment.');
  const current=view.settled||view.interrupted?5:stages.indexOf(view.stage);
  $('phases').innerHTML=stageLabels.map((s,i)=>`<li ${i===current?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}</span>${s}</li>`).join('');
  $('metrics').innerHTML=[['Active participants',view.agents.length],['Pooled demand',view.snapshot.quantity],['Allocated cost',view.plan?total():'—'],['Completed rounds',displayedHistory().length]].map(([label,value])=>`<div><span>${label}</span><strong>${typeof value==='number'?number(value):value}</strong></div>`).join('');
  document.querySelectorAll('.tabs [data-tab]').forEach(b=>{if(b.dataset.tab===tab)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('workspace').innerHTML=({overview,orderbook,agents,activity:()=>`<section class="panel"><div class="panel-heading"><h2>Decision and execution history</h2><span class="tag">${view.events.length} events</span></div>${activity(view.events.slice(-150).reverse())}<p class="panel-note">Showing the latest 150 events. Export includes the complete history.</p></section>`,settlement})[tab]();
}
async function act(command, configuration) {
  if (busy) return;
  busy=true; render();
  try { view=await controller.command(command,configuration); message=`Saved round ${view.number} · ${view.interrupted?'recovery required':view.settled?'settled':view.stage}.`; }
  catch(error) { message=error.message; running=false; try{view=await controller.read()??view;}catch{} }
  finally { busy=false;render(); }
}
async function runRound() {
  if(running){running=false;render();return;}
  running=true;
  try {
    if(view.settled)await act('advance');
    while(running&&!view.settled&&!view.interrupted) { await act('advance'); await new Promise(resolve=>setTimeout(resolve,450)); }
  } finally { running=false;render(); }
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.dataset.agent){selected=button.dataset.agent;tab='agents';render();
    const inspector=document.querySelector('.inspector');inspector.setAttribute('tabindex','-1');inspector.focus({preventScroll:true});
    if(matchMedia('(max-width:900px)').matches)inspector.scrollIntoView({block:'start'});
  }
  else if(button.dataset.tab){tab=button.dataset.tab;render();}
});
$('advance').addEventListener('click',()=>act(view.interrupted?'resume':'advance'));
$('run').addEventListener('click',runRound);
$('new-market').addEventListener('click',()=>$('configuration').showModal());
$('close-config').addEventListener('click',()=>$('configuration').close());
$('configure-form').addEventListener('submit',async event=>{
  event.preventDefault(); const data=new FormData(event.target);
  await act('reset',{preset:data.get('preset'),supply:data.get('supply'),scenario:data.get('scenario'),seed:Number(data.get('seed'))});
  if(message.startsWith('Saved')){$('configuration').close();selected=null;render();}else $('config-error').textContent=message;
});
$('workspace').addEventListener('submit',event=>{
  if(event.target.id!=='agent-form')return; event.preventDefault();
  const data=Object.fromEntries([...new FormData(event.target)].map(([k,v])=>[k,Number(v)]));
  void act('configure-agent',{agentId:selected,...data});
});
$('export').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(view,null,2)],{type:'application/json'}));
  const link=Object.assign(document.createElement('a'),{href:url,download:`swarmkit-${view.id}-round-${view.number}.json`});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('workspace').addEventListener('click',async event=>{
  if(event.target.id!=='load-evidence')return;
  event.target.disabled=true;
  try {
    const runs=await Promise.all(['gpu','split'].map(async scenario=>{
      const response=await fetch(`${import.meta.env.BASE_URL}${scenario}-testnet.json`);if(!response.ok)throw new Error('Testnet evidence could not load');
      const data=await response.json();
      const payments=new Map(data.plan.payments.map(p=>[p.id,p]));
      return `<h3>${scenario==='gpu'?'20-buyer GPU procurement':'Multi-seller fulfillment'}</h3><p class="panel-note">${data.validatedAt?`RPC audit recorded ${escape(data.validatedAt)}. `:''}Native NEAR testnet. <a href="${import.meta.env.BASE_URL}${scenario}-testnet.json">Download transcript and receipts ↗</a></p>`+table('Native testnet payment evidence',['Buyer → seller','Amount (yoctoNEAR)','Receipt'],data.receipts.map(r=>{const p=payments.get(r.paymentId);return row([escape(p?`${p.buyerId} → ${p.sellerId}`:r.paymentId),escape(p?.amount??''),/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.transactionHash)?`<a href="https://testnet.nearblocks.io/txns/${r.transactionHash}">${r.transactionHash.slice(0,16)}… ↗</a>`:'Unavailable']);}));
    }));
    chain=runs.join('');render();
  } catch(error){message=error.message;render();}
});
async function boot() {
  try {
    if(document.querySelector('meta[name="market-host"]')) {
      const {token}=await(await fetch('/api/session')).json();
      controller={read:async()=> (await fetch('/api/state')).json(),command:async(command,configuration)=>{
        const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({command,configuration})});
        const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
      }};
      $('storage').textContent='Local coordinator · SQLite checkpoints';
    } else {
      controller=marketController(await browserStore()); $('storage').textContent='Browser workspace · IndexedDB checkpoints';
    }
    view=await controller.command('create');render();
  }catch(error){$('status').textContent=`Unable to open durable storage: ${error.message}. This app will not silently switch to an unsaved session.`;}
}
void boot();
