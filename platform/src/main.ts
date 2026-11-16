import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { postgres } from './db.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; run migrations before starting');
if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required');
const db = postgres(process.env.DATABASE_URL);
const app = buildApp(db, { origin: process.env.APP_ORIGIN, gameDir: resolve(process.env.GAME_DIR ?? '../build-web/web') });
const server = createServer(async (req, res) => {
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_100_000) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const url = new URL(req.url ?? '/', process.env.APP_ORIGIN);
    if (headers.get('host') !== new URL(process.env.APP_ORIGIN!).host) { res.writeHead(403); res.end(); return; }
    const response = await app.fetch(new Request(url, { method: req.method, headers,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks) }), req.socket.remoteAddress);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => console.log(`Player platform: ${process.env.APP_ORIGIN}`));
const shutdown = () => server.close(() => { void db.close(); });
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
