import { sqliteStore } from './store.mjs';
import { marketController } from '../src/controller.mjs';

const rounds = Number(process.argv[2] ?? 12);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Choose 1–100 rounds');
const store = sqliteStore(process.argv[3] ?? '.market/experiment.sqlite');
const controller = marketController(store);
try {
  let view = await controller.command('create', { id: 'experiment', scenario: 'normal' });
  const target = view.number + rounds;
  while (view.number < target) view = await controller.command(view.interrupted ? 'resume' : 'advance');
  console.table(view.history.map(({ number, quantity, total, baseline }) => ({ round: number, units: quantity, pooled: total, solo: baseline, saving: baseline === null || !quantity ? null : baseline - total })));
  console.log(JSON.stringify({ accounting: view.accounting, prepared: view.prepared, broadcasts: view.broadcasts }, null, 2));
} finally { store.close(); }
