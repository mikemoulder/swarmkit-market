import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Bounded local validation jobs. No caller-supplied command, account or key.
export function testnetJobs({ directory = resolve('.market/testnet-jobs'), launch = spawn } = {}) {
  let active;
  async function read() {
    if (active) return active;
    try {
      const saved = JSON.parse(await readFile(resolve(directory, 'latest.json'), 'utf8'));
      return saved.status === 'running' ? { ...saved, status: 'interrupted', message: 'Coordinator restarted. Start a fresh validation; no payment is retried automatically.' } : saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return { status: 'idle' }; }
  }
  async function start(scenario) {
    if (!['gpu', 'split'].includes(scenario)) throw new Error('Choose gpu or split');
    if (active?.status === 'running') throw new Error('A testnet validation is already running');
    active = { status: 'running', scenario, startedAt: new Date().toISOString(), message: 'Creating faucet-funded testnet accounts. This can take several minutes.' };
    await mkdir(directory, { recursive: true });
    const save = () => writeFile(resolve(directory, 'latest.json'), JSON.stringify(active));
    await save();
    const child = launch(process.execPath, [resolve('scripts/testnet.mjs'), '--faucet-testnet', `--${scenario}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output = (output + data).slice(-100000); });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', async () => { active = { ...active, status: 'failed', message: 'Could not start the validator.' }; await save(); });
    child.on('close', async code => {
      try {
        if (code !== 0) throw new Error(errors || 'Testnet validation failed');
        const result = JSON.parse(output);
        const evidencePath = resolve(result.evidence);
        if (!evidencePath.startsWith(resolve('.market/testnet') + sep)) throw new Error('Unexpected evidence location');
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
        active = { ...active, status: 'complete', message: 'Finalized payments independently checked against testnet RPC.', evidence };
      } catch (error) { active = { ...active, status: 'failed', message: error.message.slice(0, 2000) }; }
      await save();
    });
    return active;
  }
  return { read, start };
}
