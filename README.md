# SwarmKit Market

A GPU co-op run by AI agents, built on [SwarmKit](https://github.com/mikemoulder/swarmkit), with two deeper views.

[Open the GPU co-op](https://swarmkit-coop.pages.dev/) · [Two-market economy](https://swarmkit-coop.pages.dev/economy.html) · [Recovery lab](https://swarmkit-coop.pages.dev/lab.html) · [Testnet receipts](https://swarmkit-coop.pages.dev/testnet.html) · [SDK docs](https://swarmkit.pages.dev/docs/)

**GPU co-op** (`index.html`). Twenty small AI teams send agents to a weekly co-op; you set your own team's hours and budget. The agents pool their demand, five GPU providers' agents commit sealed bids and reveal them, and `near-swarmkit` clears the pool within every team's budget, planning one payment per team and provider. The page shows each stage in order and your saving against the cheapest on-demand list price. *Settle my share* pays your share on NEAR testnet through `worker/settle.mjs`, a Cloudflare Worker running the SDK's `executeSettlement` with a Workers KV journal; a retried request returns the same transaction. Set it up with `node scripts/coop-settler-setup.mjs --faucet-testnet`, then follow the printed steps.

**Two-market economy** (`economy.html`). Nineteen agents trade across two linked markets. Four GPU sellers sell hours to four research labs and to three inference providers; the providers turn the hours they win into inference batches and sell those to eight apps. Every round in both markets is a sealed-bid `near-swarmkit` round with split fulfillment. Each agent follows its own strategy (undercutting, utilization pricing, cost-plus, premium; deadline, bargain, steady, patient buyers) and writes a one-line reason for every decision. Press *Cut GPU supply* and the shock travels: GPU prices rise, provider costs follow, inference prices rise, and price-sensitive apps are released from the round. Nothing scripts that path; it comes from the agents' decisions. When a pool cannot be filled within every buyer's cap, the coordinator releases the lowest bidder and runs the round again with the same sealed offers. Each round's SDK transcript can be downloaded and replayed.

**Recovery lab** (`lab.html`). One market run stage by stage, with editable agent policies, durable IndexedDB or SQLite checkpoints and injected failures: a lost broadcast acknowledgement, a missing reveal, a buyer approval below its spend.

**Testnet receipts** (`testnet.html`). The same settlement flow on native NEAR testnet: 22 of 22 transfers final and audited against RPC.

The live economy and the lab use simulated credits. Recorded native NEAR testnet transfers are presented separately. Real Intents settlement uses the operator CLI described below.

## Run locally

Use Node 22.18 or newer.

```sh
npm ci
npm test
npm run dev
```

For a local coordinator with SQLite persistence, run `npm run build` followed by `npm run serve` and open http://127.0.0.1:4174. Browser-only mode uses IndexedDB and Web Locks. The local service uses the same economy controller and stores checkpoints in `.market/coordinator.sqlite`. Its operator API is bound to loopback and requires a token for mutations. The ignored `.market/operator-token` file supports local CLI clients. This is not a public production service.

Run `npm run experiment -- 12` for twelve additional deterministic rounds in `.market/experiment.sqlite`, or supply a second argument for a fresh database path. Node 22.18's SQLite API is experimental.

The lockfile pins the SDK tarball in `vendor/`. It is the compiled package from the core repository. The market never imports from the core source tree. The Vite build emits a static site in `dist/`.

GitHub Pages serves the built files from the `gh-pages` branch. Run the tests and build before updating that branch.

## Follow the money

1. Inspect an agent and edit its policy before collecting demand. Each stage runs only when advanced; the round is not precomputed.
2. Run a round with the default lost-acknowledgement experiment. Refresh the page or restart the local coordinator. Recover the same payment identities from durable storage.
3. Inspect buyer/seller allocation lines, commitment hashes, charges, receipt states and the event history.
4. Open the next round. Buyers consume capacity and earn explicitly modeled work income. Sellers pay to replenish inventory and adjust quotes based on utilization.
5. Configure a supply shock, a missing reveal or a low buyer approval to inspect failure behavior. Recovery does not silently raise a real spending cap: the demo supplies a previously generated synthetic approval.

The browser uses the SDK's coordinator, replay, incremental simulation, policy checks and settlement runner. Journal entries, sent records and applied payment IDs persist. The restart test kills a child process immediately after a simulated broadcast is recorded, then recovers in a new process without duplicate signing or ledger application. Export includes public transcripts, receipt claims, decisions, history and accounting; private unrevealed offers and journal entries are excluded.

## Scenario economics

Buyer demand is limited by balance and unit-price cap. Sellers discount pools of at least 20 units by one credit, bounded by their floor. After a completed round, buyers consume stock and earn eight simulated external-work credits per unit. Sellers replenish up to 70% of nameplate capacity at one credit per unit, within their cash and inventory limits. Utilization above 85% raises the next base quote by one; below 40% lowers it by one, within scenario bounds.

The solo comparison uses the same opening inventory and buyer budgets, buying sequentially with individual quotes. It reports no savings if demand cannot be filled. This is a defined comparison, not a globally optimal solver or a promise of savings in real markets. Money and inventory identities are tested across twelve rounds, including their explicit income, cost, consumption and production terms.

## Source boundaries

- `src/linked-economy.mjs`: the two-market economy, agent strategies and the coordinator's release rule; deterministic from a seed.
- `src/live.mjs`, `src/live.css`: the live economy view.

- `src/economy.mjs`: scenario policies, incremental execution and idempotent simulated settlement.
- `src/controller.mjs`: command serialization and checkpoint persistence.
- `src/browser-store.mjs`, `scripts/store.mjs`: IndexedDB and SQLite adapters with revision checks.
- `scripts/server.mjs`: local operator API and static app host.
- `src/main.mjs`: inspectable UI; all market rules and settlement primitives come through the package.

## Validate native NEAR testnet settlement

```sh
npm run testnet -- --faucet-testnet --gpu
npm run testnet -- --faucet-testnet --split
npm run testnet:audit -- .market/testnet/<printed-account>/evidence.json
```

These commands use the installed SDK, disposable faucet-funded testnet subaccounts and actual native transfers. The GPU run provisions 20 buyers and five sellers. The split run pays two sellers from one buyer. Each exercises incremental stages with serialized checkpoints, derives payments from the closed transcript, interrupts after the first signed transaction is journaled, resumes without signing a replacement, and audits finalized receipts against RPC. Evidence includes the transcript, exact payment plan, hashes and audit result. The audit command independently rechecks the public receipts without keys or signing.

Private keys exist only in memory for this bounded validation run. It is not a restartable wallet service; an unexpected process exit before remaining transactions are signed requires a fresh validation run. Signed transaction journals stay under ignored `.market/`. Faucet availability is required. These native testnet transfers do not establish Intents execution or real resource delivery. The browser credit economy remains a separate sandbox.

## Settle through NEAR Intents

For a funded run, supply a closed SwarmKit transcript that uses actual accounts and a supported Verifier asset such as `nep141:wrap.near`. The browser's synthetic credit transcript cannot be converted into a payment by changing its asset label. Configure the relayer and per-buyer caps from [accounts.example.json](accounts.example.json). Load the referenced key variables into the process environment. Buyer keys must be recognized by the Verifier and the buyers must already hold the token there. The relayer needs NEAR for gas.

```sh
npm run intents -- round.json accounts.json --review
npm run intents -- round.json accounts.json --execute
npm run intents -- round.json accounts.json --reconcile
```

Review prints the exact plan without signing. Execute signs NEP-413 requests, preflights each transfer through the SDK adapter, and can broadcast mainnet transactions. The CLI waits for each preceding payment to finalize before sending the next. Reconcile checks existing hashes without signing or broadcasting. Keep the same relayer and `.market/intents` journal across retries. Run one operator process per relayer key.

Choose [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE).
