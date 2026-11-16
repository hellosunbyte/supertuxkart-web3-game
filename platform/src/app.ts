import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import type { Database } from './db.js';
import { ApiError, challenge, guest, session, verify, type Identity } from './auth.js';
import { appOrigin, CHAIN_ID, CHAIN, challengeInput, verifyInput, profileInput } from './config.js';
import { readSave, writeSave, SaveConflict } from './saves.js';

export function buildApp(db: Database, options: { origin: string; gameDir?: string; rateMax?: number }) {
  const origin = appOrigin(options.origin);
  const cookieName = origin.startsWith('https:') ? '__Host-stk_session' : 'stk_session';
  const cookie = (token: string, age = 7 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  const buckets = new Map<string, { count: number; until: number }>();
  type Context = { request: Request; token?: string; setCookie?: string; identity: (registered?: boolean) => Promise<Identity>; body: () => Promise<unknown> };
  const routes = new Map<string, (ctx: Context) => Promise<unknown>>();
  const route = (method: string, path: string, fn: (ctx: Context) => Promise<unknown>) => routes.set(`${method} ${path}`, fn);
  route('GET', '/api/config', async () => ({ chainId: CHAIN_ID, chain: CHAIN, wallets: ['injected-eoa'], recovery: 'pending' }));
  route('GET', '/api/session', async ctx => {
    const player = await session(db, ctx.token);
    if (!player) return { player: null };
    const wallets = (await db.query('SELECT address FROM wallets WHERE player_id = $1 ORDER BY created_at', [player.id])).rows.map(w => w.address);
    return { player: { id: player.id, kind: player.kind, displayName: player.display_name, wallets } };
  });
  route('POST', '/api/guest', async ctx => {
    if (await session(db, ctx.token)) return { ok: true };
    const result = await guest(db);
    ctx.setCookie = cookie(result.token);
    return { ok: true };
  });
  route('POST', '/api/auth/challenge', async ctx => {
    const input = challengeInput.parse(await ctx.body());
    return challenge(db, await ctx.identity(), origin, input.address, input.purpose);
  });
  route('POST', '/api/auth/verify', async ctx => {
    const input = verifyInput.parse(await ctx.body());
    const result = await verify(db, await ctx.identity(), input.id, input.signature as `0x${string}`);
    ctx.setCookie = cookie(result.token);
    return { ok: true, playerId: result.playerId };
  });
  route('POST', '/api/logout', async ctx => {
    const current = await session(db, ctx.token);
    if (current) await db.query('DELETE FROM sessions WHERE token_hash = $1', [current.tokenHash]);
    ctx.setCookie = cookie('', 0);
    return { ok: true };
  });
  route('PATCH', '/api/profile', async ctx => {
    const player = await ctx.identity(true);
    const input = profileInput.parse(await ctx.body());
    await db.query('UPDATE players SET display_name = $1 WHERE id = $2', [input.displayName, player.id]);
    return input;
  });
  route('GET', '/api/inventory', async ctx => {
    const player = await ctx.identity(true);
    return { items: (await db.query('SELECT item_id, source FROM entitlements WHERE player_id = $1 ORDER BY item_id', [player.id])).rows };
  });
  route('GET', '/api/progress', async ctx => readSave(db, (await ctx.identity(true)).id));
  route('PUT', '/api/progress', async ctx => writeSave(db, (await ctx.identity(true)).id, await ctx.body()));

  async function dispatch(request: Request, ip: string) {
    const url = new URL(request.url);
    if (url.origin !== origin) throw new ApiError(403, 'invalid_host');
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== origin) throw new ApiError(403, 'invalid_origin');
      const now = Date.now();
      for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
      const sensitive = request.method !== 'GET';
      const key = `${ip}:${sensitive ? 'write' : 'read'}`;
      const bucket = buckets.get(key) ?? { count: 0, until: now + 60_000 };
      if (buckets.size >= 10_000 && !buckets.has(key)) throw new ApiError(429, 'rate_limited');
      buckets.set(key, bucket);
      if (++bucket.count > (options.rateMax ?? (sensitive ? 30 : 120))) throw new ApiError(429, 'rate_limited');
      const action = routes.get(`${request.method} ${url.pathname}`);
      if (!action) throw new ApiError(404, 'not_found');
      const token = request.headers.get('cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const ctx: Context = { request, token,
        identity: async (registered = false) => {
          const player = await session(db, token);
          if (!player) throw new ApiError(401, 'sign_in_required');
          if (registered && player.kind !== 'registered') throw new ApiError(403, 'wallet_sign_in_required');
          return player;
        },
        body: async () => {
          if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'json_required');
          const text = await request.text();
          if (Buffer.byteLength(text) > 1_100_000) throw new ApiError(413, 'payload_too_large');
          try { return JSON.parse(text); } catch { throw new ApiError(400, 'invalid_json'); }
        },
      };
      const value = await action(ctx);
      return Response.json(value, { headers: ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {} });
    }
    if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'method_not_allowed');
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const source = fileURLToPath(new URL('../../web/', import.meta.url));
    const publicFiles = new Set(['index.html', 'game.html', 'account.js', 'progress.js', 'cloud-bridge.js']);
    let root = source;
    if (!publicFiles.has(path)) {
      if (!options.gameDir || !/^supertuxkart[.\w-]*\.(js|wasm|data)$/.test(path)) throw new ApiError(404, 'not_found');
      root = resolve(options.gameDir);
    }
    try {
      const bytes = await readFile(resolve(root, path));
      const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'Content-Type': type } });
    } catch (error: any) { if (error.code === 'ENOENT') throw new ApiError(404, 'not_found'); throw error; }
  }
  return { async fetch(request: Request, ip = 'local') {
    let response: Response;
    try { response = await dispatch(request, ip); }
    catch (error: any) {
      let status = 500, code = 'service_unavailable';
      if (error instanceof z.ZodError) { status = 400; code = 'invalid_input'; }
      else if (error instanceof ApiError) { status = error.statusCode; code = error.code; }
      else if (error.code === '23505') { status = 409; code = 'conflicting_update'; }
      else console.error('Player API failure:', error);
      response = Response.json({ error: code, ...(error instanceof SaveConflict ? { current: error.current } : {}) }, { status });
    }
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'same-origin');
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } };
}
