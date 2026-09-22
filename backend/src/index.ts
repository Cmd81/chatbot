import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { webhookCallback } from 'grammy';
import { assertRuntimeConfig, config } from './config.js';
import { log } from './logger.js';
import { Matchmaker } from './matchmaker.js';
import { attachWebSocketServer } from './wsServer.js';
import { livekitHealthy } from './livekit.js';
import { createBot, startBot } from './telegram/bot.js';

assertRuntimeConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.isAbsolute(config.staticDir)
  ? config.staticDir
  : path.resolve(here, '..', config.staticDir);

const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });
const matchmaker = new Matchmaker();
const wsHandle = attachWebSocketServer(app.server, matchmaker);

// ── سلامت سرویس ─────────────────────────────────────────────────────────────
// liveness: فقط می‌گوید پروسه بالاست (برای HEALTHCHECK داکر)
app.get('/livez', async () => ({ ok: true }));

let healthCache: { at: number; livekit: boolean } = { at: 0, livekit: false };

app.get('/healthz', async (_req, reply) => {
  const now = Date.now();
  if (now - healthCache.at > 5_000) {
    healthCache = { at: now, livekit: await livekitHealthy() };
  }
  const stats = matchmaker.stats();
  return reply.code(healthCache.livekit ? 200 : 503).send({
    ok: healthCache.livekit,
    livekit: healthCache.livekit,
    connections: wsHandle.clientCount(),
    ...stats,
    uptime: Math.round(process.uptime()),
  });
});

// پیکربندی عمومی برای فرانت (هیچ مقدار حساسی اینجا نیست)
app.get('/api/config', async () => ({
  wsPath: '/ws',
  allowGuest: config.auth.allowGuest,
  telegramEnabled: config.telegram.mode !== 'off',
}));

// ── وب‌هوک تلگرام (اختیاری) ─────────────────────────────────────────────────
const bot = createBot();
if (bot && config.telegram.mode === 'webhook') {
  app.post(
    `/telegram/webhook/${config.telegram.webhookSecret}`,
    webhookCallback(bot, 'fastify', { secretToken: config.telegram.webhookSecret }),
  );
}

// ── فایل‌های استاتیک فرانت ──────────────────────────────────────────────────
if (fs.existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, index: ['index.html'] });
  const indexFile = path.join(staticRoot, 'index.html');

  // تک‌صفحه‌ای: هر مسیر «صفحه‌مانند» به index.html می‌رسد، ولی فایل‌های نبوده
  // (مثلاً یک asset حذف‌شده) باید ۴۰۴ واقعی بدهند تا با HTML اشتباه گرفته نشوند.
  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0] ?? '/';
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (req.method === 'GET' && !pathname.startsWith('/api') && !looksLikeFile && wantsHtml && fs.existsSync(indexFile)) {
      return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexFile));
    }
    return reply.code(404).send({ error: 'not_found' });
  });
} else {
  log.warn('static dir not found; only API is served', { staticRoot });
}

// ── اجرا ────────────────────────────────────────────────────────────────────
try {
  await app.listen({ host: config.host, port: config.port });
  log.info('http server listening', { host: config.host, port: config.port, staticRoot });
} catch (err) {
  log.error('failed to listen', { err: String(err) });
  process.exit(1);
}

if (bot) void startBot(bot);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  try {
    if (bot && config.telegram.mode === 'polling') await bot.stop();
  } catch { /* noop */ }
  await wsHandle.close();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));
