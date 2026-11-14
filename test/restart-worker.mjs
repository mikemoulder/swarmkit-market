import { sqliteStore } from '../scripts/store.mjs';
import { marketController } from '../src/controller.mjs';
const [path, action] = process.argv.slice(2);
const store = sqliteStore(path);
const original = store.write;
if (action === 'crash') store.write = async (value, revision) => {
  const next = await original(value, revision);
  if (Object.keys(value.sent).length) process.exit(73);
  return next;
};
try {
  const controller = marketController(store);
  let view = await controller.command('create', { id: 'restart-check', scenario: 'interrupted' });
  if (action === 'crash') while (!view.settled) view = await controller.command('advance');
  else {
    // A process may have died after the broadcast persisted but before its UI receipt did.
    if (!view.interrupted && !view.settled) view = await controller.command('advance');
    if (view.interrupted) view = await controller.command('resume');
    console.log(JSON.stringify(view));
  }
} finally { store.close(); }
