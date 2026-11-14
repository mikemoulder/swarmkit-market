// Settles "your" share of a GPU co-op round on NEAR testnet, through near-swarmkit's own settlement runner.
// The journal lives in Workers KV: a payment is signed once, stored, then broadcast; a retry reads the stored
// transaction and reconciles it instead of signing again. Testnet only. $1.00 in the demo settles as
// 0.0001 testnet NEAR (1 cent = 10^18 yoctoNEAR) so the faucet-funded account lasts.
import { executeSettlement, nearTestnetTransport, NATIVE_TESTNET_NEAR } from 'near-swarmkit';
import { KeyPair, KeyPairSigner, actions, createTransaction, JsonRpcProvider } from 'near-api-js';
import { base58, base64 } from '@scure/base';

const RPC = 'https://test.rpc.fastnear.com';
const PROVIDERS = ['atlas-compute', 'meridian-cloud', 'harbor-gpu', 'summit-cloud', 'northbeam'];
const YOCTO_PER_CENT = 10n ** 18n;
const MAX_CENTS = 200_000;           // $2,000 a payment
const PER_IP_PER_HOUR = 8;
const PER_DAY = 400;

const near = yocto => { const digits = String(yocto).padStart(25, '0'), fraction = digits.slice(-24).replace(/0+$/, ''); return digits.slice(0, -24) + (fraction ? '.' + fraction : ''); };
const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...cors(origin) },
});
function cors(origin) {
  const allowed = /^https:\/\/([a-z0-9-]+\.)?swarmkit-coop\.pages\.dev$/.test(origin ?? '') || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin ?? '');
  return allowed ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
}

// A journal with read and insert-if-absent. KV is not strictly atomic; the client id and round id make
// concurrent writers for one key unlikely, and a stored entry always wins over a new candidate.
function kvJournal(kv) {
  const read = async scope => (await kv.get(`journal:${scope}`, 'json')) ?? undefined;
  return {
    read,
    async reserve(scope, candidate) {
      const existing = await read(scope);
      if (existing) return existing;
      await kv.put(`journal:${scope}`, JSON.stringify(candidate), { expirationTtl: 60 * 60 * 24 * 30 });
      return (await read(scope)) ?? candidate;
    },
  };
}

async function limit(kv, ip) {
  const hour = new Date().toISOString().slice(0, 13), day = hour.slice(0, 10);
  const ipKey = `rate:${ip}:${hour}`, dayKey = `rate:day:${day}`;
  const [ipCount, dayCount] = await Promise.all([kv.get(ipKey), kv.get(dayKey)].map(p => p.then(v => Number(v ?? 0))));
  if (ipCount >= PER_IP_PER_HOUR) return 'Too many settlements from your address this hour. Try again later.';
  if (dayCount >= PER_DAY) return 'The demo has reached its settlement limit for today.';
  await Promise.all([kv.put(ipKey, String(ipCount + 1), { expirationTtl: 7200 }), kv.put(dayKey, String(dayCount + 1), { expirationTtl: 172800 })]);
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, network: 'testnet', payer: `your-team.${env.PARENT_ACCOUNT}` }, 200, origin);
    if (url.pathname !== '/settle' || request.method !== 'POST') return json({ error: 'Not found' }, 404, origin);
    if (!env.SETTLER_KEY || !env.PARENT_ACCOUNT) return json({ error: 'Settlement is not configured yet.' }, 503, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400, origin); }
    const { clientId, roundId, payment } = body ?? {};
    if (typeof clientId !== 'string' || !/^[a-f0-9-]{16,40}$/.test(clientId)) return json({ error: 'Missing client id.' }, 400, origin);
    if (typeof roundId !== 'string' || !/^coop-week-\d{1,4}-\d{1,3}$/.test(roundId)) return json({ error: 'Unknown round.' }, 400, origin);
    const seller = String(payment?.sellerId ?? ''), cents = Number(payment?.amount);
    if (payment?.buyerId !== 'your-team' || !PROVIDERS.includes(seller)) return json({ error: 'Only your team’s share to a co-op provider can be settled.' }, 400, origin);
    if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS) return json({ error: 'Amount out of range.' }, 400, origin);

    const payer = `your-team.${env.PARENT_ACCOUNT}`, payee = `${seller}.${env.PARENT_ACCOUNT}`;
    const planRound = `coop:${clientId}:${roundId}:${seller}`;
    const amount = String(BigInt(cents) * YOCTO_PER_CENT);
    const plan = { version: 1, roundId: planRound, asset: NATIVE_TESTNET_NEAR,
      payments: [{ id: JSON.stringify([planRound, payer]), buyerId: payer, sellerId: payee, amount }] };
    const journal = kvJournal(env.SETTLE_KV);
    const scope = JSON.stringify(['near:testnet', NATIVE_TESTNET_NEAR, plan.payments[0].id]);
    const known = await journal.read(scope);
    if (!known) { const blocked = await limit(env.SETTLE_KV, request.headers.get('cf-connecting-ip') ?? 'unknown'); if (blocked) return json({ error: blocked }, 429, origin); }

    const keyPair = KeyPair.fromString(env.SETTLER_KEY);
    const signer = new KeyPairSigner(keyPair);
    const provider = new JsonRpcProvider({ url: RPC });
    const transport = nearTestnetTransport(async p => {
      const publicKey = await signer.getPublicKey();
      const access = await provider.query({ request_type: 'view_access_key', finality: 'final', account_id: p.buyerId, public_key: publicKey.toString() });
      const tx = createTransaction(p.buyerId, publicKey, p.sellerId, BigInt(access.nonce) + 1n, [actions.transfer(BigInt(p.amount))], base58.decode(access.block_hash));
      const { txHash, signedTransaction } = await signer.signTransaction(tx);
      return { hash: base58.encode(txHash), bytes: base64.encode(signedTransaction.encode()) };
    }, RPC);
    const approve = p => p.buyerId === payer && p.sellerId === payee && p.amount === amount;

    try {
      let result = await executeSettlement(plan, { transport, journal, authorize: approve });
      for (let i = 0; i < 6 && !result.summary.paid && result.summary.failed === '0'; i++) {
        await new Promise(r => setTimeout(r, 1500));
        result = await executeSettlement(plan, { transport, journal, authorize: () => false });
      }
      const receipt = result.receipts[0];
      return json({
        status: receipt?.status ?? 'pending', transactionHash: receipt?.transactionHash ?? (await journal.read(scope))?.signed?.hash,
        from: payer, to: payee, amountNear: near(amount), network: 'testnet',
      }, 200, origin);
    } catch (error) {
      return json({ error: String(error?.message ?? error).slice(0, 300) }, 502, origin);
    }
  },
};
