import './style.css';
const $ = id => document.getElementById(id);
const local = Boolean(document.querySelector('meta[name="market-host"]'));
let token, timer, download;
function showEvidence(evidence) {
  const checks = evidence.audit?.checks ?? [];
  $('evidence-status').textContent = `${evidence.plan.roundId} · ${checks.filter(c=>c.matches === true).length}/${evidence.plan.payments.length} RPC matches · audit recorded ${evidence.validatedAt}`;
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const title of ['Buyer', 'Seller', 'yoctoNEAR', 'Transaction']) { const th=document.createElement('th'); th.textContent=title; header.append(th); }
  const body = table.createTBody();
  for (const payment of evidence.plan.payments) {
    const row=body.insertRow();
    for (const value of [payment.buyerId,payment.sellerId,payment.amount]) row.insertCell().textContent=value;
    const cell=row.insertCell(), receipt=evidence.receipts.find(r=>r.paymentId===payment.id);
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(receipt?.transactionHash)) {
      const link=document.createElement('a'); link.textContent=receipt.transactionHash.slice(0,16)+'… ↗'; link.href='https://testnet.nearblocks.io/txns/'+receipt.transactionHash; cell.append(link);
    }
  }
  $('receipts').replaceChildren(table);
  if (download) URL.revokeObjectURL(download);
  download=URL.createObjectURL(new Blob([JSON.stringify(evidence,null,2)],{type:'application/json'}));
  $('download').href=download; $('download').download='testnet-evidence.json'; $('download').hidden=false;
}
async function refresh() {
  clearTimeout(timer);
  try {
    const response=await fetch('/api/testnet'); if(!response.ok)throw new Error('Coordinator unavailable');
    const job=await response.json();
    $('job-status').textContent=`${job.status}: ${job.message??'Ready. A run uses faucet test tokens and may take several minutes.'}`;
    for(const id of ['gpu','split']) $(id).disabled=job.status==='running';
    if(job.evidence)showEvidence(job.evidence);
    if(job.status==='running')timer=setTimeout(refresh,3000);
  } catch(error){$('job-status').textContent=error.message;}
}
for(const scenario of ['gpu','split']) {
  $(scenario).onclick=async()=>{
    for(const id of ['gpu','split'])$(id).disabled=true;
    try {
      if(!token)token=(await(await fetch('/api/session')).json()).token;
      const response=await fetch('/api/testnet',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({configuration:{scenario}})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      await refresh();
    }catch(error){$('job-status').textContent=error.message; for(const id of ['gpu','split'])$(id).disabled=false;}
  };
  $('recorded-'+scenario).onclick=async()=>{
    try{const response=await fetch(`./${scenario}-testnet.json`);if(!response.ok)throw new Error('Evidence unavailable');showEvidence(await response.json());}
    catch(error){$('evidence-status').textContent=error.message;}
  };
}
if(local)void refresh();else{$('job-status').textContent='Public evidence explorer · run new payments through the local coordinator.';$('local-help').hidden=false;}
