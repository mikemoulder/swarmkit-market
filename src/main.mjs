import { auditSettlement } from "near-swarmkit";
import { applyReceipts, createSimulatedSettlement, makeIntentsPreview, openMarketRound, pendingSummary, startingBalances } from "./market.mjs";
import "./style.css";

const element = (id) => document.getElementById(id);
const advance = element("advance");
const reset = element("reset");
const supply = element("supply");
const scenario = element("scenario");
const exportButton = element("export");
const evidence = element("evidence");
const phaseNames = ["Demand", "Commit", "Reveal", "Clear", "Settle"];
const labelById = new Map(startingBalances.map(({ id, label }) => [id, label]));
const label = (id) => labelById.get(id);
let agents;
let rounds;
let round;
let settlement;
let runner;
let phase;
let busy = false;
let evidenceRequest = 0;
let marketSettings;

function nearAmount(amount) {
  const digits = amount.padStart(25, "0");
  const fraction = digits.slice(-24).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, -24)}.${fraction}` : digits.slice(0, -24);
}

function table(title, headings, rows) {
  const caption = title ? `<caption>${title}</caption>` : "";
  return `<div class="table-scroll"><table>${caption}<thead><tr>${headings.map((heading) =>
    `<th scope="col">${heading}</th>`).join("")}</tr></thead><tbody>${rows.map(([name, ...cells]) =>
    `<tr><th scope="row">${name}</th>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function displayedLedger() {
  return settlement ? applyReceipts(agents, round.stages[3], round.plan, settlement.receipts) : agents;
}

function render(message) {
  const snapshot = round.stages[Math.min(phase, 3)];
  const showClearing = phase >= 3;
  const allocation = showClearing ? snapshot.splitAllocation : null;
  const summary = settlement?.summary ?? pendingSummary(round.plan);
  const completed = phase === 4 && (summary.paid || !round.plan.payments.length);
  element("round-number").textContent = `ROUND ${String(rounds.length + 1).padStart(2, "0")}`;
  element("round-title").textContent = phaseNames[phase];
  element("status").textContent = message;
  advance.textContent = ["Seal bids", "Reveal bids", "Clear market", "Settle payments", completed ? "Open next round" : "Resume settlement"][phase];
  reset.disabled = busy;
  advance.disabled = busy;
  supply.disabled = busy || (phase !== 0 && !completed);
  scenario.disabled = busy || (phase !== 0 && !completed);
  exportButton.disabled = busy || !showClearing;
  element("phases").innerHTML = phaseNames.map((name, index) =>
    `<li${index === phase ? ' aria-current="step"' : ""} class="${index < phase ? "passed" : ""}">${name}</li>`).join("");
  const metrics = [["Pooled demand", snapshot.quantity], ["Allocated credits", allocation ? snapshot.quantity : "—"],
    ["Total cost", allocation?.total ?? "—"], ["Confirmed", settlement ? summary.confirmed : "—"]];
  element("metrics").innerHTML = metrics.map(([name, value]) => `<div><span>${name}</span><b>${value}</b></div>`).join("");
  const book = [];
  if (!snapshot.bids.length && phase < 3) {
    book.push(table("Buyer demand", ["Buyer", "Credits", "Spend cap"], snapshot.buyers.map((buyer) =>
      [label(buyer.buyerId), buyer.quantity, buyer.budget])));
  }
  if (snapshot.bids.length) {
    book.push(table("Seller bids", ["Seller", "Price", "Capacity", "Status"], snapshot.bids.map((bid) => [
      label(bid.sellerId), bid.reveal?.unitPrice ?? "—", bid.reveal?.capacity ?? "—",
      !bid.reveal ? "Sealed" : allocation?.lines.some((line) => line.sellerId === bid.sellerId) ? "Allocated" : "Revealed",
    ])));
  }
  if (allocation) {
    const receipts = new Map(settlement?.receipts.map((receipt) => [receipt.paymentId, receipt]));
    const rows = allocation.lines.map((line, index) => {
      const receipt = receipts.get(round.plan.payments[index].id);
      const status = receipt?.broadcastUncertain ? "Awaiting receipt" : receipt?.status ?? "Awaiting approval";
      return [label(line.buyerId), label(line.sellerId), line.quantity, line.amount, status];
    });
    book.push(table("Allocation and payments", ["Buyer", "Seller", "Credits", "Amount", "Status"], rows));
  } else if (showClearing) {
    book.push('<p class="empty">The offers could not fill the pool within its budgets. No payments were created.</p>');
  }
  element("book").innerHTML = book.join("");
  element("intent-panel").hidden = !allocation;
  element("ledger").innerHTML = table("", ["Agent", "Role", "Balance", "Stock"], displayedLedger().map((agent) =>
    [agent.label, agent.role, String(agent.balance), String(agent.stock)]));
  element("history").innerHTML = rounds.map(({ number, paid, total }) =>
    `<li><span>Round ${number}</span><span>${paid ? `${total} credits settled` : "No sale"}</span></li>`).join("")
    || "<li>No completed rounds</li>";
}

async function nextRound() {
  marketSettings = { tightSupply: supply.value === "tight", scenario: scenario.value };
  round = await openMarketRound({ number: rounds.length + 1, agents, tightSupply: marketSettings.tightSupply });
  phase = 0;
  settlement = undefined;
  runner = undefined;
  element("intent-panel").open = false;
}

async function resetMarket() {
  agents = startingBalances;
  rounds = [];
  supply.value = "normal";
  scenario.value = "interrupted";
  await nextRound();
  return "Buyer agents submitted demand against their current balances.";
}

async function advanceMarket() {
  if (phase === 0) {
    if (marketSettings.tightSupply !== (supply.value === "tight") || marketSettings.scenario !== scenario.value) await nextRound();
    phase = 1;
    return "Sellers committed to their offers. Prices and capacity are sealed.";
  }
  if (phase === 1) {
    phase = 2;
    return "The SDK matched revealed offers to their commitments.";
  }
  if (phase === 2) {
    phase = 3;
    element("intents").textContent = JSON.stringify(makeIntentsPreview(round.plan), null, 2);
    return round.plan.payments.length ? "The SDK replayed the round and prepared exact buyer payments." : "The round closed without a sale.";
  }
  if (phase === 3) {
    runner = await createSimulatedSettlement(round, {
      holdFirst: marketSettings.scenario === "interrupted", lowerFirstCap: marketSettings.scenario === "approval",
    });
    settlement = await runner.run();
    phase = 4;
    if (!round.plan.payments.length) return "No transfers were needed.";
    if (settlement.summary.paid) return "All simulated receipts reconciled.";
    return marketSettings.scenario === "approval"
      ? "The buyer’s signed cap blocked all its payments. Resume to supply its revised approval."
      : "The first broadcast lost its acknowledgement. Resume to inspect the same transaction hash.";
  }
  if (!settlement.summary.paid && round.plan.payments.length) {
    settlement = await runner.run({ resume: true });
    return `Settlement reconciled ${settlement.audit.checks.length} receipts. ${settlement.prepared} transactions were prepared and ${settlement.sends} were sent.`;
  }
  const updated = displayedLedger();
  rounds.push({ number: rounds.length + 1, paid: settlement.summary.paid, total: settlement.summary.confirmed });
  agents = updated;
  await nextRound();
  return "The next round uses the agents’ updated balances and seller inventory.";
}

async function act(action) {
  if (busy) return;
  busy = true;
  for (const control of [advance, reset, supply, scenario, exportButton]) control.disabled = true;
  let message;
  try {
    message = await action();
  } catch (error) {
    console.error(error);
    message = "This market action failed. Try again or reset the market.";
  } finally {
    busy = false;
  }
  if (round) render(message);
  else element("status").textContent = message;
}

async function readEvidence() {
  const request = ++evidenceRequest;
  const target = element("chain-output");
  target.textContent = "Replaying the testnet round…";
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${evidence.value}.json`);
    if (!response.ok) throw new Error("Testnet evidence unavailable");
    const { transcript, receipts } = await response.json();
    const audit = await auditSettlement(transcript, receipts);
    if (request !== evidenceRequest) return;
    const rows = audit.plan.payments.map((payment, index) => {
      const { transactionHash } = audit.checks[index];
      const hash = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(transactionHash) ? transactionHash : "";
      const buyer = payment.buyerId.match(/^buyer-\d+/)?.[0] ?? "Buyer";
      const seller = payment.sellerId.match(/^seller-\d+/)?.[0] ?? "Seller";
      return [buyer, seller, nearAmount(payment.amount),
        hash ? `<a href="https://testnet.nearblocks.io/txns/${hash}" aria-label="View ${buyer} transaction ${hash}">${hash.slice(0, 9)}… ↗</a>` : "Unavailable"];
    });
    target.innerHTML = table("", ["Buyer", "Seller", "Testnet NEAR", "Transaction"], rows);
  } catch (error) {
    console.error(error);
    if (request === evidenceRequest) target.textContent = "The recorded receipts could not be loaded.";
  }
}

advance.addEventListener("click", () => act(advanceMarket));
reset.addEventListener("click", () => act(resetMarket));
supply.addEventListener("change", () => {
  if (phase === 0) act(async () => {
    await nextRound();
    return "Market conditions updated for this round.";
  });
});
exportButton.addEventListener("click", () => {
  const content = JSON.stringify({ mode: "simulation", transcript: round.transcript, plan: round.plan,
    receipts: settlement?.receipts ?? [], audit: settlement?.audit }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${round.plan.roundId}-audit.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
evidence.addEventListener("change", readEvidence);
void act(resetMarket);
void readEvidence();
