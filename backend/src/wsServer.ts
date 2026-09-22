import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { log } from './logger.js';
import type { Matchmaker } from './matchmaker.js';
import type { ClientMessage, Peer, ServerMessage } from './protocol.js';
import { verifyInitData } from './telegram/initData.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SocketPeer implements Peer {
  readonly connId = randomUUID();
  identity: string | null = null;
  state: Peer['state'] = 'idle';
  roomName: string | null = null;
  partner: Peer | null = null;
  lastPosition: number | null = null;
  authMode: 'telegram' | 'guest' | null = null;
  alive = true;

  private windowStart = Date.now();
  private windowCount = 0;

  constructor(private readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('ws send failed', { connId: this.connId, err: String(err) });
    }
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* noop */
    }
  }

  ping(): void {
    try {
      this.ws.ping();
    } catch {
      /* noop */
    }
  }

  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* noop */
    }
  }

  /**
   * محدودیت نرخ فقط بر اساس همین اتصال است، نه IP.
   * (همه‌ی کاربران ممکن است پشت یک VPN با IP یکسان باشند.)
   */
  allowMessage(): boolean {
    const now = Date.now();
    if (now - this.windowStart > config.ws.rateWindowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= config.ws.maxMessagesPerWindow;
  }
}

function parseMessage(raw: unknown): ClientMessage | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (Array.isArray(raw)) text = Buffer.concat(raw as Buffer[]).toString('utf8');
  else return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const t = (parsed as { type?: unknown }).type;
    if (typeof t !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

function handleAuth(peer: SocketPeer, msg: Extract<ClientMessage, { type: 'auth' }>): void {
  if (peer.identity) {
    peer.send({
      type: 'ready',
      mode: peer.authMode ?? 'guest',
      sessionId: peer.connId,
      ...(peer.authMode === 'guest' ? { guestId: peer.identity.slice('guest:'.length) } : {}),
    });
    return;
  }

  if (msg.mode === 'telegram') {
    if (config.telegram.mode === 'off' || !config.telegram.botToken) {
      peer.send({ type: 'error', code: 'auth_failed', message: 'ورود از تلگرام روی این سرور فعال نیست.' });
      return;
    }
    const result = verifyInitData(
      typeof msg.initData === 'string' ? msg.initData : '',
      config.telegram.botToken,
      config.auth.maxInitDataAgeSeconds,
    );
    if (!result.ok) {
      log.warn('telegram auth rejected', { connId: peer.connId, reason: result.reason });
      const message =
        result.reason === 'expired'
          ? 'نشست تلگرام منقضی شده است. مینی‌اپ را ببندید و دوباره باز کنید.'
          : 'احراز هویت تلگرام ناموفق بود.';
      peer.send({ type: 'error', code: 'auth_failed', message });
      return;
    }
    peer.identity = `tg:${result.user.id}`;
    peer.authMode = 'telegram';
    log.info('peer authenticated', { connId: peer.connId, mode: 'telegram' });
    peer.send({ type: 'ready', mode: 'telegram', sessionId: peer.connId });
    return;
  }

  if (msg.mode === 'guest') {
    if (!config.auth.allowGuest) {
      peer.send({ type: 'error', code: 'guest_disabled', message: 'ورود مهمان غیرفعال است؛ از داخل تلگرام وارد شوید.' });
      return;
    }
    // شناسه‌ی مهمان فقط برای پایداری هویت در همین مرورگر است.
    const supplied = typeof msg.guestId === 'string' && UUID_RE.test(msg.guestId) ? msg.guestId : null;
    const guestId = supplied ?? randomUUID();
    peer.identity = `guest:${guestId}`;
    peer.authMode = 'guest';
    log.info('peer authenticated', { connId: peer.connId, mode: 'guest' });
    peer.send({ type: 'ready', mode: 'guest', sessionId: peer.connId, guestId });
    return;
  }

  peer.send({ type: 'error', code: 'bad_message', message: 'روش احراز هویت نامعتبر است.' });
}

export interface WsHandle {
  close(): Promise<void>;
  clientCount(): number;
}

export function attachWebSocketServer(httpServer: HttpServer, matchmaker: Matchmaker): WsHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.ws.maxPayloadBytes });
  const peers = new Set<SocketPeer>();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const peer = new SocketPeer(ws);
    peers.add(peer);
    log.debug('ws connected', { connId: peer.connId, total: peers.size });

    ws.on('pong', () => {
      peer.alive = true;
    });

    ws.on('message', (raw) => {
      if (!peer.allowMessage()) {
        peer.send({ type: 'error', code: 'rate_limited', message: 'تعداد درخواست‌ها زیاد است.' });
        peer.close(1008, 'rate limited');
        return;
      }
      peer.alive = true;

      const msg = parseMessage(raw);
      if (!msg) {
        peer.send({ type: 'error', code: 'bad_message', message: 'پیام نامعتبر است.' });
        return;
      }

      try {
        switch (msg.type) {
          case 'auth':
            handleAuth(peer, msg);
            break;
          case 'join':
            matchmaker.join(peer);
            break;
          case 'next':
            matchmaker.next(peer);
            break;
          case 'cancel':
            matchmaker.cancel(peer);
            break;
          case 'leave':
            matchmaker.leave(peer);
            break;
          case 'ping':
            peer.send({ type: 'pong' });
            break;
          default:
            peer.send({ type: 'error', code: 'bad_message', message: 'نوع پیام پشتیبانی نمی‌شود.' });
        }
      } catch (err) {
        log.error('ws handler error', { connId: peer.connId, err: String(err) });
        peer.send({ type: 'error', code: 'server_error', message: 'خطای داخلی سرور.' });
      }
    });

    const cleanup = () => {
      if (!peers.delete(peer)) return;
      matchmaker.disconnect(peer);
      log.debug('ws disconnected', { connId: peer.connId, total: peers.size });
    };
    ws.on('close', cleanup);
    ws.on('error', (err) => {
      log.debug('ws error', { connId: peer.connId, err: String(err) });
      cleanup();
    });
  });

  // heartbeat: اتصال‌های مرده (مثلاً قطع ناگهانی موبایل) شناسایی و بسته می‌شوند
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        log.debug('heartbeat timeout', { connId: peer.connId });
        peer.terminate();
        continue;
      }
      peer.alive = false;
      peer.ping();
    }
  }, config.ws.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    clientCount: () => peers.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const peer of peers) peer.close(1001, 'server shutting down');
        wss.close(() => resolve());
      }),
  };
}
