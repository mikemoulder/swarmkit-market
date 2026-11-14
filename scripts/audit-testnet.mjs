import { readFile } from 'node:fs/promises';
import { auditSettlement, nearTestnetTransport, NATIVE_TESTNET_NEAR } from 'near-swarmkit';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: npm run testnet:audit -- <evidence.json>');
const evidence = JSON.parse(await readFile(file, 'utf8'));
if (evidence.transcript?.spec.asset !== NATIVE_TESTNET_NEAR) throw new Error('Expected native testnet evidence');
const verifier = nearTestnetTransport(async () => { throw new Error('Read-only audit cannot sign'); }, 'https://test.rpc.fastnear.com');
const report = await auditSettlement(evidence.transcript, evidence.receipts, { verifier });
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...report }, null, 2));
if (!report.verifiedSummary?.paid || !report.checks.length || report.checks.some(check => check.matches !== true)) process.exitCode = 1;
