import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sqliteStore } from './store.mjs';
import { marketController } from '../src/controller.mjs';
import { testnetJobs } from './testnet-jobs.mjs';

export function createMarketServer({ store, token, root = resolve('dist'), jobs = testnetJobs() }) {
  const controller = marketController(store);
  return createServer(async (req, res) => {
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (!hosts.includes(req.headers.host)) return reply(403, { error: 'Invalid host' });
    const origin = `http://${req.headers.host}`;
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: 'Cross-origin access denied' });
    const path = new URL(req.url, origin).pathname;
    try {
      if (path === '/api/session' && req.method === 'GET') {
        if (req.headers['sec-fetch-site'] !== 'same-origin') return reply(403, { error: 'Use the local operator token for CLI access' });
        return reply(200, { token });
      }
      if (path === '/api/state' && req.method === 'GET') return reply(200, await controller.read());
      if (path === '/api/testnet' && req.method === 'GET') return reply(200, await jobs.read());
      if (['/api/command', '/api/testnet'].includes(path) && req.method === 'POST') {
        const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'Operator token required' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return reply(413, { error: 'Request too large' }); }
        const { command, configuration } = JSON.parse(body);
        if (path === '/api/testnet') return reply(202, await jobs.start(configuration?.scenario));
        return reply(200, await controller.command(command, configuration));
      }
      if (path.startsWith('/api/')) return reply(404, { error: 'Unknown endpoint' });
      if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });
      const file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(resolve(root) + sep)) return reply(403, { error: 'Invalid path' });
      let data = await readFile(file);
      if (file.endsWith('.html')) data = Buffer.from(data.toString().replace('</head>', '<meta name="market-host" content="coordinator"></head>'));
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    } catch (error) { reply(error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'Build the app with npm run build first' : error.message }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = sqliteStore('.market/coordinator.sqlite');
  const token = process.env.SWARMKIT_OPERATOR_TOKEN ?? randomBytes(32).toString('hex');
  await mkdir('.market', { recursive: true });
  await writeFile('.market/operator-token', token, { mode: 0o600 });
  const server = createMarketServer({ store, token });
  const port = Number(process.env.PORT ?? 4174);
  server.listen(port, '127.0.0.1', () => console.log(`SwarmKit coordinator: http://127.0.0.1:${port} · SQLite + native testnet validation · CLI token in .market/operator-token`));
}
