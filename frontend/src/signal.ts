import type { ClientMessage, ServerMessage } from './protocol';

interface SignalHandlers {
  /** هر بار که اتصال (دوباره) برقرار شد — اینجا باید auth فرستاده شود. */
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  /** اتصال قطع شد؛ اگر `willRetry` درست باشد تلاش مجدد در راه است. */
  onClose(willRetry: boolean): void;
}

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 15_000;

/** کلاینت WebSocket با اتصال مجدد خودکار و heartbeat سمت کلاینت. */
export class Signal {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPongAt = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: SignalHandlers,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'client closed');
    } catch {
      /* noop */
    }
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** بلافاصله دوباره وصل شو (مثلاً وقتی کاربر به صفحه برگشت). */
  reconnectNow(): void {
    if (this.stopped || this.connected) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempts = 0;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.lastPongAt = Date.now();
      this.startPing();
      this.handlers.onOpen();
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.lastPongAt = Date.now();
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onerror = () => {
      /* onclose بلافاصله بعد از این صدا زده می‌شود */
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      const willRetry = !this.stopped;
      this.handlers.onClose(willRetry);
      if (willRetry) this.scheduleRetry();
    };
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        // سرور دیگر جواب نمی‌دهد؛ اتصال را عمداً می‌بندیم تا چرخه‌ی retry شروع شود.
        try {
          this.ws?.close(4000, 'pong timeout');
        } catch {
          /* noop */
        }
        return;
      }
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay + Math.floor(Math.random() * 400));
  }
}
